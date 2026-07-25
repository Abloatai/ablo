/**
 * Fetches the initial snapshot the sync engine needs before it can go live: the
 * current rows for the requested models plus the sync position from which to
 * resume live updates. It calls the sync server's `/sync/bootstrap` HTTP
 * endpoint, retries transient failures with backoff, and can fall back to a
 * cached snapshot when the device is offline. {@link BootstrapData} is the
 * shape it returns; {@link BootstrapOptions} configures it.
 */

export interface BootstrapData {
  type: 'full' | 'partial';
  lastSyncId: number;
  /**
   * Model rows keyed by type name. Each row is opaque at this boundary; the
   * engine asserts the per-model shape against the registered schema when it
   * reduces the rows and writes them to local storage.
   */
  models?: Record<string, unknown[]>;
  deltas?: ValidatedServerDelta[];
  deltaCount?: number;
  /** Model types whose server-side query failed (timeout, RLS error, and the like). */
  failedModels?: string[];
  timestamp: number;
  /**
   * The content hash of the schema the server currently has active for this
   * tenant — the same hash `ablo push` computes. Present once a schema has been
   * pushed. The client compares it against its own `expectedSchemaHash` to warn
   * when the app's schema and the deployed schema have drifted apart.
   */
  schemaHash?: string;
  /**
   * Present when a paged single-model request stopped at its row limit with
   * rows remaining: pass it back as the next page's `cursor`. Absent on the
   * final page, on unpaged responses, and from servers that predate paging.
   */
  nextCursor?: string;
}

export interface BootstrapFetchResult {
  notModified: boolean;
  data?: BootstrapData;
  etag?: string | null;
}

export interface BootstrapOptions {
  /**
   * Full base URL of the sync server's HTTP API, **including the `/api`
   * prefix**. The bootstrap endpoint is appended as `/sync/bootstrap`, so
   * the final request hits `${baseUrl}/sync/bootstrap`.
   *
   * Example: `'http://localhost:8080/api'` → `http://localhost:8080/api/sync/bootstrap`
   *
   * Default: `'http://localhost:8080/api'`.
   */
  baseUrl?: string;
  /**
   * Namespace for the offline bootstrap cache. Most callers leave this unset;
   * the SDK fills it in once authentication has resolved the account scope, so
   * the fallback cache is partitioned per account.
   */
  cacheScope?: string | null;
  /**
   * @deprecated Use `cacheScope`. Retained so code that constructs
   * {@link BootstrapFetcher} directly keeps its cache namespace.
   */
  organizationId?: string;
  syncGroups?: string[];
  maxRetries?: number;
  retryDelay?: number;
  /**
   * How long to wait for the server to START responding (response headers), in
   * milliseconds. Default 20000 (20 seconds).
   *
   * Deliberately NOT a bound on the whole download: a cold-start snapshot can
   * be tens of megabytes, and its transfer time depends on the connection. A
   * healthy download that is actively delivering bytes is never aborted, no
   * matter how long it takes — {@link stallTimeout} guards the body instead.
   */
  fetchTimeout?: number;
  /**
   * The longest quiet gap allowed between body chunks while downloading, in
   * milliseconds. Default 15000 (15 seconds). This is the progress watchdog:
   * it aborts a download whose stream has gone silent (dead connection,
   * hung proxy) without ever penalizing a slow-but-moving transfer.
   */
  stallTimeout?: number;
  /**
   * The model names to request. When set, the server returns only these models
   * and skips the rest. This is derived from each model's `load` strategy: only
   * models loaded instantly (the default) are included. When unset, the server
   * returns every model.
   */
  instantModels?: string[];
  /**
   * Getter for the current credential, read at request time so a refreshed
   * token takes effect without recreating the helper. Preferred over
   * {@link BootstrapFetcher.setAuthToken}.
   */
  getAuthToken?: AuthTokenGetter;
  /** The owning client's runtime. Defaults to the module-global bridge. */
  runtime?: RuntimeContext;
}

import { globalRuntime } from '../context.js';
import type { RuntimeContext } from '../RuntimeContext.js';
import { AbloError, AbloSessionError, AbloConnectionError, translateHttpError, toAbloError, isRetryableCode } from '@abloatai/transaction/errors';
import { withAuthHeaders, type AuthTokenGetter } from '@abloatai/transaction/auth/credentialSource';
import {
  classifySchemaDrift,
  describeSchemaDrift,
  type ServerSchemaModel,
} from './schemaDrift.js';
// SyncObservability replaced by this.runtime.observability
import { parseBootstrapResponse, type ValidatedServerDelta } from './schemas.js';

/**
 * Rows per page for the chunked cold-start bootstrap. Matches the server's
 * hard cap on the `limit` query parameter — asking for more is silently
 * clamped, so this is the largest honest page.
 */
const PAGE_LIMIT = 5000;

/**
 * Runaway guard for the per-model paging loop: a server that keeps returning
 * a `nextCursor` past this many pages is looping, not paginating. At
 * {@link PAGE_LIMIT} rows per page this allows a million rows per model
 * before the loop is declared broken.
 */
const MAX_PAGES_PER_MODEL = 200;

/** How many model chunks a cold start fetches at once. */
const CHUNK_CONCURRENCY = 3;

/**
 * Which cancellation lane a request belongs to. Cancellation targets one lane
 * at a time, so superseding a cold-start bootstrap cannot take down a scoped
 * hydrate-on-enter running beside it: the two answer different questions and
 * neither is a substitute for the other.
 */
type CancelLane = 'bootstrap' | 'scoped';

