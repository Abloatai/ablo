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
  /** How long to wait for a single fetch before timing out, in milliseconds. Default 10000 (10 seconds). */
  fetchTimeout?: number;
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
}

import { getContext } from '../context.js';
import { SyncSessionError, AbloConnectionError, translateHttpError, toAbloError, isRetryableCode } from '../errors.js';
import { withAuthHeaders, type AuthTokenGetter } from '../auth/credentialSource.js';
// SyncObservability replaced by getContext().observability
import { parseBootstrapResponse, type ValidatedServerDelta } from './schemas.js';

export class BootstrapFetcher {
	  private options: Required<Omit<BootstrapOptions, 'baseUrl' | 'instantModels' | 'organizationId' | 'cacheScope' | 'getAuthToken'>> & {
	    baseUrl: string;
	    instantModels?: string[];
	    cacheScope: string | null;
	    organizationId?: string;
	    authToken?: string;
	    getAuthToken?: AuthTokenGetter;
	  };
  private abortController: AbortController | null = null;
  /** Warn about schema drift at most once per helper. */
  private schemaDriftWarned = false;

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
    const clientHash = getContext().config.expectedSchemaHash;
    if (!clientHash || clientHash === serverHash) return;
    // A projection (`selectModels`/`omitModels`) hashes its subset, which never
    // equals the full schema a server runs — so it also carries the source
    // schema's hash. Matching that means the client is a faithful subset of the
    // deployed schema: current, not drifted. Only warn when neither matches.
    const sourceHash = getContext().config.expectedSourceSchemaHash;
    if (sourceHash && sourceHash === serverHash) return;
    this.schemaDriftWarned = true;
    const org = this.options.organizationId;
    const where = org ? `${this.baseUrl} (org ${org})` : this.baseUrl;
    // Self-brand the message ("Ablo:") rather than rely on the default logger's
    // `[Ablo]` namespace — consumers wiring their own logger (pino, etc.) lose
    // that prefix, and a drift warning that reads like the app's own log is
    // worse than none. The brand tells them at a glance who is talking.
    getContext().logger.warn(
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
    // Defaults are spread first; the explicit `baseUrl` then takes precedence,
    // resolved from `options.baseUrl` or the localhost fallback. Callers pass
    // the full base URL, including the `/api` prefix.
    this.options = {
      syncGroups: [],
      maxRetries: 3,
      retryDelay: 1000,
      fetchTimeout: 10_000, // 10 second timeout per request - fail fast for good UX
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
        getContext().logger.info('Using cached bootstrap (offline)');
        return cached;
      }
      throw new AbloConnectionError('Offline and no cached bootstrap available', {
        code: 'bootstrap_offline_no_cache',
      });
    }

    getContext().logger.info('Fetching fresh bootstrap data', { url });

    // Fetch with retries
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < this.options.maxRetries; attempt++) {
      try {
        const data = await this.performFetch(url);

        getContext().logger.info('Bootstrap data fetched', {
          type: data.type,
          lastSyncId: data.lastSyncId,
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
        // SessionError should NOT be retried - the session is invalid and needs re-authentication
        // Also do NOT fallback to cache - the user must sign in again
        if (SyncSessionError.isSessionError(error)) {
          getContext().observability.breadcrumb(
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
          getContext().observability.breadcrumb(
            'Bootstrap non-retryable error — failing fast',
            'sync.bootstrap',
            'warning',
            { code: ablo.code, httpStatus: ablo.httpStatus },
          );
          throw ablo;
        }

        lastError = error as Error;
        getContext().observability.breadcrumb('Bootstrap fetch failed', 'sync.bootstrap', 'warning', {
          attempt: attempt + 1,
        });

        if (attempt < this.options.maxRetries - 1) {
          await this.delay(this.options.retryDelay * Math.pow(2, attempt));
        }
      }
    }

    // On error, attempt cached fallback (but NOT for session errors - already handled above)
    const cached = this.options.cacheScope
      ? this.loadCachedBootstrap(this.options.cacheScope)
      : null;
    if (cached) {
      getContext().observability.breadcrumb('Bootstrap cache fallback', 'sync.bootstrap', 'warning', {
        error: lastError?.message,
      });
      return cached;
    }
    throw lastError
      ? toAbloError(lastError)
      : new AbloConnectionError('Failed to fetch bootstrap data', {
          code: 'bootstrap_fetch_timeout',
        });
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

    this.abortController = new AbortController();
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: this.abortController.signal,
    });

    const etag = res.headers.get('ETag');

    if (res.status === 304) {
      // Log for telemetry
      getContext().logger.info('[Bootstrap] 304 Not Modified - using cached data');
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
        throw new SyncSessionError(translated.message, res.status);
      }
      throw translated;
    }

    const data: BootstrapData = parseBootstrapResponse(await res.json());
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
    getContext().logger.info('[Bootstrap] 200 OK - received new data');
    return { notModified: false, data, etag };
  }

  /**
   * Perform the actual fetch request with timeout protection
   */
  private async performFetch(url: string): Promise<BootstrapData> {
    // Cancel any previous in-flight request
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();

    const timeoutId = setTimeout(() => {
      getContext().observability.breadcrumb('Bootstrap fetch timeout', 'sync.bootstrap', 'warning', {
        timeoutMs: this.options.fetchTimeout,
      });
      this.abortController?.abort();
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
        signal: this.abortController.signal,
        cache: 'no-store', // Force browser to not cache
      });
    } catch (error) {
      clearTimeout(timeoutId);
      // Convert abort to timeout error for better error messaging
      if (error instanceof Error && error.name === 'AbortError') {
        throw new AbloConnectionError(
          `Bootstrap fetch timed out after ${this.options.fetchTimeout}ms`,
          { code: 'bootstrap_fetch_timeout', cause: error },
        );
      }
      throw error;
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
        throw new SyncSessionError(translated.message, response.status);
      }
      throw translated;
    }

    const data = parseBootstrapResponse(await response.json());
    this.warnOnSchemaDrift(data.schemaHash);

    // Save a copy for offline
    try {
      if (this.options.cacheScope) {
        this.saveCachedBootstrap(this.options.cacheScope, data);
      }
    } catch {
      // Offline persistence is best-effort; a failed cache write must not
      // block returning the freshly fetched data.
    }
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
        if (key?.includes('sync-bootstrap')) {
          keysToRemove.push(key);
        }
      }

      keysToRemove.forEach((key) => {
        localStorage.removeItem(key);
        getContext().logger.debug('Cleared cache key', { key });
      });
    } catch (error) {
      getContext().logger.debug('Failed to clear cache', { error });
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
      getContext().logger.debug('Failed to cache bootstrap payload', {
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
   * Abort ongoing fetch request
   */
  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
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
      getContext().observability.breadcrumb('Health check failed', 'sync.bootstrap', 'warning');
      return false;
    }
  }
}
