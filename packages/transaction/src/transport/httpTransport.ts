/**
 * Private HTTP protocol client behind `Ablo({ schema, transport: 'http' })`.
 * It carries no object pool, local database, or WebSocket and maps Model,
 * Claim, and Commit protocol shapes directly to server routes. The typed
 * facade in `httpClient.ts` is the application boundary; this module owns
 * transport envelopes, watermarks, replay, and route details.
 */

import {
  AbloClaimedError,
  AbloError,
  AbloAuthenticationError,
  AbloConnectionError,
  AbloIdempotencyError,
  AbloValidationError,
  AbloNotFoundError,
  claimedError,
  translateHttpError,
} from '../errors.js';
import { v5 as uuidv5 } from 'uuid';
import { z } from 'zod';
import {
  reconcileFunctionalUpdate,
  type ModelUpdater,
  type FunctionalUpdateOptions,
} from '../resources/functionalUpdate.js';
import {
  assertBrowserSafety,
  readProcessEnv,
  resolveApiKey,
  resolveApiKeyValue,
  resolveAuthToken,
  resolveBaseURL,
  resolveBootstrapBaseUrl,
  rejectRemovedDatabaseUrlOption,
  warnIfCliKeyMismatch,
} from '../auth/apiKey.js';
import { PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER } from '../wire/protocolVersion.js';
import {
  commitReceiptSchema,
  commitRecordSchema,
  commitRecordListSchema,
  commitRecordListOptionsSchema,
  commitRecordWhereSchema,
  type CommitReceiptWire,
} from '../wire/commit.js';
import { logListResponseSchema } from '../wire/feedEvent.js';
import {
  claimAcquireResponseSchema,
  claimHeartbeatBatchReplySchema,
  claimHeartbeatReplySchema,
  claimListResponseSchema,
  claimStateSchema,
  type ClaimHeartbeatReply,
  type ClaimListResponse,
  type ClaimQueuedResponse,
  type ClaimRequest,
  type ClaimState,
  type ClaimTargetBody,
} from '../wire/claims.js';
import {
  modelListResponseSchema,
  modelReadResponseSchema,
} from '../wire/modelResponses.js';
import { toMs } from '../utils/duration.js';
import {
  heartbeatCadenceMs,
  resolveHeartbeatOptions,
  resolveHeartbeatPlan,
  startClaimHeartbeatLoop,
} from '../coordination/claimHeartbeatLoop.js';
import type { HttpClientConfig } from './httpOptions.js';
import type {
  ClaimedOptions,
  CommitCreateOptions,
  CommitOperationInput,
  CommitReceipt,
  CommitResource,
  CommitWait,
  HttpClaimApi,
  HttpClaimsResource,
  HttpTransportModel,
  ModelClaim,
  ModelMutationOptions,
  ModelReadOptions,
  HttpTransportRead,
  HttpLogsResource,
  ModelTarget,
  CreateSessionParams,
  AbloSession,
  SessionResource,
} from '../resources/httpResources.js';
import { mintSession } from '../auth/sessionMint.js';
import {
  revokeCapability,
  rotateCapability,
} from '../auth/capabilityLifecycle.js';
import { parseIdentityResolveResponse } from '../auth/schemas.js';
import type { EffectiveAuthority } from '../auth/capability.js';

/**
 * Interpret a heartbeat reply for a lease this handle HOLDS: anything other
 * than `held` means the lease is no longer ours (a holder cannot be `queued`;
 * `lost` rides a 409 that the wire error mapping already surfaces as
 * AbloClaimedError before reaching here). The thrown loss is the definitive
 * signal that stops the auto-heartbeat loop.
 */
function heldHeartbeatReply(reply: ClaimHeartbeatReply, label: string): ClaimHeartbeat {
  if (reply.status === 'held' && typeof reply.expiresAt === 'number') {
    return {
      expiresAt: reply.expiresAt,
      ...(reply.queueDepth !== undefined ? { queueDepth: reply.queueDepth } : {}),
    };
  }
  throw new AbloClaimedError(
    `The lease behind ${label} is no longer held — it expired or was granted onward. Re-acquire the claim and retry; a write attempted under the old lease is rejected by its \`readAt\` guard.`,
    { code: 'claim_lost' }
  );
}
import type { SchemaRecord } from '../schema/schema.js';
import type {
  ClaimLookupParams,
  ClaimOptions,
  ClaimParams,
  ClaimSkipParams,
  ClaimReorderParams,
  ModelTrackParams,
  ModelTrackResult,
  ServerReadOptions,
  ResolvedClaimContentionOptions,
  ClaimQueueView,
} from '../resources/modelOperations.js';
import {
  claimAttemptFailure,
  claimQueueView,
  emitClaimStatus,
  resolveClaimContentionOptions,
} from '../resources/modelOperations.js';
import type { Duration } from '../utils/duration.js';
import type { TrackDependency } from '../coordination/schema.js';
import { claimDescription, partName } from '../coordination/schema.js';
import type { BatchFence } from '../coordination/locator.js';
import {
  subTarget,
  streamTarget,
  batchFence,
  claimIdFor,
  fenceTokenFor,
} from '../coordination/locator.js';
import { declaredMeta, wireMeta } from '../coordination/claimMeta.js';
import type { Claim, ClaimHeartbeat, ClaimHeartbeatOptions, HeldClaim } from '../types/streams.js';
import type { CoordinationObservability } from '../observability.js';
import { assertWriteOptions } from '../resources/writeOptionsSchema.js';
import {
  createDurableHttpCommitEnvelope,
  canonicalHttpCommitBody,
  durableHttpCommitEnvelopeSchema,
  httpCommitEnvelopeRecordId,
  isHttpCommitReplayExpired,
  type DurableHttpCommitEnvelope,
  type DurableHttpCommitMethod,
} from '../transactions/confirmation/httpCommitEnvelope.js';
import type { CommitOutboxScope } from '../transactions/confirmation/commitEnvelope.js';
import { resolveDurableWrites } from '../durableWrites.js';

/** @internal Private options for the schema-agnostic HTTP protocol transport. */
export type HttpTransportOptions = Omit<HttpClientConfig, 'schema'> & {
  readonly bootstrapBaseUrl?: string | undefined;
  /** Schema-key to wire-typename mapping used only when minting agent sessions. */
  readonly modelTypenames?: Readonly<Record<string, string>> | undefined;
  /**
   * The observability provider forwarded from `Ablo({ observability })`. The HTTP
   * transport emits the same claim and conflict events as the WebSocket transport,
   * so a `ClaimLog` works identically for headless server-agent evaluations.
   */
  readonly observability?: CoordinationObservability;
  /**
   * Per-request deadline in milliseconds for the stateless HTTP transport.
   * Every request this client issues is aborted after this long and surfaces
   * as a retryable connection error — without it a black-holed server hangs
   * a headless agent forever (browsers never time fetch out on their own).
   * Pass `0` to disable the deadline.
   *
   * @default 30_000
   */
  readonly timeoutMs?: number;
};

/** @internal Default per-request deadline for the private HTTP transport. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const HTTP_CONFIRMATION_POLL_INTERVAL_MS = 250;
/**
 * The server's acquire window, mirrored here as the client-side default for a
 * claim that names no `ttl` — it sets the auto-heartbeat cadence.
 */
const DEFAULT_CLAIM_TTL_MS = 60_000;

// NOTE: end-user / agent session minting is `ablo.sessions.create(...)` (typed
// against the schema, see Ablo.ts `CreateSessionParams`). There is no separate
// `ephemeralKeys` resource — `sessions` is the one front door for both.

/** @internal Private protocol surface wrapped by `AbloHttpClient`. */
export interface HttpTransport {
  ready(): Promise<void>;
  waitForFlush(): Promise<void>;
  /** Drains scheduled commits and active requests. */
  dispose(): Promise<void>;
  purge(): Promise<void>;
  readonly commits: CommitResource;
  /**
   * Claim-ticket operations keyed by `claimId` — the id a queued acquire
   * hands back on `AbloClaimedError('claim_queued')`. See
   * {@link HttpClaimsResource}.
   */
  readonly claims: HttpClaimsResource;
  readonly logs: HttpLogsResource;
  /** Server-confirmed authority of the active bearer, populated by `ready()`. */
  readonly identity: EffectiveAuthority | null;
  model<T = Record<string, unknown>, Fields = T>(
    name: string,
  ): HttpTransportModel<T, Fields>;
  /**
   * Resolve the active bearer credential this client authenticates with — the
   * same token its own requests carry in `Authorization`. Returns `null` when
   * no credential is configured. Async because the API key may be supplied as
   * an async setter. Use it to authenticate a side-band request to the same
   * server with the credential this client already holds — no re-mint.
   */
  getAuthToken(): Promise<string | null>;
  /**
   * Mint a short-lived scoped session. Minting is a control-plane HTTP call (no
   * socket), so it lives on this stateless client too, not only the realtime one.
   * `{ user }` mints an `ek_`; `{ agent, can }` mints an `rk_`.
   */
  readonly sessions: SessionResource<SchemaRecord>;
}

type CommitResponse = CommitReceiptWire;

function parseSuccessfulCommitResponse(value: unknown, idempotencyKey: string): CommitResponse {
  const parsed = commitReceiptSchema.safeParse(value);
  if (!parsed.success || parsed.data.clientTxId !== idempotencyKey) {
    throw new AbloConnectionError(
      'The commit endpoint returned an invalid success receipt; its outcome remains pending and is safe to retry.',
      {
        code: 'commit_no_result',
        cause: parsed.success
          ? new Error('Commit receipt clientTxId did not match its idempotency key')
          : parsed.error,
      }
    );
  }
  return parsed.data;
}