/**
 * The reason handed to `abort()` when a request is stopped deliberately —
 * superseded by a newer bootstrap, or abandoned because the bootstrap it
 * belonged to had already failed elsewhere.
 */
const cancelled = (why: string): AbloConnectionError =>
  new AbloConnectionError(why, { code: 'bootstrap_cancelled' });

/** Matches by `name` rather than `instanceof`: an abort that crosses a worker
 *  boundary is structured-cloned, which drops the prototype. */
const isAbortError = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  'name' in value &&
  (value as { name?: unknown }).name === 'AbortError';

/**
 * What a failed request should report.
 *
 * A fetch aborted *with a reason* rejects with that exact reason object, so a
 * deliberate cancellation and a watchdog firing both arrive here already typed
 * and pass straight through — which is the whole point of passing one. Only a
 * bare abort needs translating: a signal aborted with no reason, the browser's
 * stop button, a closing tab. That case is the one that genuinely means the
 * transfer died, so it becomes a retryable timeout.
 *
 * The signal's reason is preferred over the thrown value because a pre-aborted
 * signal rejects before any request is made, and because interior code may have
 * wrapped the rejection on its way out.
 */
function classifyRequestFailure(
  error: unknown,
  controller: AbortController,
  diedMessage: string,
): Error {
  const reason: unknown = controller.signal.aborted ? controller.signal.reason : error;
  if (reason instanceof AbloError) return reason;
  if (isAbortError(reason)) {
    return new AbloConnectionError(diedMessage, {
      code: 'bootstrap_fetch_timeout',
      ...(reason instanceof Error ? { cause: reason } : {}),
    });
  }
  return error instanceof Error ? error : new Error(String(error));
}

export class BootstrapFetcher {
	  private options: Required<Omit<BootstrapOptions, 'baseUrl' | 'instantModels' | 'organizationId' | 'cacheScope' | 'getAuthToken' | 'runtime'>> & {
	    baseUrl: string;
	    instantModels?: string[];
	    cacheScope: string | null;
	    organizationId?: string;
	    authToken?: string;
	    getAuthToken?: AuthTokenGetter;
	    runtime?: RuntimeContext;
	  };

  private readonly runtime: RuntimeContext;
  /**
   * Every in-flight request's controller, tagged with the lane it belongs to. A
   * registry rather than a single field because a chunked cold start runs
   * several model fetches concurrently — aborting one request (its own
   * TTFB/stall watchdog) must never take its siblings down, while
   * {@link abort} takes down all of them.
   */
  private readonly activeControllers = new Map<AbortController, CancelLane>();
  /**
   * Non-scoped bootstraps currently running, keyed by request identity. A
   * second call for the same snapshot joins the one already in flight rather
   * than cancelling and restarting it — see {@link fetchBootstrap}.
   */
  private readonly flights = new Map<string, Promise<BootstrapData>>();
  /** Warn about schema drift at most once per helper. */
  private schemaDriftWarned = false;

  /**
   * Abort every in-flight request in `lane` — or in every lane when none is
   * given — with an explicit reason.
   *
   * The reason is load-bearing, not decoration. `fetch` rejects with the exact
   * value handed to `abort()`, so passing a typed error is what lets the retry
   * loop below tell a deliberate cancellation apart from a dead connection. A
   * bare `abort()` produces an `AbortError` indistinguishable from the one the
   * browser's stop button produces, and a retry loop that cannot tell them
   * apart re-issues the requests it just killed.
   */
  private cancelActive(reason: AbloError, lane?: CancelLane): void {
    for (const [controller, controllerLane] of this.activeControllers) {
      if (lane !== undefined && controllerLane !== lane) continue;
      controller.abort(reason);
      this.activeControllers.delete(controller);
    }
  }

  /**
   * The longest a single bootstrap can run before every watchdog below has
   * necessarily fired, derived from those watchdogs rather than guessed. A
   * caller wanting an outer deadline reads this instead of picking a number,
   * so it cannot set one shorter than the work it wraps. A cold start pages
   * through its models {@link CHUNK_CONCURRENCY} at a time; each request may
   * spend `fetchTimeout` waiting for response headers and `stallTimeout`
   * waiting for the next body chunk, and may be retried `maxRetries` times.
   */
  get budgetMs(): number {
    const models = Math.max(this.options.instantModels?.length ?? 1, 1);
    const waves = Math.ceil(models / CHUNK_CONCURRENCY);
    return (
      waves * (this.options.fetchTimeout + this.options.stallTimeout) * this.options.maxRetries
    );
  }

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  /**
   * Advisory schema-drift check: compare the server's active schema hash (on the
   * bootstrap response) against the hash this client was built with. A mismatch
   * means the app's schema and the deployed schema have diverged — reads/writes
   * relying on undeployed changes will later fail with an opaque DB constraint
   * error. Warn once, actionably; never throws or blocks the bootstrap.
   *
   * The message names the SERVER it connected to, and spans all three real
   * causes rather than assuming "you forgot to push". Drift most often means the
   * schema was pushed to a different server, project, or environment than this
   * client points at (a bare `ablo push` targets the hosted default; a local app
   * usually reads a local server) — so the first, load-bearing pointer is `ablo
   * status`, which names the exact org/project/environment the key resolves to
   * and the deployed hash, turning "which of these is it?" into one glance. The
   * older "Run `ablo push`" copy sent everyone down one path and confused the
   * common wrong-target and version-skew cases.
   */
  private warnOnSchemaDrift(serverHash: string | undefined): void {
    if (this.schemaDriftWarned || !serverHash) return;
    const clientHash = this.runtime.config.expectedSchemaHash;
    if (!clientHash || clientHash === serverHash) return;
    // A projection (`selectModels`/`omitModels`) hashes its subset, which never
    // equals the full schema a server runs — so it also carries the source
    // schema's hash. Matching that means the client is a faithful subset of the
    // deployed schema: current, not drifted. Only warn when neither matches.
    const sourceHash = this.runtime.config.expectedSourceSchemaHash;
    if (sourceHash && sourceHash === serverHash) return;
    this.schemaDriftWarned = true;
    const org = this.options.organizationId;
    const where = org ? `${this.baseUrl} (org ${org})` : this.baseUrl;

    // The whole-schema hashes differ — but that alone can't distinguish "the
    // server gained models this build never touches" (fine, say nothing) from
    // "a model this client uses moved" (name it). Resolve the semantic answer
    // from the server's per-model surface before speaking; fall back to the
    // hash message only when that surface is unavailable (older server,
    // network hiccup). Fire-and-forget: never blocks or fails the bootstrap.
    const clientModels = this.runtime.config.expectedModelHashes;
    if (clientModels && Object.keys(clientModels).length > 0) {
      void this.resolveSemanticDrift(clientModels, clientHash, serverHash, where);
      return;
    }
    this.warnWholeHashDrift(clientHash, serverHash, where);
  }

