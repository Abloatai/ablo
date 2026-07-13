/**
 * Private HTTP protocol client behind `Ablo({ schema, transport: 'http' })`.
 * It carries no object pool, local database, or WebSocket and maps Model,
 * Claim, and Commit protocol shapes directly to server routes. The typed
 * facade in `httpClient.ts` is the application boundary; this module owns
 * transport envelopes, watermarks, replay, and route details.
 */

import {
  AbloClaimedError,
  AbloAuthenticationError,
  AbloConnectionError,
  AbloIdempotencyError,
  AbloValidationError,
  AbloNotFoundError,
  claimedError,
  translateHttpError,
} from '../errors.js';
import { z } from 'zod';
import { v5 as uuidv5 } from 'uuid';
import {
  reconcileFunctionalUpdate,
  type ModelUpdater,
  type ContentionOptions,
} from './functionalUpdate.js';
import {
  assertBrowserSafety,
  readProcessEnv,
  resolveApiKey,
  resolveApiKeyValue,
  resolveAuthToken,
  resolveBaseURL,
  resolveBootstrapBaseUrl,
  resolveDatabaseUrl,
  warnIfCliKeyMismatch,
  warnIfDatabaseUrlEnvIgnored,
  warnIfDatabaseUrlDeprecated,
} from './auth.js';
import { registerDataSource } from './registerDataSource.js';
import { PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER } from '../wire/protocolVersion.js';
import { toMs } from '../utils/duration.js';
import {
  heartbeatCadenceMs,
  resolveHeartbeatOptions,
  startClaimHeartbeatLoop,
} from './claimHeartbeatLoop.js';
import type { AbloOptions } from './options.js';
import type {
  ClaimedOptions,
  CommitCreateOptions,
  CommitOperationInput,
  CommitReceipt,
  CommitResource,
  HttpClaimApi,
  HttpTransportModel,
  ModelClaim,
  ModelMutationOptions,
  ModelReadOptions,
  HttpTransportRead,
  ModelTarget,
  CreateSessionParams,
  AbloSession,
} from './resourceTypes.js';
import { mintSession } from './sessionMint.js';
import { parseIdentityResolveResponse } from '../auth/schemas.js';
import { staleNotificationSchema } from '../coordination/schema.js';

/** The heartbeat routes' reply body — status, expiry, queue pressure. */
interface HeartbeatReply {
  status?: 'held' | 'queued' | 'lost';
  expiresAt?: number;
  queueDepth?: number;
}

/**
 * Interpret a heartbeat reply for a lease this handle HOLDS: anything other
 * than `held` means the lease is no longer ours (a holder cannot be `queued`;
 * `lost` rides a 409 that the wire error mapping already surfaces as
 * AbloClaimedError before reaching here). The thrown loss is the definitive
 * signal that stops the auto-heartbeat loop.
 */
function heldHeartbeatReply(
  reply: HeartbeatReply,
  label: string,
): ClaimHeartbeat {
  if (reply.status === 'held' && typeof reply.expiresAt === 'number') {
    return {
      expiresAt: reply.expiresAt,
      ...(reply.queueDepth !== undefined ? { queueDepth: reply.queueDepth } : {}),
    };
  }
  throw new AbloClaimedError(
    `The lease behind ${label} is no longer held — it expired or was granted onward. Re-acquire the claim and retry; a write attempted under the old lease is rejected by its \`readAt\` guard.`,
    { code: 'claim_lost' },
  );
}
import type { SchemaRecord } from '../schema/schema.js';
import type {
  ClaimLookupParams,
  ClaimOptions,
  ClaimParams,
  ClaimReorderParams,
  ServerReadOptions,
} from './createModelProxy.js';
import type { Duration } from '../utils/duration.js';
import type {
  Claim,
  ClaimHeartbeat,
  ClaimHeartbeatOptions,
  HeldClaim,
} from '../types/streams.js';
import type { SyncObservabilityProvider } from '../interfaces/index.js';
import { assertWriteOptions } from './writeOptionsSchema.js';
import {
  createDurableHttpCommitEnvelope,
  canonicalHttpCommitBody,
  durableHttpCommitEnvelopeSchema,
  httpCommitEnvelopeRecordId,
  isHttpCommitReplayExpired,
  type DurableHttpCommitEnvelope,
} from '../transactions/httpCommitEnvelope.js';
import type { CommitOutboxScope } from '../transactions/commitEnvelope.js';
import { resolveDurableWrites } from './durableWrites.js';