/** Decode the HTTP claim DTO into the one public Claim shape. */
function claimFromModelClaim(claim: ModelClaim): Claim {
  // The handle a caller reads back is a public claim, so its `meta` is the
  // declared shape; the rest of the sub-entity locator crosses whole rather
  // than member by member, which is how `fields` used to die on this hop.
  const { meta, ...details } = subTarget(claim.target);
  return {
    object: 'claim',
    id: claim.id,
    ...(claim.status ? { status: claim.status } : {}),
    // The server always stamps a description; default only for total safety.
    description: claim.description ?? 'editing',
    heldBy: claim.actor,
    participantKind: claim.participantKind,
    expiresAt: claim.expiresAt,
    ...(claim.position !== undefined ? { position: claim.position } : {}),
    target: {
      ...streamTarget(claim.target),
      ...details,
      ...(meta !== undefined ? { meta: declaredMeta(meta) } : {}),
    },
  };
}

/** @internal Constructed only by the typed HTTP facade. */
export function createHttpTransport(options: HttpTransportOptions): HttpTransport {
  const env = readProcessEnv();
  const authInput = { options, env };
  const configuredApiKey = resolveApiKey(authInput);
  const configuredAuthToken = resolveAuthToken(authInput);
  void warnIfCliKeyMismatch(authInput);
  rejectRemovedDatabaseUrlOption(options);
  assertBrowserSafety({
    apiKey: configuredApiKey,
    dangerouslyAllowBrowser: options.dangerouslyAllowBrowser,
  });

  // Observability hook for the stateless HTTP transport. The WebSocket transport
  // emits claim and conflict events; the HTTP path (server-side agents,
  // `transport: 'http'`) emitted nothing, so a `ClaimLog` handed to a headless
  // agent evaluation stayed empty. This mirrors the two WebSocket events here:
  // claim acquired and coordination-conflict rejection. A no-op when no provider
  // is configured.
  const observability = options.observability;

  // Shared by the two HTTP write doors (`commits.create` + per-model
  // `mutateModel`): a rejected write whose code is a coordination conflict is
  // the collision ClaimLog exists to surface. Prefer the server's `conflicts`
  // detail (carried on the typed error / envelope); fall back to the rows the
  // caller tried to write so the collision always names a target. Inert without
  // a provider or for non-conflict errors. Never throws (capture is best-effort).
  const recordCoordinationConflict = (
    error: unknown,
    clientTxId: string,
    fallbackRows: readonly { model: string; id: string }[]
  ): void => {
    if (!observability) return;
    const errorRecord =
      typeof error === 'object' && error !== null
        ? (error as { code?: unknown; conflicts?: unknown })
        : undefined;
    const code = errorRecord?.code;
    const isConflict =
      code === 'stale_context' ||
      code === 'claim_conflict' ||
      code === 'entity_claimed' ||
      (typeof code === 'string' && code.startsWith('policy:'));
    if (!isConflict) return;
    const rawConflicts = errorRecord?.conflicts;
    const rows =
      Array.isArray(rawConflicts) && rawConflicts.length > 0
        ? (rawConflicts as readonly { model?: unknown; id?: unknown }[]).map((r) => ({
            model: typeof r.model === 'string' ? r.model : 'unknown',
            id: typeof r.id === 'string' ? r.id : 'unknown',
            fields: [] as string[],
          }))
        : fallbackRows.map((r) => ({ model: r.model, id: r.id, fields: [] as string[] }));
    observability.captureConflict({ clientTxId, rows });
  };

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new AbloConnectionError(
      'Ablo API client requires a fetch implementation. Pass `fetch` in Ablo({ ... }) for this runtime.',
      { code: 'fetch_unavailable' }
    );
  }

  const url = resolveBaseURL(authInput);
  const apiBaseUrl = resolveBootstrapBaseUrl({
    url,
    bootstrapBaseUrl: options.bootstrapBaseUrl,
  }).replace(/\/+$/, '');
  const durableWrites = resolveDurableWrites(options);
  // Internal replay code retains transactional-outbox terminology. The public
  // constructor exposes the behavior as `durableWrites`.
  const commitOutbox = durableWrites.store;
  const durableWriteNamespace = durableWrites.namespace ?? 'http';
  const legacyCommitOutboxScope = (options as { readonly commitOutboxScope?: CommitOutboxScope })
    .commitOutboxScope;
  const httpOutboxPlaneNamespace = canonicalHttpCommitBody({
    apiBaseUrl,
    defaultQuery: Object.entries(options.defaultQuery ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  });
  let httpOutboxScopeNamespace: string | null = null;

  let readyPromise: Promise<void> | null = null;
  let effectiveAuthority: EffectiveAuthority | null = null;
  let httpCommitLane: Promise<void> = Promise.resolve();
  let activeRequests = 0;
  let requestIdleWaiters: Array<() => void> = [];
  let disposePromise: Promise<void> | null = null;

  function requestStarted(): void {
    activeRequests += 1;
  }

  function requestFinished(): void {
    activeRequests -= 1;
    if (activeRequests !== 0) return;
    const waiters = requestIdleWaiters;
    requestIdleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function waitForRequestIdle(): Promise<void> {
    if (activeRequests === 0) return Promise.resolve();
    return new Promise((resolve) => requestIdleWaiters.push(resolve));
  }

  function runInHttpCommitLane<T>(work: () => Promise<T>): Promise<T> {
    const result = httpCommitLane.then(work);
    httpCommitLane = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async function resolveHttpOutboxScope(): Promise<string | null> {
    if (!commitOutbox) return null;
    if (httpOutboxScopeNamespace) return httpOutboxScopeNamespace;

    let scope: CommitOutboxScope | undefined = legacyCommitOutboxScope
      ? {
          ...legacyCommitOutboxScope,
          namespace: durableWriteNamespace,
        }
      : undefined;
    if (!scope) {
      const rawIdentity = await requestRaw('/auth/identity', { method: 'GET' }, true);
      const identity = parseIdentityResolveResponse(rawIdentity);
      scope = {
        organizationId: identity.accountScope,
        participantId: identity.participantId,
        namespace: durableWriteNamespace,
      };
    }
    httpOutboxScopeNamespace = canonicalHttpCommitBody({
      ...scope,
      plane: httpOutboxPlaneNamespace,
    });
    return httpOutboxScopeNamespace;
  }

  async function prepare(): Promise<void> {
    if (readyPromise) return readyPromise;

    readyPromise = (async () => {
      await resolveHttpOutboxScope();
      await replayHttpCommitOutbox();
    })();

    try {
      await readyPromise;
    } catch (error) {
      readyPromise = null;
      throw error;
    }
  }

  async function ready(): Promise<void> {
    await prepare();
    if (!effectiveAuthority) {
      const rawIdentity = await requestRaw('/auth/identity', { method: 'GET' }, true);
      effectiveAuthority = parseIdentityResolveResponse(rawIdentity).authority;
    }
  }

  async function authHeaders(sealedProtocolVersion?: number): Promise<Record<string, string>> {
    const apiKey = await resolveApiKeyValue(configuredApiKey);
    const token = apiKey ?? configuredAuthToken;
    if (!token) {
      throw new AbloAuthenticationError(
        'The HTTP client requires an API key. Pass `apiKey` or set ABLO_API_KEY.',
        { code: 'api_key_required' }
      );
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      // Protocol handshake for the HTTP transport (wire/protocolVersion.ts):
      // the server answers an out-of-range version with a typed 426.
      [PROTOCOL_VERSION_HEADER]: String(PROTOCOL_VERSION),
    };

    for (const [key, value] of Object.entries(options.defaultHeaders ?? {})) {
      if (value == null) {
        delete headers[key];
      } else {
        headers[key] = value;
      }
    }

    // A durable write owns its wire version. Force the sealed value after
    // caller defaults so a restarted (or rolled-back) SDK cannot rewrite the
    // protocol identity of a request that may already have reached the server.
    if (sealedProtocolVersion !== undefined) {
      headers[PROTOCOL_VERSION_HEADER] = String(sealedProtocolVersion);
    }

    return headers;
  }

  function endpoint(path: string): string {
    const target = new URL(`${apiBaseUrl}${path.startsWith('/') ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(options.defaultQuery ?? {})) {
      if (value !== undefined) target.searchParams.set(key, value);
    }
    return target.toString();
  }

  const requestTimeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  /**
   * Issues one request and returns its decoded body without a contract.
   *
   * Use this only where the response has no shape worth checking — a release
   * that answers `{}` — or where the caller runs a richer check of its own, as
   * the commit paths do with their receipt schema. Everywhere else, go through
   * {@link requestJson}, which will not let a response past unvalidated.
   */
  async function performRequest(
    path: string,
    init: RequestInit & {
      readonly idempotencyKey?: string | null;
      readonly sealedProtocolVersion?: number;
    },
    skipReady = false
  ): Promise<unknown> {
    if (!skipReady) await prepare();
    const { idempotencyKey, sealedProtocolVersion, ...requestInit } = init;
    const headers = await authHeaders(sealedProtocolVersion);
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    // Deadline: abort the request after `timeoutMs` so a black-holed server
    // can't hang the caller forever (fetch has NO default timeout in browsers,
    // and only undici's generous defaults in Node). A caller-supplied signal
    // is combined with the deadline via a shared controller — the portable
    // equivalent of `AbortSignal.any([caller, AbortSignal.timeout(t)])`,
    // which older runtimes (and the jsdom test env) don't implement. The
    // same pattern already guards `query/client.ts` and `BootstrapFetcher`.
    const callerSignal = requestInit.signal ?? undefined;
    const controller = new AbortController();
    const onCallerAbort = (): void => {
      controller.abort(callerSignal?.reason);
    };
    if (callerSignal) {
      if (callerSignal.aborted) onCallerAbort();
      else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
    let timedOut = false;
    const deadline =
      requestTimeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, requestTimeoutMs)
        : null;

    let res: Response;
    let bodyText: string;
    try {
      res = await fetchImpl(endpoint(path), {
        ...requestInit,
        signal: controller.signal,
        headers: {
          ...headers,
          ...(requestInit.headers as Record<string, string> | undefined),
        },
      });
      // Keep the deadline armed while the body streams — a server that sends
      // headers then stalls the body is the same hang with better manners.
      bodyText = await res.text();
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- assigned asynchronously by the deadline callback
      if (timedOut) {
        // Retryable by contract: `wait_for_timeout` is a registered transient
        // transport code, so `isRetryableCode` steers callers to retry.
        throw new AbloConnectionError(
          `The Ablo API did not respond within ${requestTimeoutMs}ms ` +
            `(${requestInit.method ?? 'GET'} ${path}). The request was aborted; ` +
            'it is safe to retry.',
          { code: 'wait_for_timeout', cause: error }
        );
      }
      throw error;
    } finally {
      if (deadline) clearTimeout(deadline);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }

    const body = parseBody(bodyText);
    if (!res.ok) {
      throw translateHttpError(
        res.status,
        body ?? `Ablo API request failed: ${res.status} ${res.statusText}`,
        res.headers.get('x-request-id') ?? undefined
      );
    }

    return body;
  }

  async function requestRaw(
    path: string,
    init: RequestInit & {
      readonly idempotencyKey?: string | null;
      readonly sealedProtocolVersion?: number;
    },
    skipReady = false
  ): Promise<unknown> {
    requestStarted();
    try {
      return await performRequest(path, init, skipReady);
    } finally {
      requestFinished();
    }
  }

  /**
   * Issues one request and validates its body against the route's schema.
   *
   * The schema is the route's response contract, declared once in `wire/` and
   * shared with the server that produces it. A body that does not match is a
   * version disagreement between the two, so it is refused whole rather than
   * read field by field and half-trusted.
   */
  async function requestJson<T>(
    path: string,
    init: RequestInit & {
      readonly idempotencyKey?: string | null;
      readonly sealedProtocolVersion?: number;
    },
    responseSchema: z.ZodType<T>,
    skipReady = false
  ): Promise<T> {
    const body = await requestRaw(path, init, skipReady);
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) {
      throw new AbloConnectionError(
        `The Ablo API returned a response for ${init.method ?? 'GET'} ${path} that this client could not read; nothing was applied.`,
        { code: 'malformed_response', cause: parsed.error }
      );
    }
    return parsed.data;
  }

  function isDefinitiveHttpRejection(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const candidate = error as { httpStatus?: unknown; status?: unknown };
    const status =
      typeof candidate.httpStatus === 'number'
        ? candidate.httpStatus
        : typeof candidate.status === 'number'
          ? candidate.status
          : undefined;
    return (
      status !== undefined &&
      status >= 400 &&
      status < 500 &&
      status !== 408 &&
      status !== 425 &&
      status !== 429
    );
  }

  async function settleHttpEnvelope(recordId: string): Promise<void> {
    if (!commitOutbox) return;
    try {
      await commitOutbox.remove(recordId);
    } catch (cause) {
      // Do not report the remote outcome until local confirmation is durable.
      // The retained record can still be replayed inside the safe window.
      throw new AbloConnectionError(
        'The server settled the commit, but its local outbox record could not be cleared.',
        { code: 'db_not_opened', cause }
      );
    }
  }

  /**
   * Persist the first queued source receipt before exposing acceptance to the
   * caller. This is a monotonic upgrade of the same sealed request: connected
   * source keys are permanent, so the envelope may safely remain replayable
   * after the hosted 24-hour idempotency window while it awaits its WAL echo.
   */
  async function persistHttpAcceptance(
    envelope: DurableHttpCommitEnvelope,
    response: CommitResponse
  ): Promise<DurableHttpCommitEnvelope> {
    if (!commitOutbox || response.status !== 'queued') return envelope;
    const correlationId = response.correlationId;
    if (!correlationId) {
      throw new AbloConnectionError(
        'The source accepted the commit without durable correlation evidence.',
        { code: 'commit_no_result' }
      );
    }
    if (envelope.correlationId !== undefined && envelope.correlationId !== correlationId) {
      throw new AbloIdempotencyError(
        'The same HTTP commit replay returned a different source correlation.',
        { code: 'idempotency_conflict' }
      );
    }
    if (envelope.acceptedAt !== undefined) return envelope;
    const accepted = durableHttpCommitEnvelopeSchema.parse({
      ...envelope,
      acceptedAt: Date.now(),
      correlationId,
    });
    try {
      await commitOutbox.seal(accepted, []);
    } catch (cause) {
      throw new AbloConnectionError(
        'The source accepted the commit, but that acceptance could not be persisted locally.',
        { code: 'db_not_opened', cause }
      );
    }
    return accepted;
  }

  interface ReplayedHttpCommit {
    readonly envelope: DurableHttpCommitEnvelope;
    readonly response: CommitResponse;
  }

  interface ExactHttpCommitRequest {
    readonly idempotencyKey: string;
    readonly method: DurableHttpCommitMethod;
    readonly path: string;
    readonly body: string;
    readonly sealedProtocolVersion?: number;
  }

  function observeCommitReceipt(
    request: ExactHttpCommitRequest,
    receipt: CommitResponse,
  ): void {
    // A successful receipt carries the same server-authored authority as the
    // identity exchange. Reuse it so startup replay does not add a redundant
    // auth request before callers can inspect `identity`.
    effectiveAuthority = receipt.authority;
    if (!options.onCommitReceipt) return;
    let body: unknown = request.body;
    try {
      body = JSON.parse(request.body) as unknown;
    } catch {
      // Preserve the exact opaque body for observability if it is not JSON.
    }
    try {
      options.onCommitReceipt({
        receipt,
        method: request.method,
        path: request.path,
        body,
      });
    } catch {
      // Receipt observation must never change the commit outcome.
    }
  }

  function replicationLagTimeout(
    request: ExactHttpCommitRequest,
    response: CommitResponse
  ): AbloConnectionError {
    return new AbloConnectionError(
      `The source accepted commit ${request.idempotencyKey}, but its replication echo did not arrive within ${requestTimeoutMs}ms.`,
      {
        code: 'replication_lag_timeout',
        httpStatus: 504,
        details: {
          clientTxId: request.idempotencyKey,
          ...(response.correlationId ? { correlationId: response.correlationId } : {}),
          timeoutMs: requestTimeoutMs,
          accepted: true,
        },
      }
    );
  }

  /**
   * Replays one byte-identical, idempotent HTTP commit until mutation-log
   * replay reports the source echo as confirmed. `queued` is acceptance only:
   * this loop never clears the durable envelope and never converts it into a
   * successful `wait: 'confirmed'` result.
   */
  async function pollHttpCommitConfirmation(
    request: ExactHttpCommitRequest,
    initial: CommitResponse
  ): Promise<CommitResponse> {
    let current = initial;
    const operationResults = initial.operationResults;
    const withOperationResults = (receipt: CommitResponse): CommitResponse =>
      operationResults?.length
        ? { ...receipt, operationResults }
        : receipt;
    const correlationId = initial.correlationId;
    const deadlineAt = requestTimeoutMs > 0 ? Date.now() + requestTimeoutMs : null;

    while (current.status === 'queued') {
      const remaining = deadlineAt === null ? null : deadlineAt - Date.now();
      if (remaining !== null && remaining <= 0) {
        throw replicationLagTimeout(request, current);
      }

      const confirmationController = new AbortController();
      const confirmationDeadline =
        remaining !== null
          ? setTimeout(() => {
              confirmationController.abort();
            }, remaining)
          : null;
      try {
        const raw = await requestRaw(
          request.path,
          {
            method: request.method,
            idempotencyKey: request.idempotencyKey,
            ...(request.sealedProtocolVersion !== undefined
              ? { sealedProtocolVersion: request.sealedProtocolVersion }
              : {}),
            body: request.body,
            signal: confirmationController.signal,
          },
          true
        );
        const next = parseSuccessfulCommitResponse(raw, request.idempotencyKey);
        observeCommitReceipt(request, next);
        if (next.correlationId !== correlationId) {
          throw new AbloIdempotencyError(
            'The same HTTP commit replay returned different source correlation evidence.',
            { code: 'idempotency_conflict' }
          );
        }
        current = next;
      } catch (error) {
        if (
          confirmationController.signal.aborted ||
          (deadlineAt !== null && Date.now() >= deadlineAt)
        ) {
          throw replicationLagTimeout(request, current);
        }
        throw error;
      } finally {
        if (confirmationDeadline) clearTimeout(confirmationDeadline);
      }

      if (current.status === 'confirmed') return withOperationResults(current);
      const delayMs =
        deadlineAt === null
          ? HTTP_CONFIRMATION_POLL_INTERVAL_MS
          : Math.min(HTTP_CONFIRMATION_POLL_INTERVAL_MS, Math.max(0, deadlineAt - Date.now()));
      if (delayMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs);
        });
      }
    }
    return withOperationResults(current);
  }

  async function replayHttpCommitOutbox(): Promise<Map<string, ReplayedHttpCommit>> {
    const replayed = new Map<string, ReplayedHttpCommit>();
    if (!commitOutbox) return replayed;
    const scopeNamespace = await resolveHttpOutboxScope();
    if (!scopeNamespace) return replayed;
    const rows = await commitOutbox.list();
    const envelopes: DurableHttpCommitEnvelope[] = [];
    for (const row of rows) {
      if (
        typeof row !== 'object' ||
        row === null ||
        (row as { type?: unknown }).type !== 'http_commit_envelope'
      )
        continue;
      const parsed = durableHttpCommitEnvelopeSchema.safeParse(row);
      if (!parsed.success) {
        throw new AbloValidationError(
          'A saved HTTP write is unreadable; replay stopped before any newer write was sent.',
          { code: 'write_options_invalid', cause: parsed.error }
        );
      }
      if (parsed.data.scopeNamespace !== scopeNamespace) continue;
      if (isHttpCommitReplayExpired(parsed.data)) {
        throw new AbloIdempotencyError(
          'A saved HTTP write is older than the server idempotency window and cannot be replayed safely.',
          { code: 'idempotency_conflict' }
        );
      }
      envelopes.push(parsed.data);
    }
    envelopes.sort(
      (a, b) =>
        (a.sequence ?? a.sealedAt * 1_000) - (b.sequence ?? b.sealedAt * 1_000) ||
        a.id.localeCompare(b.id)
    );
    for (const envelope of envelopes) {
      try {
        const raw = await requestRaw(
          envelope.request.path,
          {
            method: envelope.request.method,
            idempotencyKey: envelope.idempotencyKey,
            sealedProtocolVersion: envelope.protocolVersion,
            body: envelope.request.body,
          },
          true
        );
        const response = parseSuccessfulCommitResponse(raw, envelope.idempotencyKey);
        observeCommitReceipt(
          {
            idempotencyKey: envelope.idempotencyKey,
            method: envelope.request.method,
            path: envelope.request.path,
            body: envelope.request.body,
            sealedProtocolVersion: envelope.protocolVersion,
          },
          response,
        );
        if (
          envelope.correlationId !== undefined &&
          response.correlationId !== envelope.correlationId
        ) {
          throw new AbloIdempotencyError(
            'The saved HTTP commit replay returned different source correlation evidence.',
            { code: 'idempotency_conflict' }
          );
        }
        const replayEnvelope = await persistHttpAcceptance(envelope, response);
        // A queued source receipt is only acceptance. Keep the exact request
        // durable so startup/retry can ask mutation-log replay whether its WAL
        // echo has materialized; only confirmed is a definitive success.
        if (response.status === 'confirmed') {
          await settleHttpEnvelope(envelope.id);
        }
        replayed.set(envelope.idempotencyKey, {
          envelope: replayEnvelope,
          response,
        });
      } catch (error) {
        if (isDefinitiveHttpRejection(error)) {
          await settleHttpEnvelope(envelope.id);
        }
        throw error;
      }
    }
    return replayed;
  }

  /**
   * A flush is stronger than startup replay: it promises that every retained
   * envelope has reached a definitive outcome, not merely that the server
   * accepted it for forwarding. Poll queued receipts through mutation-log
   * replay and leave their envelopes intact if the confirmation deadline
   * expires.
   */
  async function confirmReplayedHttpCommits(
    replayed: ReadonlyMap<string, ReplayedHttpCommit>
  ): Promise<void> {
    for (const { envelope, response } of replayed.values()) {
      if (response.status !== 'queued') continue;
      try {
        const confirmed = await pollHttpCommitConfirmation(
          {
            idempotencyKey: envelope.idempotencyKey,
            method: envelope.request.method,
            path: envelope.request.path,
            body: envelope.request.body,
            sealedProtocolVersion: envelope.protocolVersion,
          },
          response
        );
        if (confirmed.status === 'confirmed') {
          await settleHttpEnvelope(envelope.id);
        }
      } catch (error) {
        if (isDefinitiveHttpRejection(error)) {
          await settleHttpEnvelope(envelope.id);
        }
        throw error;
      }
    }
  }

  let lastHttpCommitSequence = 0;
  function nextHttpCommitSequence(): number {
    const wallSequence = Date.now() * 1_000;
    lastHttpCommitSequence = Math.max(wallSequence, lastHttpCommitSequence + 1);
    return lastHttpCommitSequence;
  }

  async function sealHttpCommit(input: {
    idempotencyKey: string;
    method: DurableHttpCommitMethod;
    path: string;
    body: unknown;
  }): Promise<DurableHttpCommitEnvelope | null> {
    if (!commitOutbox) return null;
    const scopeNamespace = await resolveHttpOutboxScope();
    if (!scopeNamespace) {
      throw new AbloValidationError('HTTP durable-write scope was not resolved', {
        code: 'write_options_invalid',
      });
    }
    const recordId = httpCommitEnvelopeRecordId(input.idempotencyKey, scopeNamespace);
    const legacyRecordId = httpCommitEnvelopeRecordId(input.idempotencyKey);
    const existingRows = await commitOutbox.list();
    const existingRaw = existingRows.find(
      (row) =>
        typeof row === 'object' &&
        row !== null &&
        ((row as { id?: unknown }).id === recordId ||
          (row as { id?: unknown }).id === legacyRecordId)
    );
    const serializedBody = canonicalHttpCommitBody(input.body);
    if (existingRaw !== undefined) {
      const existing = durableHttpCommitEnvelopeSchema.parse(existingRaw);
      if (isHttpCommitReplayExpired(existing)) {
        throw new AbloIdempotencyError(
          'This saved HTTP write is older than the server idempotency window and cannot be retried safely.',
          { code: 'idempotency_conflict' }
        );
      }
      if (
        existing.scopeNamespace !== scopeNamespace ||
        existing.request.method !== input.method ||
        existing.request.path !== input.path ||
        existing.request.body !== serializedBody
      ) {
        throw new AbloIdempotencyError(
          'Idempotency key reused with a different HTTP commit request',
          { code: 'idempotency_conflict' }
        );
      }
      return existing;
    }
    const envelope = createDurableHttpCommitEnvelope({
      idempotencyKey: input.idempotencyKey,
      request: { method: input.method, path: input.path, body: input.body },
      scopeNamespace,
      sequence: nextHttpCommitSequence(),
    });
    await commitOutbox.seal(envelope, []);
    return envelope;
  }

  async function dispatchHttpCommit(
    input: {
      idempotencyKey: string;
      method: DurableHttpCommitMethod;
      path: string;
      body: unknown;
      wait: CommitWait;
    },
    beforeConfirmation?: (response: CommitResponse) => Promise<void>
  ): Promise<CommitResponse> {
    return runInHttpCommitLane(async () => {
      await prepare();
      // Startup preparation covers replay. Re-draining here makes every later write wait
      // behind an ambiguous predecessor from this same process.
      const replayed = await replayHttpCommitOutbox();
      const prior = replayed.get(input.idempotencyKey);
      if (prior) {
        const serializedBody = canonicalHttpCommitBody(input.body);
        if (
          prior.envelope.request.method !== input.method ||
          prior.envelope.request.path !== input.path ||
          prior.envelope.request.body !== serializedBody
        ) {
          throw new AbloIdempotencyError(
            'Idempotency key reused with a different HTTP commit request',
            { code: 'idempotency_conflict' }
          );
        }
        let priorResponse = prior.response;
        if (priorResponse.status === 'queued' && input.wait === 'confirmed') {
          try {
            priorResponse = await pollHttpCommitConfirmation(
              {
                idempotencyKey: prior.envelope.idempotencyKey,
                method: prior.envelope.request.method,
                path: prior.envelope.request.path,
                body: prior.envelope.request.body,
                sealedProtocolVersion: prior.envelope.protocolVersion,
              },
              priorResponse
            );
          } catch (error) {
            if (isDefinitiveHttpRejection(error)) {
              await settleHttpEnvelope(prior.envelope.id);
            }
            throw error;
          }
        }
        if (priorResponse.status === 'confirmed') {
          await beforeConfirmation?.(priorResponse);
          await settleHttpEnvelope(prior.envelope.id);
        }
        return priorResponse;
      }
      const durableEnvelope = await sealHttpCommit(input);
      const requestBody = durableEnvelope?.request.body ?? canonicalHttpCommitBody(input.body);
      const exactRequest: ExactHttpCommitRequest = {
        idempotencyKey: input.idempotencyKey,
        method: input.method,
        path: input.path,
        body: requestBody,
        ...(durableEnvelope ? { sealedProtocolVersion: durableEnvelope.protocolVersion } : {}),
      };

      let response: CommitResponse;
      try {
        const raw = await requestRaw(
          exactRequest.path,
          {
            method: exactRequest.method,
            idempotencyKey: exactRequest.idempotencyKey,
            ...(exactRequest.sealedProtocolVersion !== undefined
              ? { sealedProtocolVersion: exactRequest.sealedProtocolVersion }
              : {}),
            body: exactRequest.body,
          },
          true
        );
        response = parseSuccessfulCommitResponse(raw, input.idempotencyKey);
        observeCommitReceipt(exactRequest, response);
        if (durableEnvelope && response.status === 'queued') {
          await persistHttpAcceptance(durableEnvelope, response);
        }
        if (response.status === 'queued' && input.wait === 'confirmed') {
          response = await pollHttpCommitConfirmation(exactRequest, response);
        }
      } catch (error) {
        if (durableEnvelope && isDefinitiveHttpRejection(error)) {
          await settleHttpEnvelope(durableEnvelope.id);
        }
        throw error;
      }

      // A model-create readback can participate in confirmation: if it fails,
      // retain the exact write so a same-key retry recovers the generated id.
      // A queued source receipt cannot be read back from the log yet and stays
      // durable until a later confirmed replay.
      if (response.status === 'confirmed') {
        await beforeConfirmation?.(response);
        if (durableEnvelope) await settleHttpEnvelope(durableEnvelope.id);
      }
      return response;
    });
  }

  function createClientTxId(idempotencyKey?: string | null): string {
    if (idempotencyKey && idempotencyKey.length > 0) return idempotencyKey;
    return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `tx_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function createModelId(modelName: string, idempotencyKey?: string | null): string {
    if (idempotencyKey) {
      return uuidv5(`${modelName}:${idempotencyKey}`, 'aa4ba6d4-bf0b-5b38-9c45-116f79a6e548');
    }
    return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `id_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function normalizeCommitOperation(
    op: CommitOperationInput,
    defaults: Pick<CommitCreateOptions, 'readAt' | 'onStale'>,
    fence: BatchFence | null,
    claim: Claim | null,
  ): CommitOperationInput {
    return {
      action: op.action,
      model: op.model,
      id: op.id ?? null,
      data: op.data ?? null,
      where: op.where ?? null,
      transactionId: op.transactionId ?? null,
      claimId:
        op.claimId ?? claimIdFor(claim?.target, claim?.id, op.model, op.id ?? null),
      readAt: op.readAt ?? defaults.readAt ?? null,
      onStale: op.onStale ?? defaults.onStale ?? null,
      fenceToken: op.fenceToken ?? fenceTokenFor(fence, op.model, op.id ?? null),
    };
  }

  function normalizeCommitOperations(
    commitOptions: CommitCreateOptions,
    fence: BatchFence | null
  ): readonly CommitOperationInput[] {
    if (commitOptions.operations.length === 0) {
      throw new AbloValidationError('Commit requires a non-empty `operations` array.', {
        code: 'commit_operation_required',
      });
    }
    return commitOptions.operations.map((op) =>
      normalizeCommitOperation(op, commitOptions, fence, commitOptions.claim ?? null)
    );
  }

  async function listClaimState(
    target?: Partial<ModelTarget>
  ): Promise<{ active: readonly ModelClaim[]; queue: readonly ModelClaim[] }> {
    const params = new URLSearchParams();
    if (target?.model) params.set('model', target.model);
    if (target?.id) params.set('id', target.id);
    if (target?.field) params.set('field', target.field);

    const suffix = params.toString();
    const body = await requestJson(
      `/v1/claims${suffix ? `?${suffix}` : ''}`,
      { method: 'GET' },
      claimListResponseSchema
    );
    // One list, one resource in two states: holders and waiters are told
    // apart by each entry's `status`, not by bespoke envelope members.
    return {
      active: body.data.filter((row) => row.status !== 'queued'),
      queue: body.data.filter((row) => row.status === 'queued'),
    };
  }

  // The claim-ticket surface: everything a caller does holding only a
  // `claimId` — which is all a queued acquire leaves in its hand. Each method
  // is a thin cast of its route; the reply schemas are the wire's own, so the
  // surface cannot describe a response the server does not send.
  const claims: HttpClaimsResource = {
    retrieve({ claimId }): Promise<ClaimState> {
      return requestJson(
        `/v1/claims/${encodeURIComponent(claimId)}`,
        { method: 'GET' },
        claimStateSchema
      );
    },
    heartbeat({ claimId, ttl }): Promise<ClaimHeartbeatReply> {
      return requestJson(
        `/v1/claims/${encodeURIComponent(claimId)}/heartbeat`,
        {
          method: 'POST',
          body: JSON.stringify(ttl !== undefined ? { ttl } : {}),
        },
        claimHeartbeatReplySchema
      );
    },
    async heartbeatAll(options) {
      const reply = await requestJson(
        '/v1/claims/heartbeat',
        {
          method: 'POST',
          body: JSON.stringify(options?.ttl !== undefined ? { ttl: options.ttl } : {}),
        },
        claimHeartbeatBatchReplySchema
      );
      return reply.results;
    },
    async release({ claimId }) {
      await requestRaw(`/v1/claims/${encodeURIComponent(claimId)}`, {
        method: 'DELETE',
      });
    },
  };

  // How the stateless client waits its turn. The queued slot is real server
  // state, so one heartbeat per tick does both jobs: it refreshes this
  // waiter's slot and reports the line's answer — `queued` (still waiting) or
  // `held` (granted). The first check comes quickly because most holds are a
  // short claim→write→release; after that the cadence relaxes, with jitter so
  // a fleet of waiters doesn't beat in step.
  const GRANT_POLL_FIRST_MS = 250;
  const GRANT_POLL_INTERVAL_MS = 1_000;
  // An abort cuts the sleep short so the wait ends within a tick of the
  // signal, not at the next scheduled beat.
  const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener('abort', done, { once: true });
    });

  async function awaitGrantOverHttp(
    targetLabel: string,
    queued: ClaimQueuedResponse,
    options: ResolvedClaimContentionOptions,
  ): Promise<{ id: string; fenceToken?: number }> {
    // The queued reply is a claim resource in its waiting state, so the
    // handle is its `id` — same rule as the 201 and the poll.
    const claimId = queued.id;
    const { signal } = options;
    // Leave the line before rejecting: an abandoned slot would otherwise sit
    // in the queue until its TTL lapses, stalling every waiter behind it.
    const rejectAndLeave = async (error: AbloClaimedError): Promise<never> => {
      await claims.release({ claimId }).catch(() => {});
      throw error;
    };

    emitClaimStatus(options.onStatus, {
      type: 'queued',
      claimId,
      position: queued.position,
      ahead: queued.position + 1,
    });

    if (options.maxDepth !== undefined && queued.position >= options.maxDepth) {
      return rejectAndLeave(
        new AbloClaimedError(
          `Claim queue for ${targetLabel} is ${queued.position} deep (max ${options.maxDepth}).`,
          { code: 'queue_too_deep' }
        )
      );
    }

    const deadline =
      options.timeoutMs !== undefined ? Date.now() + options.timeoutMs : undefined;
    let delay = GRANT_POLL_FIRST_MS;
    for (;;) {
      if (signal?.aborted) {
        return rejectAndLeave(
          new AbloClaimedError(
            `The wait for the claim on ${targetLabel} was aborted before the grant arrived.`,
            { code: 'claim_wait_aborted' }
          )
        );
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        return rejectAndLeave(
          new AbloClaimedError(
            `Timed out after ${options.timeoutMs}ms waiting for the queue grant on ${targetLabel}.`,
            { code: 'grant_timeout' }
          )
        );
      }
      await sleep(
        deadline !== undefined ? Math.min(delay, Math.max(0, deadline - Date.now())) : delay,
        signal
      );
      if (signal?.aborted) {
        return rejectAndLeave(
          new AbloClaimedError(
            `The wait for the claim on ${targetLabel} was aborted before the grant arrived.`,
            { code: 'claim_wait_aborted' }
          )
        );
      }
      delay = GRANT_POLL_INTERVAL_MS * (0.85 + Math.random() * 0.3);
      // A lease that ended answers the beat with 409 `claim_lost`, which the
      // wire error mapping raises as AbloClaimedError before this reads
      // anything — the wait fails with the loss, as the socket wait does.
      const beat = await claims.heartbeat({ claimId });
      if (beat.status !== 'held') continue;
      // Granted. The heartbeat ack does not carry the fence token — the claim
      // state does, server-stamped at grant.
      const state = await claims.retrieve({ claimId });
      if (state.status !== 'active') {
        return rejectAndLeave(
          new AbloClaimedError(`Claim lost while queued for ${targetLabel}.`, {
            code: 'claim_lost',
          })
        );
      }
      emitClaimStatus(options.onStatus, {
        type: 'granted',
        claimId,
        waited: true,
      });
      return state.fenceToken !== undefined
        ? { id: claimId, fenceToken: state.fenceToken }
        : { id: claimId };
    }
  }

  async function applyClaimedPolicy(
    target: Partial<ModelTarget>,
    options?: ClaimedOptions,
    defaultPolicy: ClaimedOptions['ifClaimed'] = 'return'
  ): Promise<void> {
    const policy = options?.ifClaimed ?? defaultPolicy;
    if (policy === 'return') return;

    // policy === 'fail' — gate the read only when the caller opts in.
    const state = await listClaimState(target);
    if (state.active.length === 0) return;
    throw claimedError(target, state.active, 'model_claimed');
  }

  const commits: CommitResource = {
    async create(commitOptions: CommitCreateOptions): Promise<CommitReceipt> {
      // Same runtime contract as every other write door — one schema.
      assertWriteOptions(
        {
          idempotencyKey: commitOptions.idempotencyKey,
          readAt: commitOptions.readAt,
          onStale: commitOptions.onStale,
          wait: commitOptions.wait,
          claim: commitOptions.claim,
          reads: commitOptions.reads,
          track: commitOptions.track,
        },
        'commits.create'
      );
      const clientTxId = createClientTxId(commitOptions.idempotencyKey);
      // Same claim vocabulary as the WS client's `commits.create`: a handle
      // supplies the batch stale-guard defaults; explicit options win.
      const claim = commitOptions.claim ?? null;
      const operations = normalizeCommitOperations(
        {
          ...commitOptions,
          readAt: commitOptions.readAt ?? claim?.readAt ?? null,
          onStale: commitOptions.onStale ?? (claim?.readAt !== undefined ? 'reject' : null),
        },
        batchFence(claim?.target, claim?.fenceToken)
      );
      const requestBody = {
        operations,
        reads: commitOptions.reads,
        track: commitOptions.track,
      };
      const wait = commitOptions.wait ?? 'confirmed';
      let body: CommitResponse;
      try {
        body = await dispatchHttpCommit({
          path: '/v1/commits',
          method: 'POST',
          idempotencyKey: clientTxId,
          body: requestBody,
          wait,
        });
      } catch (error) {
        // Coordination collision over HTTP — surface it to observability on the
        // same footing as the WS transport, then rethrow unchanged. Fall back to
        // the ops we tried to write so the collision always names a row.
        recordCoordinationConflict(
          error,
          clientTxId,
          operations.map((o) => ({
            model: typeof o.model === 'string' ? o.model : 'unknown',
            id: typeof o.id === 'string' ? o.id : 'unknown',
          }))
        );
        throw error;
      }

      // `requestJson` throws via `translateHttpError` on any non-2xx, so
      // reaching here implies success and `body` is already the success-only
      // receipt union — a rejection is a separate type that never arrives here.
      // The confirmation status therefore passes through verbatim: no branch may
      // collapse a state the server reported into a different one.
      return {
        id: body.id ?? body.clientTxId,
        status: body.status,
        lastSyncId: body.lastSyncId,
        ...(body.notifications && body.notifications.length > 0
          ? { notifications: body.notifications }
          : {}),
        ...(body.missingIds && body.missingIds.length > 0 ? { missingIds: body.missingIds } : {}),
        ...(body.operationResults && body.operationResults.length > 0
          ? { operationResults: body.operationResults }
          : {}),
      };
    },
    get({ id }) {
      if (!id) {
        throw new AbloValidationError('commits.get requires a non-empty id.', {
          code: 'write_options_invalid',
          param: 'id',
        });
      }
      return requestJson(
        `/v1/commits/${encodeURIComponent(id)}`,
        { method: 'GET' },
        commitRecordSchema.nullable(),
      );
    },
    list(options = {}) {
      const parsed = commitRecordListOptionsSchema.parse(options);
      const where = commitRecordWhereSchema.parse(parsed.where ?? {});
      const params = new URLSearchParams();
      if (where.actorId) params.set('actorId', where.actorId);
      if (where.status) params.set('status', where.status);
      if (parsed.cursor) params.set('cursor', parsed.cursor);
      if (parsed.limit !== undefined) params.set('limit', String(parsed.limit));
      const query = params.size > 0 ? `?${params.toString()}` : '';
      return requestJson(
        `/v1/commits${query}`,
        { method: 'GET' },
        commitRecordListSchema,
      );
    },
  };

  const logs: HttpLogsResource = {
    list(logOptions = {}) {
      const params = new URLSearchParams();
      if (logOptions.after !== undefined) params.set('after', logOptions.after);
      if (logOptions.limit !== undefined) params.set('limit', String(logOptions.limit));
      if (logOptions.model !== undefined) params.set('model', logOptions.model);
      if (logOptions.op !== undefined) params.set('op', logOptions.op);
      if (logOptions.since !== undefined) params.set('since', logOptions.since);
      const query = params.size > 0 ? `?${params.toString()}` : '';
      return requestJson(
        `/v1/logs${query}`,
        {
          method: 'GET',
          ...(logOptions.signal ? { signal: logOptions.signal } : {}),
        },
        logListResponseSchema,
      );
    },
  };

  async function listModel<T>(
    modelName: string,
    options?: ServerReadOptions<T>,
  ): Promise<{ readonly data: readonly T[]; readonly evidence?: readonly { id: string; stamp: number }[] }> {
    const params = new URLSearchParams();
    if (options?.limit !== undefined) params.set('limit', String(options.limit));
    if (options?.orderBy) {
      const [col, dir] = Object.entries(options.orderBy)[0] ?? [];
      if (col) {
        params.set('order_by', col);
        if (dir === 'desc') params.set('order', 'desc');
      }
    }
    // The collection route turns any non-reserved query param into an equality
    // filter (`?status=todo`). The wire is AND-only equality — matches what a
    // stateless reactor needs; richer predicates stay on the stateful path.
    if (options?.where && typeof options.where === 'object') {
      for (const [k, v] of Object.entries(options.where as Record<string, unknown>)) {
        if (v !== undefined && v !== null && typeof v !== 'object') params.set(k, String(v));
      }
    }
    const qs = params.toString();
    const res = await requestJson(
      `/v1/models/${encodeURIComponent(modelName)}${qs ? `?${qs}` : ''}`,
      { method: 'GET' },
      modelListResponseSchema
    );
    // The envelope is checked; the rows are not, and cannot be here. This
    // transport is schema-agnostic — it moves rows for whatever schema the
    // caller declared, and `T` is that declaration. Row validation belongs to
    // the typed facade above, which holds the model's schema.
    return {
      data: res.data as T[],
      ...(res.evidence ? { evidence: res.evidence } : {}),
    };
  }

  async function retrieveModel<T>(
    modelName: string,
    params: ModelReadOptions & { readonly id: string }
  ): Promise<HttpTransportRead<T>> {
    await applyClaimedPolicy({ model: modelName, id: params.id }, params);

    const query = await requestJson(
      `/v1/models/${encodeURIComponent(modelName)}/${encodeURIComponent(params.id)}`,
      { method: 'GET' },
      modelReadResponseSchema
    );

    // A miss is `data: undefined`, not a thrown error. The WebSocket client's
    // `retrieve` returns `T | undefined` for a missing row; throwing only here
    // made the obvious read ("does this row exist?") a hard edge that an agent
    // had to wrap in try/catch. Both transports agree: an absent row means absent
    // data. Callers branch on `.data` (the documented `.data?.x` usage).
    // Normalize a miss to `undefined` (the server may send `null` or omit it).
    // The row itself is the caller's declared type — see the note in `listModel`
    // on why this transport validates the envelope and not the row.
    const data = (query.data ?? undefined) as T | undefined;

    return { data, stamp: query.stamp, claims: query.claims };
  }

  /**
   * A single-operation mutation over the model-scoped routes — the canonical
   * surface that mirrors `ablo.<model>.create/update/delete`:
   *
   *   POST   /v1/models/:model        create
   *   PATCH  /v1/models/:model/:id     update
   *   DELETE /v1/models/:model/:id     delete
   *
   * The `commits.create(...)` resource remains the path for atomic
   * multi-operation envelopes; this helper handles the one-operation,
   * one-record case.
   */
  async function mutateModel(
    action: 'create' | 'update' | 'delete',
    modelName: string,
    id: string,
    data: Record<string, unknown> | undefined,
    options: ModelMutationOptions | undefined,
    beforeConfirmation?: (response: CommitResponse) => Promise<void>
  ): Promise<CommitReceipt> {
    assertWriteOptions(
      options && {
        idempotencyKey: options.idempotencyKey,
        readAt: options.readAt,
        onStale: options.onStale,
        claim: options.claim,
        claimRef: options.claimRef,
        fenceToken: options.fenceToken,
        reads: options.reads,
        track: options.track,
      },
      `${modelName} ${action}`
    );
    const clientTxId = createClientTxId(options?.idempotencyKey);
    const encModel = encodeURIComponent(modelName);
    const path =
      action === 'create'
        ? `/v1/models/${encModel}`
        : `/v1/models/${encModel}/${encodeURIComponent(id)}`;
    const method = action === 'create' ? 'POST' : action === 'update' ? 'PATCH' : 'DELETE';

    // A carried claim handle supplies the stale-guard defaults — one claim
    // vocabulary across the WS proxy, `commits.create`, and these routes.
    const rawClaim = options?.claim;
    const claimHandle =
      typeof rawClaim === 'object' &&
      rawClaim !== null &&
      (rawClaim as { object?: unknown }).object === 'claim' &&
      typeof (rawClaim as { id?: unknown }).id === 'string'
        ? (rawClaim as Claim)
        : undefined;
    const readAt = options?.readAt ?? claimHandle?.readAt;
    const requestBody: Record<string, unknown> = {
      claim: normalizeClaimId(options?.claimRef) ?? claimHandle?.id,
      onStale: options?.onStale ?? (claimHandle?.readAt !== undefined ? 'reject' : undefined),
      readAt,
      reads: options?.reads,
      track: options?.track,
      // The claim's fencing token (Option B), so the per-model HTTP write door
      // fences the same as the WS proxy and `commits.create`.
      fenceToken: options?.fenceToken ?? claimHandle?.fenceToken,
    };
    if (action === 'create') requestBody.id = id;
    if (data !== undefined) requestBody.data = data;

    let body: CommitResponse;
    try {
      body = await dispatchHttpCommit(
        {
          path,
          method,
          idempotencyKey: clientTxId,
          body: requestBody,
          // Model methods have one promise contract: authoritative
          // confirmation. Early queued receipts remain available through the
          // lower-level `commits.create` lifecycle surface.
          wait: 'confirmed',
        },
        beforeConfirmation
      );
    } catch (error) {
      // The per-model write door (`ablo.<model>.update/create/delete`). Capture
      // coordination collisions here too; this single row is the fallback target.
      recordCoordinationConflict(error, clientTxId, [{ model: modelName, id }]);
      throw error;
    }

    // Same contract as `commits.create` above: a non-2xx already threw, so
    // `body` is the success-only receipt union and its confirmation status passes
    // through verbatim rather than through a catch-all branch.
    return {
      id: body.serverTxId,
      status: body.status,
      lastSyncId: body.lastSyncId,
    };
  }

  function model<T = Record<string, unknown>, Fields = T>(
    name: string,
  ): HttpTransportModel<T, Fields> {
    // Durable lease + FIFO wait-line over HTTP (the existing claim routes). A
    // claim is server state, not a subscription — acquire/hold/release are plain
    // request/response, so a stateless agent participates in coordination too.
    const claimPath = (id: string): string =>
      `/v1/models/${encodeURIComponent(name)}/${encodeURIComponent(id)}/claim`;
    const isClaimHandle = (value: unknown): value is Claim<T> =>
      typeof value === 'object' &&
      value !== null &&
      (value as { object?: unknown }).object === 'claim' &&
      typeof (value as { id?: unknown }).id === 'string' &&
      typeof (value as { release?: unknown }).release === 'function';
    const acquireClaim = async (
      params: ClaimParams<Fields>
    ): Promise<{ id: string; fenceToken?: number }> => {
      const contention = resolveClaimContentionOptions(params);
      // The row is named by the URL, so `target` carries only the narrowing a
      // claim adds below it. Sending it is what makes a field-scoped claim
      // actually field-scoped: the server's conflict rule reads `path`,
      // `range`, and `field`, so a claim that keeps them client-side takes a
      // lease on the whole row while its handle says otherwise.
      // Projected in one move rather than member by member. The member-by-member
      // version is how `field` came to be sent while `fields` was not, which
      // left a set-scoped claim silently holding the whole row.
      const narrowing: ClaimTargetBody = subTarget(params, name);
      // Typed as the request contract rather than a bare literal — the omission
      // above was invisible for exactly as long as this was an untyped object.
      const request: ClaimRequest = {
        description: claimDescription(params),
        ...(params.ttl !== undefined ? { ttl: params.ttl } : {}),
        // The caller's `meta` is the declared shape; the body is wire-shaped,
        // so it crosses through the same conversion `subTarget` used above.
        ...(params.meta !== undefined ? { meta: wireMeta(params.meta) } : {}),
        ...(Object.keys(narrowing).length > 0 ? { target: narrowing } : {}),
        // `queue` (default true) → queue behind the holder; false → fail-fast
        // with AbloClaimedError (work-distribution dedup).
        queue: contention.wait,
      };
      let body: z.infer<typeof claimAcquireResponseSchema>;
      try {
        body = await requestJson(
          claimPath(params.id),
          { method: 'POST', body: JSON.stringify(request) },
          claimAcquireResponseSchema
        );
      } catch (error) {
        const normalized = error instanceof AbloError
          ? error
          : new AbloConnectionError(String(error));
        emitClaimStatus(
          contention.onStatus,
          claimAttemptFailure(contention.wait, normalized),
        );
        throw error;
      }
      // One resource, two states, discriminated by `status`. The queued arm
      // WAITS, exactly as the socket client does: `claim({ id })` means
      // "serialize me behind the holder" on every transport, and the grant
      // machinery is the SDK's to own, not a loop each caller re-derives.
      // (Being queued is still not an error — ADR 0018 — which is precisely
      // why it no longer surfaces as one here. The `claims` namespace remains
      // the manual ticket surface.)
      if (body.status === 'queued') {
        try {
          return await awaitGrantOverHttp(
            `${name}/${params.id}`,
            body,
            contention,
          );
        } catch (error) {
          const normalized = error instanceof AbloError
            ? error
            : new AbloConnectionError(String(error));
          emitClaimStatus(
            contention.onStatus,
            claimAttemptFailure(contention.wait, normalized),
          );
          throw error;
        }
      }
      emitClaimStatus(contention.onStatus, {
        type: 'granted',
        claimId: body.id,
        waited: false,
      });
      // The lease's own fields are mirrored at the top level, the same place
      // the poll puts them — one reader for both answers.
      return body.fenceToken !== undefined
        ? { id: body.id, fenceToken: body.fenceToken }
        : { id: body.id };
    };
    const releaseClaim = (
      params: ClaimLookupParams<T> | ClaimParams<Fields> | Claim<T>,
    ): Promise<void> =>
      requestRaw(claimPath(isClaimHandle(params) ? params.target.id : params.id), {
        method: 'DELETE',
      }).then(() => undefined);

    // One beat on the held lease. A lapsed lease answers `claim_lost`
    // (409), which the wire error mapping surfaces as AbloClaimedError —
    // the definitive signal that stops the auto-heartbeat loop.
    const heartbeatClaim = async (
      id: string,
      claimId: string,
      options: ClaimHeartbeatOptions
    ): Promise<ClaimHeartbeat> => {
      const reply = await requestJson(
        `${claimPath(id)}/heartbeat`,
        {
          method: 'POST',
          body: JSON.stringify({
            claimId,
            ...(options.ttl !== undefined ? { ttl: options.ttl } : {}),
            ...(options.details !== undefined ? { details: options.details } : {}),
          }),
        },
        claimHeartbeatReplySchema
      );
      return heldHeartbeatReply(reply, `claim ${claimId} on ${name}/${id}`);
    };

    function claimImpl(
      params: ClaimSkipParams<Fields>
    ): Promise<HeldClaim<T> | null>;
    function claimImpl(params: ClaimParams<Fields>): Promise<HeldClaim<T>>;
    async function claimImpl(
      params: ClaimParams<Fields>,
    ): Promise<HeldClaim<T> | null> {
      let acquired: { id: string; fenceToken?: number };
      try {
        acquired = await acquireClaim(params);
      } catch (error) {
        // The try-claim: a held target is an expected outcome of `queue:
        // false`, not an error — resolve `null` and let the caller move on.
        // Every other failure (auth, validation, network) stays a rejection,
        // and the write-site claim path calls `acquireClaim` directly, so a
        // write that could not claim still fails loudly.
        if (
          !resolveClaimContentionOptions(params).wait &&
          error instanceof AbloClaimedError &&
          (error.code === 'entity_claimed' || error.code === 'claim_conflict')
        ) {
          return null;
        }
        throw error;
      }
      const { id: claimId, fenceToken } = acquired;
      observability?.captureClaim({
        phase: 'acquired',
        claimId,
        model: name,
        id: params.id,
        description: claimDescription(params),
      });
      const { data, stamp } = await retrieveModel<T>(name, { id: params.id });
      // A held claim hands back a snapshot; the typed `HeldClaim.data` is `T`.
      // `retrieve` now reports a miss as `undefined` rather than throwing, but a
      // claim on a row that doesn't exist has nothing to hold — surface it.
      if (data === undefined) {
        throw new AbloNotFoundError(
          `Cannot claim ${name}/${params.id}: it does not exist (or is outside this credential's scope).`,
          [params.id]
        );
      }
      // One reading of the heartbeat options — cadence and callbacks from
      // whichever spelling the caller used (plan object, shorthand, or the
      // deprecated flat callbacks).
      const plan = resolveHeartbeatPlan(params);
      const heartbeat = async (
        beatOptions?: Duration | ClaimHeartbeatOptions
      ): Promise<ClaimHeartbeat> => {
        const resolved = resolveHeartbeatOptions(beatOptions);
        const beat = await heartbeatClaim(params.id, claimId, {
          ttl: resolved.ttl ?? params.ttl,
          ...(resolved.details !== undefined ? { details: resolved.details } : {}),
        });
        plan.onBeat?.(beat);
        return beat;
      };

      // Opt-in auto-heartbeat — the background-worker cadence. The stateless
      // HTTP claim defaults to the server's acquire window when no TTL
      // was requested, so the default cadence lands at 20s beats.
      const stopHeartbeatLoop = plan.loop
        ? startClaimHeartbeatLoop({
            beat: () => heartbeat(),
            intervalMs: heartbeatCadenceMs(
              params.ttl !== undefined ? toMs(params.ttl) : DEFAULT_CLAIM_TTL_MS,
              plan.cadence
            ),
            ...(plan.onLost ? { onLost: plan.onLost } : {}),
          })
        : undefined;

      const release = () => {
        stopHeartbeatLoop?.();
        return releaseClaim(params);
      };
      // The handle handed back is a public claim, so its `meta` is the declared
      // shape — the same crossing the two decodes above make, spelled the same
      // way. `subTarget` is wire-shaped by contract, including here, where the
      // value happens to have started out declared.
      const { meta, ...narrowed } = subTarget(params, name);
      return {
        object: 'claim',
        id: claimId,
        readAt: stamp,
        ...(fenceToken !== undefined ? { fenceToken } : {}),
        target: {
          ...streamTarget({ model: name, id: params.id }),
          ...narrowed,
          ...(meta !== undefined ? { meta: declaredMeta(meta) } : {}),
        },
        description: claimDescription(params),
        data,
        release,
        revoke: () => {
          void release().catch(() => {});
        },
        heartbeat,
        [Symbol.asyncDispose]: release,
      };
    }
    const claimsForEntity = (
      params: ClaimLookupParams<T>
    ): Promise<ClaimListResponse> =>
      requestJson(
        `/v1/claims?model=${encodeURIComponent(name)}&id=${encodeURIComponent(params.id)}${
          ''
        }`,
        { method: 'GET' },
        claimListResponseSchema
      );
    const claim = Object.assign(claimImpl, {
      release: releaseClaim,
      state: async (params: ClaimLookupParams<T>): Promise<Claim | null> => {
        const res = await claimsForEntity(params);
        // Holders come first in the one list; a `queued` entry is a waiter.
        const first = res.data.find((row) => row.status !== 'queued');
        return first ? claimFromModelClaim(first) : null;
      },
      queue: async (
        params: ClaimLookupParams<T>
      ): Promise<ClaimQueueView> => {
        const res = await claimsForEntity(params);
        return claimQueueView(
          res.data
            .filter((row) => row.status === 'queued')
            .map(claimFromModelClaim),
        );
      },
      reorder: async (params: ClaimReorderParams<T>): Promise<void> => {
        await requestRaw(`${claimPath(params.id)}/reorder`, {
          method: 'POST',
          // The reorder route's payload is `{ heldBy, claimId }[]` — a Claim's id
          // is the claimId.
          body: JSON.stringify({
            order: params.order.map((i) => ({ heldBy: i.heldBy, claimId: i.id })),
          }),
        });
      },
    }) as HttpClaimApi<T, Fields>;

    const withMutationClaim = async <R>(
      id: string,
      input: ModelMutationOptions | undefined,
      run: (options: ModelMutationOptions | undefined) => Promise<R>
    ): Promise<R> => {
      const claimInput = input?.claim;
      if (!claimInput) return run(input);

      if (isClaimHandle(claimInput)) {
        return run({
          ...input,
          claimRef: { id: claimInput.id },
          ...(claimInput.fenceToken !== undefined
            ? { fenceToken: claimInput.fenceToken }
            : {}),
          claim: undefined,
        });
      }

      // `isClaimHandle` ruled out the handle form above; the generic mismatch
      // (the union carries `Claim`, the guard narrows `Claim<T>`) keeps the
      // compiler from subtracting it, so narrow to the inline-options form.
      const { id: claimId, fenceToken } = await acquireClaim({
        id,
        ...(claimInput as ClaimOptions<Fields>),
      });
      try {
        return await run({
          ...input,
          claimRef: { id: claimId },
          ...(fenceToken !== undefined ? { fenceToken } : {}),
          claim: undefined,
        });
      } finally {
        await releaseClaim({ id }).catch(() => {});
      }
    };

    // `update` is overloaded: the classic `update({ id, data })` and the
    // functional `update(id, current => next)`. Declared as a real overloaded
    // function (not an arrow assigned to the property) so the two public
    // signatures survive — the implementation's `| undefined` return is for the
    // updater's opt-out, hidden from the fixed-value form's callers.
    function updateModel(
      params: ModelMutationOptions & { readonly id: string; readonly data: Record<string, unknown> }
    ): Promise<CommitReceipt>;
    function updateModel(
      id: string,
      updater: ModelUpdater<T>,
      options?: FunctionalUpdateOptions
    ): Promise<CommitReceipt | undefined>;
    function updateModel(
      arg:
        | (ModelMutationOptions & { readonly id: string; readonly data: Record<string, unknown> })
        | string,
      updater?: ModelUpdater<T>,
      contention?: FunctionalUpdateOptions
    ): Promise<CommitReceipt | undefined> {
      // Functional form: update(id, current => next). The SDK owns the
      // read-fresh → compute → compare-and-swap → reconcile loop; correctness
      // rides on the row's watermark (readAt + onStale:'reject'), so no claim
      // or per-participant identity is needed and contention never clobbers.
      if (typeof arg === 'string') {
        const id = arg;
        if (typeof updater !== 'function') {
          throw new AbloValidationError(
            `${name}.update('${id}', updater): the second argument must be an updater ` +
              `function (current) => next. To write a fixed value, use update({ id, data }).`,
            { code: 'write_options_invalid' }
          );
        }
        return reconcileFunctionalUpdate<T, CommitReceipt>(updater, contention, {
          model: name,
          id,
          readFresh: async () => {
            const read = await retrieveModel<T>(name, { id });
            return { data: read.data, stamp: read.stamp };
          },
          writeNext: (patch, readAt) =>
            mutateModel('update', name, id, patch, {
              readAt,
              onStale: 'reject',
            }),
        });
      }
      const params = arg;
      return withMutationClaim(params.id, params, async (options) => {
        await applyClaimedPolicy({ model: name, id: params.id }, options);
        return mutateModel('update', name, params.id, params.data, options);
      });
    }

    return {
      claim,
      get(params: ModelReadOptions & { readonly id: string }): Promise<HttpTransportRead<T>> {
        return retrieveModel<T>(name, params);
      },
      retrieve(params: ModelReadOptions & { readonly id: string }): Promise<HttpTransportRead<T>> {
        return retrieveModel<T>(name, params);
      },
      list(options?: ServerReadOptions<T>): ReturnType<typeof listModel<T>> {
        return listModel<T>(name, options);
      },
      async create(
        params: ModelMutationOptions & {
          readonly data: Record<string, unknown>;
          readonly id?: string | null;
        }
      ): Promise<T> {
        const id = params.id ?? createModelId(name, params.idempotencyKey);
        return withMutationClaim(id, params, async (options) => {
          await applyClaimedPolicy({ model: name, id }, options);
          // Confirm the write, then return the row — the obvious expectation of
          // "create" (the WebSocket client already returns the row). The read-
          // back is the authoritative server row, so it carries the framework
          // defaults (createdAt, createdBy, …) and, for an idempotent re-create of
          // an existing id, the existing row rather than the caller's input.
          let created: T | undefined;
          await mutateModel(
            'create',
            name,
            id,
            params.data,
            options,
            async () => {
              const read = await retrieveModel<T>(name, { id });
              if (read.data === undefined) {
                throw new AbloNotFoundError(
                  `create ${name}/${id} did not yield a readable row (the write did not confirm).`,
                  [id]
                );
              }
              created = read.data;
            }
          );
          if (created === undefined) {
            throw new AbloConnectionError('Create confirmation did not return its row.', {
              code: 'commit_no_result',
            });
          }
          return created;
        });
      },
      update: updateModel,
      async delete(params: ModelMutationOptions & { readonly id: string }): Promise<CommitReceipt> {
        return withMutationClaim(params.id, params, async (options) => {
          await applyClaimedPolicy({ model: name, id: params.id }, options);
          return mutateModel('delete', name, params.id, undefined, options);
        });
      },
      async track(params: ModelTrackParams): Promise<ModelTrackResult> {
        const dependency: TrackDependency = {
          model: name.toLowerCase(),
          id: params.id,
          ...(params.readAt !== undefined ? { readAt: params.readAt } : {}),
        };
        // A track carries no write, so it rides the commit lane as a
        // zero-operation body — the shape `/v1/commits` accepts for registering
        // a premise without one. Going through the same durable lane as every
        // other commit means a disconnect replays the registration rather than
        // dropping it, and a notification that had already fired is not lost to
        // a retry.
        const body = await dispatchHttpCommit({
          path: '/v1/commits',
          method: 'POST',
          idempotencyKey: createClientTxId(),
          body: { track: [dependency] },
          wait: 'confirmed',
        });
        return body.notifications && body.notifications.length > 0
          ? { notifications: body.notifications }
          : {};
      },
    };
  }

  return {
    ready,
    get identity() { return effectiveAuthority; },
    waitForFlush: () =>
      runInHttpCommitLane(async () => {
        await prepare();
        const replayed = await replayHttpCommitOutbox();
        await confirmReplayedHttpCommits(replayed);
      }),
    dispose() {
      if (!disposePromise) {
        const scheduledCommits = httpCommitLane;
        disposePromise = (async () => {
          await scheduledCommits;
          await waitForRequestIdle();
        })();
      }
      return disposePromise;
    },
    async purge() {},
    commits,
    claims,
    logs,
    model,
    sessions: {
      async create(params: CreateSessionParams<SchemaRecord>): Promise<AbloSession> {
        // Stateless mint: the configured key is the control-plane credential here
        // (no startup `rk_` exchange runs on this client). It reuses the resolved
        // base URL and fetch; the shared `mintSession` handles the two server routes.
        const apiKey = await resolveApiKeyValue(configuredApiKey);
        if (!apiKey) {
          throw new AbloAuthenticationError(
            'sessions.create requires a secret (sk_) API key — call it from your backend, not the browser.',
            { code: 'apikey_missing' }
          );
        }
        // A transport built without a schema has no way to translate `can`'s
        // schema keys into the type names the server gates on. Minting anyway
        // would spell every override wrong and surface as
        // `capability_scope_denied` on the agent's first write, so refuse here
        // instead of guessing.
        if (!options.modelTypenames) {
          throw new AbloValidationError(
            'sessions.create needs the schema this client is bound to. Construct it ' +
              "through Ablo({ schema, apiKey, transport: 'http' }) rather than the " +
              'bare transport.',
            { code: 'invalid_options', param: 'schema' },
          );
        }
        return mintSession(params, {
          apiKey,
          baseUrl: apiBaseUrl,
          modelTypenames: options.modelTypenames,
          ...(options.fetch ? { fetch: options.fetch } : {}),
        });
      },
      async revoke({ id }) {
        const apiKey = await resolveApiKeyValue(configuredApiKey);
        return revokeCapability({
          apiKey: apiKey ?? '',
          baseUrl: apiBaseUrl,
          id,
          ...(options.fetch ? { fetch: options.fetch } : {}),
        });
      },
      async rotate({ id, graceSeconds, ttlSeconds }) {
        const apiKey = await resolveApiKeyValue(configuredApiKey);
        return rotateCapability({
          apiKey: apiKey ?? '',
          baseUrl: apiBaseUrl,
          id,
          ...(graceSeconds !== undefined ? { graceSeconds } : {}),
          ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
          ...(options.fetch ? { fetch: options.fetch } : {}),
        });
      },
    },
    async getAuthToken(): Promise<string | null> {
      // Mirror `authHeaders()`: a configured API key wins, else the
      // construction-time auth token. Resolve the (possibly async) key setter.
      return (await resolveApiKeyValue(configuredApiKey)) ?? configuredAuthToken ?? null;
    },
  };
}

function normalizeClaimId(
  claim: string | { readonly id: string } | null | undefined
): string | undefined {
  if (typeof claim === 'string') return claim;
  return claim?.id;
}

function parseBody(bodyText: string): unknown {
  if (bodyText.length === 0) return null;
  try {
    return JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
}