  /** Fetch the server's per-model schema surface and warn precisely — or stay
   *  silent when every model this client declares matches (additive lead). */
  private async resolveSemanticDrift(
    clientModels: Readonly<Record<string, string>>,
    clientHash: string,
    serverHash: string,
    where: string,
  ): Promise<void> {
    try {
      const res = await fetch(`${this.options.baseUrl}/schema`, {
        method: 'GET',
        headers: withAuthHeaders(this.options.getAuthToken, {}, this.options.authToken),
      });
      if (!res.ok) throw new Error(`schema read-back ${res.status}`);
      const body = (await res.json()) as { models?: unknown };
      const models = Array.isArray(body.models)
        ? body.models.flatMap((m): ServerSchemaModel[] => {
            const entry = m as { key?: unknown; hash?: unknown };
            return typeof entry.key === 'string'
              ? [{ key: entry.key, ...(typeof entry.hash === 'string' ? { hash: entry.hash } : {}) }]
              : [];
          })
        : [];
      const finding = classifySchemaDrift(clientModels, models);
      if (finding.kind === 'aligned') return; // additive server lead — not this client's concern
      if (finding.kind !== 'unknown') {
        this.runtime.logger.warn(describeSchemaDrift(finding, where), {
          clientSchemaHash: clientHash,
          serverSchemaHash: serverHash,
          serverUrl: this.baseUrl,
          ...(finding.kind === 'unpushed'
            ? { unpushedModels: finding.models }
            : { changedModels: finding.models, unpushedModels: finding.unpushed }),
        });
        return;
      }
    } catch {
      /* surface unavailable — fall through to the hash message */
    }
    this.warnWholeHashDrift(clientHash, serverHash, where);
  }

  private warnWholeHashDrift(clientHash: string, serverHash: string, where: string): void {
    const org = this.options.organizationId;
    // Self-brand the message ("Ablo:") rather than rely on the default logger's
    // `[Ablo]` namespace — consumers wiring their own logger (pino, etc.) lose
    // that prefix, and a drift warning that reads like the app's own log is
    // worse than none. The brand tells them at a glance who is talking.
    this.runtime.logger.warn(
      `Ablo: Schema drift — the schema this client was built with (${clientHash}) is not the ` +
        `one active on the server it connected to (${serverHash} at ${where}). Until they match, ` +
        `operations that depend on the difference will fail later with an opaque database error. ` +
        `This is usually one of three things. The schema may have been pushed to a different ` +
        `server, project, or environment than this client points at — run \`ablo status\` to see ` +
        `the exact org, project, and environment your key resolves to, alongside the deployed ` +
        `hash, and confirm they match here. Your local schema may simply not be pushed to this ` +
        `server yet — run \`ablo push\` against it. Or this client and the server may have been ` +
        `built with different Ablo versions, which can hash an identical schema differently — ` +
        `align the versions. This check is advisory and never blocks the connection.`,
      {
        clientSchemaHash: clientHash,
        serverSchemaHash: serverHash,
        serverUrl: this.baseUrl,
        ...(org ? { organizationId: org } : {}),
      },
    );
  }

  constructor(options: BootstrapOptions) {
    this.runtime = options.runtime ?? globalRuntime;
    // Defaults are spread first; the explicit `baseUrl` then takes precedence,
    // resolved from `options.baseUrl` or the localhost fallback. Callers pass
    // the full base URL, including the `/api` prefix.
    this.options = {
      syncGroups: [],
      maxRetries: 3,
      retryDelay: 1000,
      // Time-to-first-byte bound only. The server currently materializes the
      // whole snapshot before sending headers, so a cold start on a large org
      // legitimately needs more than a "fail fast" allowance here.
      fetchTimeout: 20_000,
      stallTimeout: 15_000,
      ...options,
      baseUrl: options.baseUrl ?? 'http://localhost:8080/api',
      // Reading the deprecated `organizationId` is deliberate: it preserves the
      // cache namespace for callers that still construct BootstrapFetcher
      // directly with the old field instead of `cacheScope`.
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      cacheScope: options.cacheScope ?? options.organizationId ?? null,
    };

    // Do not clear cache here; keep offline fallback available
  }

  /**
   * Update the offline-cache namespace once auth has resolved the server-side
   * account scope. This is intentionally not a public organizationId input.
   */
  setCacheScope(cacheScope: string): void {
    if (cacheScope.trim().length === 0) return;
    this.options.cacheScope = cacheScope;
  }