/** @internal Private options for the schema-agnostic HTTP protocol transport. */
export type HttpTransportOptions = Omit<AbloOptions, 'schema'> & {
  readonly bootstrapBaseUrl?: string | undefined;
  /** Schema-key to wire-typename mapping used only when minting agent sessions. */
  readonly modelTypenames?: Readonly<Record<string, string>> | undefined;
  /**
   * The observability provider forwarded from `Ablo({ observability })`. The HTTP
   * transport emits the same claim and conflict events as the WebSocket transport,
   * so a `ClaimLog` works identically for headless server-agent evaluations.
   */
  readonly observability?: SyncObservabilityProvider;
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

// NOTE: end-user / agent session minting is `ablo.sessions.create(...)` (typed
// against the schema, see Ablo.ts `CreateSessionParams`). There is no separate
// `ephemeralKeys` resource — `sessions` is the one front door for both.

/** @internal Private protocol surface wrapped by `AbloHttpClient`. */
export interface HttpTransport {
  ready(): Promise<void>;
  waitForFlush(): Promise<void>;
  dispose(): Promise<void>;
  purge(): Promise<void>;
  readonly commits: CommitResource;
  model<T = Record<string, unknown>>(name: string): HttpTransportModel<T>;
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
  readonly sessions: {
    create(params: CreateSessionParams<SchemaRecord>): Promise<AbloSession>;
  };
}

interface QueryResponse {
  readonly data?: unknown;
  readonly stamp?: number;
  readonly claims?: readonly ModelClaim[];
}

const successfulCommitResponseSchema = z
  .object({
    object: z.literal('commit_receipt'),
    id: z.string().min(1).optional(),
    clientTxId: z.string().min(1),
    serverTxId: z.string().min(1),
    status: z.enum(['queued', 'confirmed']),
    success: z.literal(true),
    lastSyncId: z.number().int().nonnegative().optional(),
    ops: z.number().int().positive(),
    notifications: z.array(staleNotificationSchema).optional(),
    /** Ids of UPDATE/DELETE targets that matched zero rows (loud 0-row writes). */
    missingIds: z.array(z.string().min(1)).optional(),
  })
  .loose();

type CommitResponse = z.output<typeof successfulCommitResponseSchema>;

function parseSuccessfulCommitResponse(
  value: unknown,
  idempotencyKey: string,
): CommitResponse {
  const parsed = successfulCommitResponseSchema.safeParse(value);
  if (!parsed.success || parsed.data.clientTxId !== idempotencyKey) {
    throw new AbloConnectionError(
      'The commit endpoint returned an invalid success receipt; its outcome remains pending and is safe to retry.',
      {
        code: 'commit_no_result',
        cause: parsed.success
          ? new Error('Commit receipt clientTxId did not match its idempotency key')
          : parsed.error,
      },
    );
  }
  return parsed.data;
}

interface ClaimListResponse {
  readonly claims?: readonly ModelClaim[];
  readonly queue?: readonly ModelClaim[];
}

/** Decode the HTTP claim DTO into the one public Claim shape. */
function claimFromModelClaim(claim: ModelClaim): Claim {
  return {
    object: 'claim',
    id: claim.id,
    ...(claim.status ? { status: claim.status } : {}),
    reason: claim.reason,
    ...(claim.description ? { description: claim.description } : {}),
    heldBy: claim.actor,
    participantKind: claim.participantKind,
    expiresAt: claim.expiresAt,
    ...(claim.position !== undefined ? { position: claim.position } : {}),
    target: {
      type: claim.target.model,
      id: claim.target.id,
      ...(claim.target.path ? { path: claim.target.path } : {}),
      ...(claim.target.range ? { range: claim.target.range } : {}),
      ...(claim.target.field ? { field: claim.target.field } : {}),
      ...(claim.target.meta ? { meta: claim.target.meta } : {}),
    },
  };
}

/** @internal Constructed only by the typed HTTP facade. */
export function createHttpTransport(options: HttpTransportOptions): HttpTransport {
  const env = readProcessEnv();
  const authInput = { options, env };
  const configuredApiKey = resolveApiKey(authInput);
  const configuredAuthToken = resolveAuthToken(authInput);
  const configuredDatabaseUrl = resolveDatabaseUrl(authInput);
  // Nudge (once) if a stray DATABASE_URL is in the env but `databaseUrl` wasn't
  // passed — no logger on this path, so the helper falls back to console.warn.
  warnIfDatabaseUrlEnvIgnored(authInput);
  warnIfDatabaseUrlDeprecated(authInput);
  void warnIfCliKeyMismatch(authInput);
  assertBrowserSafety({
    apiKey: configuredApiKey,
    databaseUrl: configuredDatabaseUrl,
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
    fallbackRows: readonly { model: string; id: string }[],
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
      { code: 'fetch_unavailable' },
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
  const legacyCommitOutboxScope = (
    options as { readonly commitOutboxScope?: CommitOutboxScope }
  ).commitOutboxScope;
  const httpOutboxPlaneNamespace = canonicalHttpCommitBody({
    apiBaseUrl,
    defaultQuery: Object.entries(options.defaultQuery ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
  });
  let httpOutboxScopeNamespace: string | null = null;

  let readyPromise: Promise<void> | null = null;
  let httpCommitLane: Promise<void> = Promise.resolve();

  function runInHttpCommitLane<T>(work: () => Promise<T>): Promise<T> {
    const result = httpCommitLane.then(work);
    httpCommitLane = result.then(
      () => undefined,
      () => undefined,
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
      const rawIdentity = await requestJson<unknown>(
        '/auth/identity',
        { method: 'GET' },
        true,
      );
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

  async function ready(): Promise<void> {
    if (readyPromise) return readyPromise;

    readyPromise = (async () => {
      if (configuredDatabaseUrl) {
        await registerDataSource({
          baseUrl: apiBaseUrl,
          apiKey: await resolveApiKeyValue(configuredApiKey),
          databaseUrl: configuredDatabaseUrl,
          ...(options.fetch ? { fetchImpl: options.fetch } : {}),
        });
      }
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

  async function authHeaders(
    sealedProtocolVersion?: number,
  ): Promise<Record<string, string>> {
    const apiKey = await resolveApiKeyValue(configuredApiKey);
    const token = apiKey ?? configuredAuthToken;
    if (!token) {
      throw new AbloAuthenticationError(
        'The HTTP client requires an API key. Pass `apiKey` or set ABLO_API_KEY.',
        { code: 'api_key_required' },
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

  async function requestJson<T>(
    path: string,
    init: RequestInit & {
      readonly idempotencyKey?: string | null;
      readonly sealedProtocolVersion?: number;
    },
    skipReady = false,
  ): Promise<T> {
    if (!skipReady) await ready();
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
    const onCallerAbort = (): void => { controller.abort(callerSignal?.reason); };
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
          { code: 'wait_for_timeout', cause: error },
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
        res.headers.get('x-request-id') ?? undefined,
      );
    }

    return body as T;
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
      // Do not report the remote outcome until local settlement is durable.
      // The retained record can still be replayed inside the safe window.
      throw new AbloConnectionError(
        'The server settled the commit, but its local outbox record could not be cleared.',
        { code: 'db_not_opened', cause },
      );
    }
  }

  interface ReplayedHttpCommit {
    readonly envelope: DurableHttpCommitEnvelope;
    readonly response: CommitResponse;
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
      ) continue;
      const parsed = durableHttpCommitEnvelopeSchema.safeParse(row);
      if (!parsed.success) {
        throw new AbloValidationError(
          'A saved HTTP write is unreadable; replay stopped before any newer write was sent.',
          { code: 'write_options_invalid', cause: parsed.error },
        );
      }
      if (parsed.data.scopeNamespace !== scopeNamespace) continue;
      if (isHttpCommitReplayExpired(parsed.data)) {
        throw new AbloIdempotencyError(
          'A saved HTTP write is older than the server idempotency window and cannot be replayed safely.',
          { code: 'idempotency_conflict' },
        );
      }
      envelopes.push(parsed.data);
    }
    envelopes.sort(
      (a, b) =>
        (a.sequence ?? a.sealedAt * 1_000) -
          (b.sequence ?? b.sealedAt * 1_000) ||
        a.id.localeCompare(b.id),
    );
    for (const envelope of envelopes) {
      try {
        const raw = await requestJson<unknown>(
          envelope.request.path,
          {
            method: envelope.request.method,
            idempotencyKey: envelope.idempotencyKey,
            sealedProtocolVersion: envelope.protocolVersion,
            body: envelope.request.body,
          },
          true,
        );
        const response = parseSuccessfulCommitResponse(raw, envelope.idempotencyKey);
        await settleHttpEnvelope(envelope.id);
        replayed.set(envelope.idempotencyKey, { envelope, response });
      } catch (error) {
        if (isDefinitiveHttpRejection(error)) {
          await settleHttpEnvelope(envelope.id);
        }
        throw error;
      }
    }
    return replayed;
  }

  let lastHttpCommitSequence = 0;
  function nextHttpCommitSequence(): number {
    const wallSequence = Date.now() * 1_000;
    lastHttpCommitSequence = Math.max(
      wallSequence,
      lastHttpCommitSequence + 1,
    );
    return lastHttpCommitSequence;
  }

  async function sealHttpCommit(input: {
    idempotencyKey: string;
    method: 'POST' | 'PATCH' | 'DELETE';
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
    const recordId = httpCommitEnvelopeRecordId(
      input.idempotencyKey,
      scopeNamespace,
    );
    const legacyRecordId = httpCommitEnvelopeRecordId(input.idempotencyKey);
    const existingRows = await commitOutbox.list();
    const existingRaw = existingRows.find(
      (row) =>
        typeof row === 'object' &&
        row !== null &&
        ((row as { id?: unknown }).id === recordId ||
          (row as { id?: unknown }).id === legacyRecordId),
    );
    const serializedBody = canonicalHttpCommitBody(input.body);
    if (existingRaw !== undefined) {
      const existing = durableHttpCommitEnvelopeSchema.parse(existingRaw);
      if (isHttpCommitReplayExpired(existing)) {
        throw new AbloIdempotencyError(
          'This saved HTTP write is older than the server idempotency window and cannot be retried safely.',
          { code: 'idempotency_conflict' },
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
          { code: 'idempotency_conflict' },
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
      method: 'POST' | 'PATCH' | 'DELETE';
      path: string;
      body: unknown;
    },
    beforeSettlement?: (response: CommitResponse) => Promise<void>,
  ): Promise<CommitResponse> {
    return runInHttpCommitLane(async () => {
      await ready();
      // `ready()` covers startup. Re-draining here makes every later write wait
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
            { code: 'idempotency_conflict' },
          );
        }
        await beforeSettlement?.(prior.response);
        return prior.response;
      }
      const durableEnvelope = await sealHttpCommit(input);
      const requestBody = durableEnvelope?.request.body ?? canonicalHttpCommitBody(input.body);

      let response: CommitResponse;
      try {
        const raw = await requestJson<unknown>(
          input.path,
          {
            method: input.method,
            idempotencyKey: input.idempotencyKey,
            ...(durableEnvelope
              ? { sealedProtocolVersion: durableEnvelope.protocolVersion }
              : {}),
            body: requestBody,
          },
          true,
        );
        response = parseSuccessfulCommitResponse(raw, input.idempotencyKey);
      } catch (error) {
        if (durableEnvelope && isDefinitiveHttpRejection(error)) {
          await settleHttpEnvelope(durableEnvelope.id);
        }
        throw error;
      }

      // A model-create readback can participate in settlement: if it fails,
      // retain the exact write so a same-key retry recovers the generated id.
      await beforeSettlement?.(response);
      if (durableEnvelope) await settleHttpEnvelope(durableEnvelope.id);
      return response;
    });
  }

  function createClientTxId(idempotencyKey?: string | null): string {
    if (idempotencyKey && idempotencyKey.length > 0) return idempotencyKey;
    return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `tx_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function createClaimId(): string {
    return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? `int_${crypto.randomUUID()}`
      : `int_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function createModelId(modelName: string, idempotencyKey?: string | null): string {
    if (idempotencyKey) {
      return uuidv5(
        `${modelName}:${idempotencyKey}`,
        'aa4ba6d4-bf0b-5b38-9c45-116f79a6e548',
      );
    }
    return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `id_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function normalizeCommitOperation(
    op: CommitOperationInput,
    defaults: Pick<CommitCreateOptions, 'readAt' | 'onStale'>,
  ): CommitOperationInput {
    return {
      action: op.action,
      model: op.model,
      id: op.id ?? null,
      data: op.data ?? null,
      transactionId: op.transactionId ?? null,
      readAt: op.readAt ?? defaults.readAt ?? null,
      onStale: op.onStale ?? defaults.onStale ?? null,
    };
  }

  function normalizeCommitOperations(
    commitOptions: CommitCreateOptions,
  ): readonly CommitOperationInput[] {
    if (commitOptions.operations.length === 0) {
      throw new AbloValidationError(
        'Commit requires a non-empty `operations` array.',
        { code: 'commit_operation_required' },
      );
    }
    return commitOptions.operations.map((op) =>
      normalizeCommitOperation(op, commitOptions),
    );
  }

  async function listClaimState(
    target?: Partial<ModelTarget>,
  ): Promise<{ active: readonly ModelClaim[]; queue: readonly ModelClaim[] }> {
    const params = new URLSearchParams();
    if (target?.model) params.set('model', target.model);
    if (target?.id) params.set('id', target.id);
    if (target?.field) params.set('field', target.field);

    const suffix = params.toString();
    const body = await requestJson<ClaimListResponse>(
      `/v1/claims${suffix ? `?${suffix}` : ''}`,
      { method: 'GET' },
    );
    return {
      active: body.claims ?? [],
      queue: body.queue ?? [],
    };
  }

  async function applyClaimedPolicy(
    target: Partial<ModelTarget>,
    options?: ClaimedOptions,
    defaultPolicy: ClaimedOptions['ifClaimed'] = 'return',
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
        },
        'commits.create',
      );
      const clientTxId = createClientTxId(commitOptions.idempotencyKey);
      // Same claim vocabulary as the WS client's `commits.create`: a handle
      // supplies the batch stale-guard defaults; explicit options win.
      const claim = commitOptions.claim ?? null;
      const operations = normalizeCommitOperations({
        ...commitOptions,
        readAt: commitOptions.readAt ?? claim?.readAt ?? null,
        onStale:
          commitOptions.onStale ?? (claim?.readAt !== undefined ? 'reject' : null),
      });
      const requestBody = {
        operations,
        reads: commitOptions.reads,
      };
      let body: CommitResponse;
      try {
        body = await dispatchHttpCommit({
          path: '/v1/commits',
          method: 'POST',
          idempotencyKey: clientTxId,
          body: requestBody,
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
          })),
        );
        throw error;
      }

      // `requestJson` throws via `translateHttpError` on any non-2xx,
      // so reaching here implies success. Narrow `status` to the
      // `CommitWait`-compatible subset; `'rejected'` only appears on
      // the rejection body (already thrown).
      const status: 'queued' | 'confirmed' =
        body.status === 'queued' ? 'queued' : 'confirmed';
      return {
        id: body.id ?? body.clientTxId,
        status,
        lastSyncId: body.lastSyncId,
        ...(body.notifications && body.notifications.length > 0
          ? { notifications: body.notifications }
          : {}),
        ...(body.missingIds && body.missingIds.length > 0
          ? { missingIds: body.missingIds }
          : {}),
      };
    },
  };

  async function listModel<T>(
    modelName: string,
    options?: ServerReadOptions<T>,
  ): Promise<T[]> {
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
    const res = await requestJson<{ data?: T[] }>(
      `/v1/models/${encodeURIComponent(modelName)}${qs ? `?${qs}` : ''}`,
      { method: 'GET' },
    );
    return res.data ?? [];
  }

  async function retrieveModel<T>(
    modelName: string,
    params: ModelReadOptions & { readonly id: string },
  ): Promise<HttpTransportRead<T>> {
    await applyClaimedPolicy({ model: modelName, id: params.id }, params);

    const query = await requestJson<QueryResponse>(
      `/v1/models/${encodeURIComponent(modelName)}/${encodeURIComponent(params.id)}`,
      {
        method: 'GET',
      },
    );

    // A miss is `data: undefined`, not a thrown error. The WebSocket client's
    // `retrieve` returns `T | undefined` for a missing row; throwing only here
    // made the obvious read ("does this row exist?") a hard edge that an agent
    // had to wrap in try/catch. Both transports agree: an absent row means absent
    // data. Callers branch on `.data` (the documented `.data?.x` usage).
    // Normalize a miss to `undefined` (the server may send `null` or omit it).
    const data = (query.data ?? undefined) as T | undefined;

    return {
      data,
      stamp: query.stamp ?? 0,
      claims: query.claims ?? [],
    };
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
    beforeSettlement?: (response: CommitResponse) => Promise<void>,
  ): Promise<CommitReceipt> {
    assertWriteOptions(
      options && {
        idempotencyKey: options.idempotencyKey,
        readAt: options.readAt,
        onStale: options.onStale,
        wait: options.wait,
        claim: options.claim,
      },
      `${modelName} ${action}`,
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
      onStale:
        options?.onStale ?? (claimHandle?.readAt !== undefined ? 'reject' : undefined),
      readAt,
    };
    if (action === 'create') requestBody.id = id;
    if (data !== undefined) requestBody.data = data;

    let body: CommitResponse;
    try {
      body = await dispatchHttpCommit({
        path,
        method,
        idempotencyKey: clientTxId,
        body: requestBody,
      }, beforeSettlement);
    } catch (error) {
      // The per-model write door (`ablo.<model>.update/create/delete`). Capture
      // coordination collisions here too; this single row is the fallback target.
      recordCoordinationConflict(error, clientTxId, [{ model: modelName, id }]);
      throw error;
    }

    // `requestJson` throws via `translateHttpError` on any non-2xx, so reaching
    // here implies success. Narrow `status` to the `CommitWait`-compatible
    // subset; `'rejected'` only appears on a thrown rejection body.
    const status: 'queued' | 'confirmed' = body.status === 'queued' ? 'queued' : 'confirmed';
    return {
      id: body.serverTxId,
      status,
      lastSyncId: body.lastSyncId,
    };
  }

  function model<T = Record<string, unknown>>(name: string): HttpTransportModel<T> {
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
    const claimMeta = (options: ClaimOptions<T> | undefined): Record<string, unknown> | undefined => {
      if (!options?.description) return options?.meta;
      return { ...(options.meta ?? {}), description: options.description };
    };
    const acquireClaim = async (params: ClaimParams<T>): Promise<string> => {
      const body = await requestJson<{
        id?: string;
        claim?: { id?: string };
        claimId?: string;
        status?: 'queued';
        position?: number;
      }>(claimPath(params.id), {
        method: 'POST',
        body: JSON.stringify({
          reason: params.reason ?? 'editing',
          ...(params.ttl !== undefined ? { ttl: params.ttl } : {}),
          ...(params.description !== undefined ? { description: params.description } : {}),
          ...(claimMeta(params) ? { meta: claimMeta(params) } : {}),
          // `queue` (default true) → queue behind the holder; false → fail-fast
          // with AbloClaimedError (work-distribution dedup).
          queue: params.queue ?? true,
        }),
      });
      if (body.status === 'queued') {
        throw new AbloClaimedError(
          `Target ${name}/${params.id} is held; queued at position ${body.position ?? 0}. ` +
            `The HTTP client cannot await the grant without a WebSocket.`,
          { code: 'claim_queued' },
        );
      }
      // `claimId` is the field name the queued response uses; check it alongside
      // the other id shapes the response may carry.
      return body.claim?.id ?? body.id ?? body.claimId ?? createClaimId();
    };
    const releaseClaim = (params: ClaimLookupParams<T> | Claim<T>): Promise<void> =>
      requestJson<unknown>(
        claimPath(isClaimHandle(params) ? params.target.id : params.id),
        { method: 'DELETE' },
      ).then(() => undefined);

    // One beat on the held lease. A lapsed lease answers `claim_lost`
    // (409), which the wire error mapping surfaces as AbloClaimedError —
    // the definitive signal that stops the auto-heartbeat loop.
    const heartbeatClaim = async (
      id: string,
      claimId: string,
      options: ClaimHeartbeatOptions,
    ): Promise<ClaimHeartbeat> => {
      const reply = await requestJson<HeartbeatReply>(
        `${claimPath(id)}/heartbeat`,
        {
          method: 'POST',
          body: JSON.stringify({
            claimId,
            ...(options.ttl !== undefined ? { ttl: options.ttl } : {}),
            ...(options.details !== undefined ? { details: options.details } : {}),
          }),
        },
      );
      return heldHeartbeatReply(reply, `claim ${claimId} on ${name}/${id}`);
    };

    async function claimImpl(params: ClaimParams<T>): Promise<HeldClaim<T>> {
      const claimId = await acquireClaim(params);
      observability?.captureClaim({
        phase: 'acquired',
        claimId,
        model: name,
        id: params.id,
        ...(params.field ? { field: params.field } : {}),
        reason: params.reason ?? 'editing',
      });
      const { data, stamp } = await retrieveModel<T>(name, { id: params.id });
      // A held claim hands back a snapshot; the typed `HeldClaim.data` is `T`.
      // `retrieve` now reports a miss as `undefined` rather than throwing, but a
      // claim on a row that doesn't exist has nothing to hold — surface it.
      if (data === undefined) {
        throw new AbloNotFoundError(
          `Cannot claim ${name}/${params.id}: it does not exist (or is outside this credential's scope).`,
          [params.id],
        );
      }
      const heartbeat = async (
        beatOptions?: Duration | ClaimHeartbeatOptions,
      ): Promise<ClaimHeartbeat> => {
        const resolved = resolveHeartbeatOptions(beatOptions);
        const beat = await heartbeatClaim(params.id, claimId, {
          ttl: resolved.ttl ?? params.ttl,
          ...(resolved.details !== undefined
            ? { details: resolved.details }
            : {}),
        });
        params.onHeartbeat?.(beat);
        return beat;
      };

      // Opt-in auto-heartbeat — the background-worker cadence. The stateless
      // HTTP claim defaults to the server's 60s acquire window when no TTL
      // was requested, so the default cadence lands at 20s beats.
      const stopHeartbeatLoop = params.heartbeat
        ? startClaimHeartbeatLoop({
            beat: () => heartbeat(),
            intervalMs: heartbeatCadenceMs(
              params.ttl !== undefined ? toMs(params.ttl) : 60_000,
              params.heartbeat,
            ),
            ...(params.onHeartbeatLost
              ? { onLost: params.onHeartbeatLost }
              : {}),
          })
        : undefined;

      const release = () => {
        stopHeartbeatLoop?.();
        return releaseClaim(params);
      };
      return {
        object: 'claim',
        id: claimId,
        readAt: stamp,
        target: {
          type: name,
          id: params.id,
          ...(params.field ? { field: params.field } : {}),
          ...(params.path ? { path: params.path } : {}),
          ...(params.range ? { range: params.range } : {}),
          ...(claimMeta(params) ? { meta: claimMeta(params) } : {}),
        },
        reason: params.reason ?? 'editing',
        ...(params.description ? { description: params.description } : {}),
        data,
        release,
        revoke: () => {
          void release().catch(() => {});
        },
        heartbeat,
        [Symbol.asyncDispose]: release,
      };
    }
    const claimsForEntity = async (params: ClaimLookupParams<T>): Promise<{ claims?: ModelClaim[]; queue?: ModelClaim[] }> =>
      requestJson<{ claims?: ModelClaim[]; queue?: ModelClaim[] }>(
        `/v1/claims?model=${encodeURIComponent(name)}&id=${encodeURIComponent(params.id)}${
          params.field ? `&field=${encodeURIComponent(params.field)}` : ''
        }`,
        { method: 'GET' },
      );
    const claim = Object.assign(claimImpl, {
      release: releaseClaim,
      state: async (params: ClaimLookupParams<T>): Promise<Claim | null> => {
        const res = await claimsForEntity(params);
        const first = res.claims?.[0];
        return first ? claimFromModelClaim(first) : null;
      },
      queue: async (
        params: ClaimLookupParams<T>,
      ): Promise<{ readonly object: 'list'; readonly data: readonly Claim[] }> => {
        const res = await claimsForEntity(params);
        return {
          object: 'list',
          data: (res.queue ?? []).map(claimFromModelClaim),
        };
      },
      reorder: async (params: ClaimReorderParams<T>): Promise<void> => {
        await requestJson<unknown>(`${claimPath(params.id)}/reorder`, {
          method: 'POST',
          // The reorder route's payload is `{ heldBy, claimId }[]` — a Claim's id
          // is the claimId.
          body: JSON.stringify({ order: params.order.map((i) => ({ heldBy: i.heldBy, claimId: i.id })) }),
        });
      },
    }) as HttpClaimApi<T>;

    const withMutationClaim = async <R>(
      id: string,
      input: ModelMutationOptions | undefined,
      run: (options: ModelMutationOptions | undefined) => Promise<R>,
    ): Promise<R> => {
      const claimInput = input?.claim;
      if (!claimInput) return run(input);

      if (isClaimHandle(claimInput)) {
        return run({ ...input, claimRef: { id: claimInput.id }, claim: undefined });
      }

      // `isClaimHandle` ruled out the handle form above; the generic mismatch
      // (the union carries `Claim`, the guard narrows `Claim<T>`) keeps the
      // compiler from subtracting it, so narrow to the inline-options form.
      const claimId = await acquireClaim({
        id,
        ...(claimInput as ClaimOptions<T>),
      });
      try {
        return await run({ ...input, claimRef: { id: claimId }, claim: undefined });
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
      params: ModelMutationOptions & { readonly id: string; readonly data: Record<string, unknown> },
    ): Promise<CommitReceipt>;
    function updateModel(
      id: string,
      updater: ModelUpdater<T>,
      options?: ContentionOptions,
    ): Promise<CommitReceipt | undefined>;
    function updateModel(
      arg:
        | (ModelMutationOptions & { readonly id: string; readonly data: Record<string, unknown> })
        | string,
      updater?: ModelUpdater<T>,
      contention?: ContentionOptions,
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
            { code: 'write_options_invalid' },
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
              wait: 'confirmed',
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
      retrieve(params: ModelReadOptions & { readonly id: string }): Promise<HttpTransportRead<T>> {
        return retrieveModel<T>(name, params);
      },
      list(options?: ServerReadOptions<T>): Promise<T[]> {
        return listModel<T>(name, options);
      },
      async create(
        params: ModelMutationOptions & { readonly data: Record<string, unknown>; readonly id?: string | null },
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
            {
              ...options,
              wait: options?.wait ?? 'confirmed',
            },
            async () => {
              const read = await retrieveModel<T>(name, { id });
              if (read.data === undefined) {
                throw new AbloNotFoundError(
                  `create ${name}/${id} did not yield a readable row (the write did not confirm).`,
                  [id],
                );
              }
              created = read.data;
            },
          );
          if (created === undefined) {
            throw new AbloConnectionError('Create settlement did not return its row.', {
              code: 'commit_no_result',
            });
          }
          return created;
        });
      },
      update: updateModel,
      async delete(
        params: ModelMutationOptions & { readonly id: string },
      ): Promise<CommitReceipt> {
        return withMutationClaim(params.id, params, async (options) => {
          await applyClaimedPolicy({ model: name, id: params.id }, options);
          return mutateModel('delete', name, params.id, undefined, options);
        });
      },
    };
  }

  return {
    ready,
    waitForFlush: () =>
      runInHttpCommitLane(async () => {
        await ready();
        await replayHttpCommitOutbox();
      }),
    async dispose() {},
    async purge() {},
    commits,
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
            { code: 'apikey_missing' },
          );
        }
        return mintSession(params, {
          apiKey,
          baseUrl: apiBaseUrl,
          ...(options.fetch ? { fetch: options.fetch } : {}),
          ...(options.modelTypenames
            ? { modelTypenames: options.modelTypenames }
            : {}),
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
  claim: string | { readonly id: string } | null | undefined,
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