	  setSyncGroups(syncGroups: readonly string[] | undefined): void {
	    this.options.syncGroups = [...(syncGroups ?? [])];
	  }

	  /**
	   * Sets a fixed credential for callers that construct the helper directly.
	   * The SDK instead supplies `getAuthToken` and never calls this.
	   */
	  setAuthToken(authToken: string | undefined): void {
	    if (!authToken) {
	      delete this.options.authToken;
	      return;
	    }
	    this.options.authToken = authToken;
	  }

  /**
   * Fetch bootstrap data from sync engine with partial bootstrap support
   * @param lastSyncId - Optional: client's current lastSyncId for partial bootstrap
   * @returns Bootstrap data (either full snapshot or delta batch)
   */
  async fetchBootstrap(
    lastSyncId?: number,
    /**
     * A per-call set of sync groups for a scoped hydrate-on-enter. When given,
     * the request uses these groups instead of the configured `syncGroups`, and
     * does so without mutating the shared options, so a concurrent full
     * bootstrap is unaffected. It also bypasses the offline snapshot cache,
     * which holds the full bootstrap and would be a wrong answer to a subset
     * request.
     */
    syncGroupsOverride?: readonly string[],
  ): Promise<BootstrapData> {
    // A scoped hydrate answers a different question than the full bootstrap and
    // runs in its own lane: it never joins one, and is never superseded by one.
    if (syncGroupsOverride) return this.runBootstrap(lastSyncId, syncGroupsOverride);

    // Single-flight. Three callers reach this independently — first load,
    // background refresh, and reconnect — and before this they raced: each new
    // call cancelled whatever was running and started over, so a socket that
    // reconnected mid-cold-start restarted the whole snapshot, repeatedly. The
    // same request now joins the one in flight instead.
    const key = this.flightKey(lastSyncId);
    const joined = this.flights.get(key);
    if (joined) {
      this.runtime.logger.debug('Joining the bootstrap already in flight', { key });
      return joined;
    }

    // A request for something else genuinely does supersede: the running one is
    // not the answer being asked for. Retire it from the registry first, so a
    // caller arriving in the same tick cannot join a flight that is dying.
    if (this.flights.size > 0) {
      this.flights.clear();
      this.cancelActive(cancelled('Superseded by a newer bootstrap request'), 'bootstrap');
    }

    const flight = this.runBootstrap(lastSyncId);
    this.flights.set(key, flight);
    // The cleanup chain is terminated with `catch` so this derived promise can
    // never surface as an unhandled rejection even when every caller handled the
    // failure, and the delete is guarded by identity so a flight registered
    // after a supersede is not evicted by its predecessor's cleanup.
    void flight
      .catch(() => undefined)
      .finally(() => {
        if (this.flights.get(key) === flight) this.flights.delete(key);
      });
    return flight;
  }

  /**
   * The identity of a bootstrap request: everything that determines its answer.
   * Two calls with the same key are asking the same question, so the second can
   * take the first's result.
   */
  private flightKey(lastSyncId: number | undefined): string {
    return JSON.stringify({
      lastSyncId: lastSyncId !== undefined && lastSyncId > 0 ? lastSyncId : 0,
      syncGroups: [...this.options.syncGroups].sort(),
      models: [...(this.options.instantModels ?? [])].sort(),
    });
  }

  /** One bootstrap, start to finish. {@link fetchBootstrap} owns whether it runs. */
  private async runBootstrap(
    lastSyncId?: number,
    syncGroupsOverride?: readonly string[],
  ): Promise<BootstrapData> {
    // organizationId omitted — server reads it from auth identity.
    // See `fetchBootstrapWithETag` for the full rationale.
    const params = new URLSearchParams();

    // Add lastSyncId for partial bootstrap support
    if (lastSyncId !== undefined && lastSyncId > 0) {
      params.append('lastSyncId', lastSyncId.toString());
    }

    // Add sync groups (per-call override wins over the configured set).
    (syncGroupsOverride ?? this.options.syncGroups).forEach((group) => {
      params.append('syncGroups', group);
    });

    // Selective bootstrap: only request instant-strategy models.
    // When present, the server skips all other models → smaller payload.
    // When absent, server returns all models (backward compat).
    if (this.options.instantModels && this.options.instantModels.length > 0) {
      params.append('models', this.options.instantModels.join(','));
    }

    const url = `${this.options.baseUrl}/sync/bootstrap?${params.toString()}`;

    // If offline, try the cached bootstrap. Skipped for a scoped override: the
    // cache holds the full snapshot, which is not a valid answer to a subset
    // request; a scoped hydrate just soft-fails offline and retries on re-enter.
    //
    // Only an explicit `false` means offline. `navigator.onLine` is *typed*
    // `boolean`, but at runtime it is `boolean | undefined`: Node 21+ exposes a
    // global `navigator` whose `onLine` is `undefined`. Reading `!navigator.onLine`
    // would treat that `undefined` as offline and falsely short-circuit to the
    // (empty, under `persistence: 'memory'`) cache — throwing instead of fetching.
    // Capturing it at its true runtime type keeps the `=== false` honest (and lets
    // the boolean-literal-compare lint rule see the nullable it really is).
    const navigatorOnline: boolean | undefined =
      typeof navigator !== 'undefined' ? navigator.onLine : undefined;
    if (!syncGroupsOverride && navigatorOnline === false) {
      const cached = this.options.cacheScope
        ? this.loadCachedBootstrap(this.options.cacheScope)
        : null;
      if (cached) {
        this.runtime.logger.info('Using cached bootstrap (offline)');
        return cached;
      }
      throw new AbloConnectionError('Offline and no cached bootstrap available', {
        code: 'bootstrap_offline_no_cache',
      });
    }

    this.runtime.logger.info('Fetching fresh bootstrap data', { url });

    const lane: CancelLane = syncGroupsOverride ? 'scoped' : 'bootstrap';

    // Chunk a COLD start by model: each instant model is its own request, so
    // one giant model can't make the whole snapshot undeliverable, and a
    // dropped connection costs one model, not everything. Each chunk is
    // consistent at its own sync position; the merge anchors at the MINIMUM
    // position, and the regular WS catch-up (`sync_request` → delta replay)
    // closes the skew — full-row deltas make the overlapping re-apply
    // convergent. Warm partials, scoped hydrates, and clients without a
    // model list (server returns everything) stay on the single request.
    const instantModels = this.options.instantModels ?? [];
    const chunked =
      (lastSyncId === undefined || lastSyncId <= 0) &&
      !syncGroupsOverride &&
      instantModels.length > 1;

    try {
      const data = chunked
        ? await this.fetchChunkedBootstrap(instantModels, this.options.syncGroups)
        : await this.fetchWithRetries(url, lane);

      this.runtime.logger.info('Bootstrap data fetched', {
        type: data.type,
        lastSyncId: data.lastSyncId,
        chunked,
        modelCount: data.models ? Object.keys(data.models).length : 0,
        deltaCount: data.deltaCount ?? 0,
        totalItems: data.models
          ? Object.values(data.models).reduce(
              (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
              0
            )
          : 0,
      });

      // Persist for offline fallback
      if (this.options.cacheScope) {
        this.saveCachedBootstrap(this.options.cacheScope, data);
      }
      return data;
    } catch (error) {
      // Session and non-retryable errors already failed fast inside the
      // retry loop; they must ALSO skip the cached fallback (a stale
      // snapshot is not an answer to "your credential is invalid").
      if (AbloSessionError.isSessionError(error)) {
        throw error;
      }
      const ablo = toAbloError(error);
      if (ablo.code && !isRetryableCode(ablo.code)) {
        throw ablo;
      }

      // Transient failure after exhausting retries → cached fallback.
      const cached = this.options.cacheScope
        ? this.loadCachedBootstrap(this.options.cacheScope)
        : null;
      if (cached) {
        this.runtime.observability.breadcrumb('Bootstrap cache fallback', 'sync.bootstrap', 'warning', {
          error: ablo.message,
        });
        return cached;
      }
      throw ablo;
    }
  }

  /**
   * One bootstrap URL, fetched with backoff. Session errors and other
   * non-retryable failures throw immediately; only transient failures
   * (5xx, 429, timeouts, network blips) consume attempts. A cancellation is
   * deliberate and therefore non-retryable — it leaves through the same gate.
   */
  private async fetchWithRetries(url: string, lane: CancelLane): Promise<BootstrapData> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < this.options.maxRetries; attempt++) {
      try {
        return await this.fetchOnce(url, lane);
      } catch (error) {
        // SessionError should NOT be retried - the session is invalid and needs re-authentication
        if (AbloSessionError.isSessionError(error)) {
          this.runtime.observability.breadcrumb(
            'Bootstrap session error - redirecting to sign-in',
            'sync.bootstrap',
            'warning',
            {
              statusCode: (error).statusCode,
            }
          );
          throw error;
        }

        // Don't retry NON-retryable errors. A 401/403/4xx auth or client error
        // (api_key_required, jwt_issuer_untrusted, …) will NOT succeed by
        // repeating the same request with the same credential — retrying just
        // hammers the server and floods the console with doomed requests. Only
        // transient failures (5xx, 429, timeouts, network blips, or an
        // unclassified error with no code) flow through to the retry/backoff.
        const ablo = toAbloError(error);
        if (ablo.code && !isRetryableCode(ablo.code)) {
          this.runtime.observability.breadcrumb(
            'Bootstrap non-retryable error — failing fast',
            'sync.bootstrap',
            'warning',
            { code: ablo.code, httpStatus: ablo.httpStatus },
          );
          throw ablo;
        }

        lastError = error as Error;
        this.runtime.observability.breadcrumb('Bootstrap fetch failed', 'sync.bootstrap', 'warning', {
          attempt: attempt + 1,
        });

        if (attempt < this.options.maxRetries - 1) {
          await this.delay(this.options.retryDelay * Math.pow(2, attempt));
        }
      }
    }
    throw lastError
      ? toAbloError(lastError)
      : new AbloConnectionError('Failed to fetch bootstrap data', {
          code: 'bootstrap_fetch_timeout',
        });
  }

  /**
   * Cold-start bootstrap, one request per instant model with a small
   * concurrency cap. Any chunk's terminal failure fails the whole
   * bootstrap (a partial snapshot must never masquerade as a full one)
   * and cancels its siblings.
   */
  private async fetchChunkedBootstrap(
    models: readonly string[],
    syncGroups: readonly string[],
  ): Promise<BootstrapData> {
    this.runtime.logger.info('Bootstrap chunked by model', {
      models: models.length,
    });

    const queue = [...models];
    const chunks: BootstrapData[] = [];
    // Shared by the concurrent workers below, so it is deliberately re-read
    // after `await` points where a sibling may have set it. Held on an object
    // rather than in a `let`: the guard inside the worker narrows a plain
    // binding to `null` for the rest of the loop body, and the compiler has no
    // way to know a sibling can overwrite it mid-await.
    const firstFailure: { error: Error | null } = { error: null };

    const worker = async (): Promise<void> => {
      for (;;) {
        const model = queue.shift();
        if (model === undefined || firstFailure.error !== null) return;
        try {
          // Page through the model: each request is bounded to PAGE_LIMIT
          // rows, so no single response grows with the model's size. A
          // server without paging ignores `limit` and returns the whole
          // model with no nextCursor — one page, previous behavior.
          let cursor: string | undefined;
          for (let pageNo = 0; ; pageNo++) {
            if (pageNo >= MAX_PAGES_PER_MODEL) {
              throw new AbloConnectionError(
                `Bootstrap for model "${model}" exceeded ${MAX_PAGES_PER_MODEL} pages — the server keeps returning a next page`,
                { code: 'bootstrap_fetch_timeout' },
              );
            }
            const params = new URLSearchParams();
            syncGroups.forEach((group) => {
              params.append('syncGroups', group);
            });
            params.append('models', model);
            params.append('limit', String(PAGE_LIMIT));
            if (cursor !== undefined) params.append('cursor', cursor);
            const url = `${this.options.baseUrl}/sync/bootstrap?${params.toString()}`;
            const data = await this.fetchWithRetries(url, 'bootstrap');
            chunks.push(data);
            if (data.nextCursor === undefined) break;
            cursor = data.nextCursor;
          }
        } catch (error) {
          // First failure wins — a later sibling's error must not mask it.
          firstFailure.error ??=
            error instanceof Error ? error : new Error(String(error));
          // The siblings are abandoned, not broken: the snapshot they belong to
          // is already lost. Saying so in the abort reason is what keeps each
          // of them from retrying a request nobody is waiting for any more.
          this.cancelActive(
            cancelled(`Abandoned: the bootstrap chunk for "${model}" failed`),
            'bootstrap',
          );
          return;
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(CHUNK_CONCURRENCY, models.length) }, worker),
    );
    if (firstFailure.error !== null) throw firstFailure.error;
    return mergeBootstrapChunks(chunks);
  }

  /**
   * Fetch bootstrap with ETag, returning 304 hints
   */
  async fetchBootstrapWithETag(): Promise<BootstrapFetchResult> {
    // The organization id is intentionally not sent. The server resolves it
    // from the authenticated identity, so the client cannot select or spoof an
    // organization it is not scoped to.
    const params = new URLSearchParams();
    this.options.syncGroups.forEach((g) => { params.append('syncGroups', g); });
    if (this.options.instantModels && this.options.instantModels.length > 0) {
      params.append('models', this.options.instantModels.join(','));
    }
    const url = `${this.options.baseUrl}/sync/bootstrap?${params.toString()}`;

    // Note: ETag caching is deliberately app-side, not SDK-side. The server
    // still returns an ETag on responses, which is captured below and
    // forwarded to callers via BootstrapFetchResult.etag — apps that want
    // conditional revalidation (If-None-Match) implement it at their own
    // level where they own the cache-key namespace. The 304 branch below
    // remains defensively in place for when a caller enables revalidation.
	    const headers = withAuthHeaders(
	      this.options.getAuthToken,
	      { 'Content-Type': 'application/json' },
	      this.options.authToken,
	    );

    const controller = new AbortController();
    this.activeControllers.set(controller, 'bootstrap');
    try {
      return await this.fetchWithETagUsing(url, headers, controller);
    } finally {
      this.activeControllers.delete(controller);
    }
  }

  private async fetchWithETagUsing(
    url: string,
    headers: Record<string, string>,
    controller: AbortController,
  ): Promise<BootstrapFetchResult> {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    const etag = res.headers.get('ETag');

    if (res.status === 304) {
      // Log for telemetry
      this.runtime.logger.info('[Bootstrap] 304 Not Modified - using cached data');
      return { notModified: true, etag };
    }

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      // Map an empty body to undefined so the `??` below falls through to the
      // synthetic message — translateHttpError renders an empty string body as
      // an empty error message, which is useless to the caller.
      let parsed: unknown = bodyText || undefined;
      if (bodyText) {
        try {
          parsed = JSON.parse(bodyText);
        } catch {
          // Keep as string.
        }
      }
      // Translate the canonical envelope first so the server's specific code
      // and message survive (for example `api_key_required` or
      // `jwt_issuer_untrusted`).
      const translated = translateHttpError(
        res.status,
        parsed ?? `Bootstrap fetch failed: ${res.status} ${res.statusText}`,
        res.headers.get('x-request-id') ?? undefined,
      );
      // Only a genuine session or JWT expiry — or a bare auth failure carrying
      // no structured code — should drive the sign-in redirect. A specific auth
      // code like `api_key_required` is not an expired session: signing in again
      // mints the same credential and loops. Surface it as its real typed error
      // instead of a `session_expired` wrapping the stringified body.
      if (
        translated.code === 'session_expired' ||
        translated.code === 'jwt_expired' ||
        ((res.status === 401 || res.status === 403) &&
          translated.code === undefined)
      ) {
        throw new AbloSessionError(translated.message, res.status);
      }
      throw translated;
    }

    const data: BootstrapData = parseBootstrapResponse(
      await this.readJsonWithStallGuard(res, controller),
      this.runtime,
    );
    this.warnOnSchemaDrift(data.schemaHash);

    // Persist payload for offline
    try {
      if (this.options.cacheScope) {
        this.saveCachedBootstrap(this.options.cacheScope, data);
      }
    } catch {
      // Offline persistence is best-effort; a failed cache write must not
      // block returning the freshly fetched data.
    }
    this.runtime.logger.info('[Bootstrap] 200 OK - received new data');
    return { notModified: false, data, etag };
  }

  /**
   * Read a response body as a stream under a progress watchdog: the stall
   * timer re-arms on every chunk, so only a silent stream is aborted — a
   * slow-but-moving download is never killed for total duration. A cold-start
   * snapshot can be tens of megabytes; bounding its total transfer time was
   * what trapped large orgs in an endless full-bootstrap retry loop.
   *
   * Falls back to `response.json()` when the response exposes no readable
   * stream (empty bodies, some test doubles).
   */
  private async readJsonWithStallGuard(
    response: Response,
    controller: AbortController,
  ): Promise<unknown> {
    const body = response.body;
    if (!body) return response.json() as Promise<unknown>;

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;

    // The watchdog must not depend on the stream being wired to the fetch
    // signal (that plumbing is implementation-specific), so a stall races a
    // rejection against each read instead of only aborting the controller.
    let stallReject: ((error: Error) => void) | undefined;
    const stalled = new Promise<never>((_, reject) => {
      stallReject = reject;
    });
    // A stall can fire in the microtask gap between two read races; without a
    // standing handler that would surface as an unhandled rejection.
    stalled.catch(() => undefined);

    const armStallTimer = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        this.runtime.observability.breadcrumb(
          'Bootstrap download stalled',
          'sync.bootstrap',
          'warning',
          { receivedBytes, stallTimeoutMs: this.options.stallTimeout },
        );
        const stallError = new AbloConnectionError(
          `Bootstrap download stalled: no data received for ${this.options.stallTimeout}ms (${receivedBytes} bytes arrived before the stream went quiet)`,
          { code: 'bootstrap_fetch_timeout' },
        );
        stallReject?.(stallError);
        // Then tear the transfer down: abort frees the socket under real
        // fetch; cancel unblocks readers on streams not wired to the signal.
        // Both carry the same error, so whichever path wins the race below
        // reports one message rather than two descriptions of one stall.
        controller.abort(stallError);
        void reader.cancel().catch(() => undefined);
      }, this.options.stallTimeout);
    };

    try {
      armStallTimer();
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), stalled]);
        if (done) break;
        chunks.push(value);
        receivedBytes += value.byteLength;
        armStallTimer();
      }
    } catch (error) {
      throw classifyRequestFailure(
        error,
        controller,
        `Bootstrap download aborted after ${receivedBytes} bytes`,
      );
    } finally {
      clearTimeout(stallTimer);
    }

    const bytes = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  }

  /**
   * Perform one fetch. The timeout here bounds time to response headers
   * only; the body download is guarded by the stall watchdog in
   * {@link readJsonWithStallGuard}. Superseding an older in-flight
   * bootstrap is the caller's job ({@link fetchBootstrap} cancels the
   * registry) — chunk requests run through here concurrently and must
   * not cancel each other.
   */
  private async fetchOnce(url: string, lane: CancelLane): Promise<BootstrapData> {
    const controller = new AbortController();
    this.activeControllers.set(controller, lane);
    try {
      return await this.fetchOnceWith(url, controller);
    } finally {
      this.activeControllers.delete(controller);
    }
  }

  private async fetchOnceWith(url: string, controller: AbortController): Promise<BootstrapData> {
    const timeoutId = setTimeout(() => {
      this.runtime.observability.breadcrumb('Bootstrap fetch timeout', 'sync.bootstrap', 'warning', {
        timeoutMs: this.options.fetchTimeout,
      });
      controller.abort(
        new AbloConnectionError(
          `Bootstrap fetch timed out after ${this.options.fetchTimeout}ms waiting for the server to respond`,
          { code: 'bootstrap_fetch_timeout' },
        ),
      );
    }, this.options.fetchTimeout);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
	        headers: withAuthHeaders(this.options.getAuthToken, {
	          'Content-Type': 'application/json',
	          'Cache-Control': 'no-cache, no-store, must-revalidate',
	          Pragma: 'no-cache',
	        }, this.options.authToken),
        signal: controller.signal,
        cache: 'no-store', // Force browser to not cache
      });
    } catch (error) {
      clearTimeout(timeoutId);
      throw classifyRequestFailure(
        error,
        controller,
        'The bootstrap request was aborted before the server responded',
      );
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      // Map an empty body to undefined so the `??` below falls through to the
      // synthetic message (see the note on the primary fetch path).
      let parsed: unknown = bodyText || undefined;
      if (bodyText) {
        try {
          parsed = JSON.parse(bodyText);
        } catch {
          // Keep as string.
        }
      }
      // Same code-aware handling as the primary bootstrap fetch: preserve the
      // server's specific code/message; only a genuine expiry (or a bare,
      // code-less auth failure) drives the sign-in redirect.
      const translated = translateHttpError(
        response.status,
        parsed ?? `Bootstrap fetch failed: ${response.status} ${response.statusText}`,
        response.headers.get('x-request-id') ?? undefined,
      );
      if (
        translated.code === 'session_expired' ||
        translated.code === 'jwt_expired' ||
        ((response.status === 401 || response.status === 403) &&
          translated.code === undefined)
      ) {
        throw new AbloSessionError(translated.message, response.status);
      }
      throw translated;
    }

    const data = parseBootstrapResponse(await this.readJsonWithStallGuard(response, controller), this.runtime);
    this.warnOnSchemaDrift(data.schemaHash);
    // Offline caching happens in `fetchBootstrap` on the assembled result —
    // caching here would let a single-model chunk overwrite the full snapshot.
    return data;
  }

  /**
   * Fetch a single entity by ID (on-demand self-healing).
   * Returns `null` for 404 (entity deleted) — this is an expected state, not an error.
   * Throws for unexpected HTTP errors (5xx, network failures).
   */
  async fetchEntity(modelName: string, id: string): Promise<Record<string, unknown> | null> {
    const url = `${this.options.baseUrl}/sync/entity/${modelName}/${id}`;

    // Uses the same `fetchTimeout` deadline as `performFetch`. A local
    // AbortController, rather than the shared `this.abortController`, means an
    // entity self-heal never cancels a concurrent bootstrap fetch.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => { controller.abort(); }, this.options.fetchTimeout);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: withAuthHeaders(this.options.getAuthToken, {
          'Content-Type': 'application/json',
        }, this.options.authToken),
        signal: controller.signal,
      });
    } catch (error) {
      // Convert abort to the existing typed timeout error (same code as the
      // bootstrap fetch path) so callers get a retryable connection error.
      if (error instanceof Error && error.name === 'AbortError') {
        throw new AbloConnectionError(
          `Entity fetch timed out after ${this.options.fetchTimeout}ms`,
          { code: 'bootstrap_fetch_timeout', cause: error },
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      // Map an empty body to undefined so the `??` below falls through to the
      // synthetic message (see the note on the primary fetch path).
      let parsed: unknown = bodyText || undefined;
      if (bodyText) {
        try {
          parsed = JSON.parse(bodyText);
        } catch {
          // Keep as string.
        }
      }
      throw translateHttpError(
        response.status,
        parsed ?? `Entity fetch failed: ${response.status} ${response.statusText}`,
        response.headers.get('x-request-id') ?? undefined,
      );
    }

    return (await response.json()) as Record<string, unknown> | null;
  }

  // ─────────────────────────────────────────────────────────────────────
  /**
   * Clear all cached bootstrap data
   */
  clearCache(): void {
    if (typeof window === 'undefined') return;

    try {
      // Clear all bootstrap cache keys
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith('ablo:bootstrap:') || key?.includes('sync-bootstrap')) {
          keysToRemove.push(key);
        }
      }

      keysToRemove.forEach((key) => {
        localStorage.removeItem(key);
        this.runtime.logger.debug('Cleared cache key', { key });
      });
    } catch (error) {
      this.runtime.logger.debug('Failed to clear cache', { error });
    }
  }

  // Cache helpers for offline bootstrap
  private getBootstrapCacheKey(orgId: string): string {
    return `ablo:bootstrap:${orgId}`;
  }
  private saveCachedBootstrap(orgId: string, data: BootstrapData): void {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(this.getBootstrapCacheKey(orgId), JSON.stringify(data));
    } catch (e) {
      this.runtime.logger.debug('Failed to cache bootstrap payload', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  private loadCachedBootstrap(orgId: string): BootstrapData | null {
    if (typeof window === 'undefined') return null;
    try {
      const raw = localStorage.getItem(this.getBootstrapCacheKey(orgId));
      if (!raw) return null;
      return JSON.parse(raw) as BootstrapData;
    } catch {
      return null;
    }
  }

  /**
   * Abort every ongoing bootstrap request (including all chunks of a
   * chunked cold start). Entity self-heal fetches are unaffected.
   *
   * The flight registry is cleared first and synchronously, so a caller that
   * bootstraps again in the same tick starts a fresh request rather than
   * joining the one being torn down.
   */
  abort(): void {
    this.flights.clear();
    this.cancelActive(cancelled('Bootstrap aborted by its caller'));
  }

  /**
   * Helper to delay execution
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get health status of sync engine
   */
  async checkHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${this.options.baseUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
        cache: 'no-store',
      });

      if (!response.ok) return false;

      const body = (await response.json()) as { status?: unknown };
      return body.status === 'healthy';
    } catch {
      this.runtime.observability.breadcrumb('Health check failed', 'sync.bootstrap', 'warning');
      return false;
    }
  }
}

/**
 * Assemble per-model chunk responses into one full snapshot.
 *
 * Each chunk is internally consistent at its own sync position, and the
 * positions differ (the chunks were served seconds apart). Anchoring the
 * merged snapshot at the MINIMUM position turns that skew into an ordinary
 * "briefly offline client": the WS catch-up replays every delta from the
 * anchor, and since deltas carry full rows, re-applying one a later chunk
 * already reflects converges to the same state. Anchoring at anything later
 * would silently skip deltas for the earliest-fetched models.
 */
export function mergeBootstrapChunks(chunks: readonly BootstrapData[]): BootstrapData {
  const models: Record<string, unknown[]> = {};
  const failedModels: string[] = [];
  let lastSyncId = Number.POSITIVE_INFINITY;
  let timestamp = 0;
  let schemaHash: string | undefined;

  for (const chunk of chunks) {
    // Concatenate per model: pages of one model arrive as separate chunks.
    for (const [name, rows] of Object.entries(chunk.models ?? {})) {
      (models[name] ??= []).push(...rows);
    }
    if (chunk.failedModels) failedModels.push(...chunk.failedModels);
    lastSyncId = Math.min(lastSyncId, chunk.lastSyncId);
    timestamp = Math.max(timestamp, chunk.timestamp);
    schemaHash ??= chunk.schemaHash;
  }

  return {
    type: 'full',
    lastSyncId: Number.isFinite(lastSyncId) ? lastSyncId : 0,
    models,
    ...(failedModels.length > 0 ? { failedModels } : {}),
    timestamp,
    ...(schemaHash !== undefined ? { schemaHash } : {}),
  };
}
