/**
 * Stateless API client for `Ablo({ apiKey })`.
 *
 * This is the hosted-API product surface: no schema, no object pool, no
 * IndexedDB, no WebSocket. It maps the public Model / Claim / Commit
 * nouns directly to HTTP routes on sync-server.
 */

import {
  AbloClaimedError,
  AbloAuthenticationError,
  AbloConnectionError,
  AbloValidationError,
  formatClaimedErrorMessage,
  claimedError,
  translateHttpError,
} from '../errors.js';
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
import { toSeconds } from '../utils/duration.js';
import type {
  AbloOptions,
  ClaimedOptions,
  CommitCreateOptions,
  CommitOperationInput,
  CommitReceipt,
  CommitResource,
  ClaimCreateOptions,
  ClaimWaitOptions,
  HttpClaimApi,
  ModelClient,
  ModelClaim,
  ModelMutationOptions,
  ModelReadOptions,
  ModelRead,
  ModelTarget,
  CreateSessionParams,
  AbloSession,
} from './Ablo.js';
import { mintSession } from './sessionMint.js';
import type { SchemaRecord } from '../schema/schema.js';
import type {
  ClaimLookupParams,
  ClaimOptions,
  ClaimParams,
  ClaimReorderParams,
  ServerReadOptions,
} from './createModelProxy.js';
import type { Duration } from '../utils/duration.js';
import type { Claim, HeldClaim } from '../types/streams.js';
import { assertWriteOptions } from './writeOptionsSchema.js';

export type AbloApiClientOptions = Omit<AbloOptions, 'schema'> & {
  readonly schema?: null | undefined;
  readonly bootstrapBaseUrl?: string | undefined;
};

export interface AbloApiClaims {
  create(options: ClaimCreateOptions): Promise<Claim>;
  list(target?: Partial<ModelTarget>): Promise<readonly ModelClaim[]>;
  waitFor(target: Partial<ModelTarget>, options?: ClaimWaitOptions): Promise<void>;
}

export type CapabilityParticipantKind = 'agent' | 'system';

export interface CapabilityCreateBaseOptions {
  readonly participantKind?: CapabilityParticipantKind;
  readonly participantId?: string;
  readonly syncGroups: readonly string[];
  readonly operations: readonly string[];
  readonly label?: string;
  readonly wideScope?: boolean;
  readonly userMeta?: Record<string, unknown>;
}

export interface CapabilityCreateOptions extends CapabilityCreateBaseOptions {
  /**
   * Preferred public name. A capability is a lease; the SDK and server
   * clean it up when the run finishes or when the lease expires.
   */
  readonly lease?: Duration;
  readonly leaseSeconds?: number;
  /** @deprecated Use `lease`. */
  readonly ttl?: Duration;
  /** @deprecated Use `leaseSeconds`. */
  readonly ttlSeconds?: number;
}

export interface CapabilityScope {
  readonly organizationId: string;
  readonly syncGroups: readonly string[];
  readonly operations: readonly string[];
  readonly participantKind: CapabilityParticipantKind;
  readonly participantId: string;
}

export interface Capability {
  readonly id: string;
  readonly token: string;
  readonly expiresAt: string;
  readonly organizationId: string;
  readonly scope: CapabilityScope;
  readonly userMeta?: Record<string, unknown>;
  client(): AbloApi;
}

export interface CapabilityRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly participantKind: CapabilityParticipantKind;
  readonly participantId: string;
  readonly label: string | null;
  readonly status: 'active' | 'expired' | 'revoked';
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly lastUsedAt: string | null;
  readonly operations: readonly string[];
  readonly syncGroups: readonly string[];
}

export interface CapabilityRevocation {
  readonly id: string;
  readonly deleted: boolean;
  readonly activeSessionsClosed?: number;
}

export interface CapabilityRotateOptions {
  /**
   * Overlap window — the OLD token keeps authenticating for this long after
   * rotation, so you can deploy the replacement with zero downtime. Default
   * 24h server-side.
   */
  readonly grace?: Duration;
  readonly graceSeconds?: number;
  /**
   * Lifetime of the REPLACEMENT capability. Omit to inherit the original's
   * lifetime.
   */
  readonly lease?: Duration;
  readonly leaseSeconds?: number;
}

/** The fresh capability returned by `rotate`, plus a pointer to the old one. */
export interface RotatedCapability extends Capability {
  /**
   * The capability that was rotated out. Its token keeps working until
   * `expiresAt` (the end of the grace window), then expires.
   */
  readonly rotatedFrom: {
    readonly id: string;
    readonly expiresAt: string;
  };
}

export interface CapabilityResource {
  create(options: CapabilityCreateOptions): Promise<Capability>;
  retrieve(id: string): Promise<CapabilityRecord>;
  revoke(id: string): Promise<CapabilityRevocation>;
  /**
   * Rotate with overlap (Stripe's "roll" model): mint a fresh capability
   * carrying the SAME scope, and keep the old token working for a grace
   * window so you can roll out the replacement without downtime.
   */
  rotate(id: string, options?: CapabilityRotateOptions): Promise<RotatedCapability>;
  /**
   * Alias for `create`. Kept because "mint" is common capability-token
   * language, but `create` is the canonical SDK verb.
   */
  mint(options: CapabilityCreateOptions): Promise<Capability>;
}

// NOTE: end-user / agent session minting is `ablo.sessions.create(...)` (typed
// against the schema, see Ablo.ts `CreateSessionParams`). There is no separate
// `ephemeralKeys` resource — `sessions` is the one front door for both.

export interface AbloApi {
  ready(): Promise<void>;
  waitForFlush(): Promise<void>;
  dispose(): Promise<void>;
  purge(): Promise<void>;
  readonly capabilities: CapabilityResource;
  readonly claims: AbloApiClaims;
  readonly commits: CommitResource;
  model<T = Record<string, unknown>>(name: string): ModelClient<T>;
  /**
   * Resolve the active bearer credential this client authenticates with — the
   * same token its own requests carry in `Authorization`. Returns `null` when
   * no credential is configured. Async because the API key may be supplied as
   * an async setter. Use it to authenticate a side-band request to the same
   * server with the credential this client already holds — no re-mint.
   */
  getAuthToken(): Promise<string | null>;
  /**
   * Mint a short-lived scoped session — the Stripe `ephemeralKeys.create` shape.
   * Minting is a control-plane HTTP call (no socket), so it lives on this stateless
   * client too, not only the realtime one. `{ user }` → `ek_`, `{ agent, can }` → `rk_`.
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

interface CommitResponse {
  readonly object?: 'commit_receipt';
  readonly id?: string;
  readonly clientTxId?: string;
  readonly serverTxId?: string;
  readonly status?: 'queued' | 'confirmed' | 'rejected';
  readonly success?: boolean;
  readonly lastSyncId?: number;
  readonly ops?: number;
  /** Ids of UPDATE/DELETE targets that matched zero rows (loud 0-row writes). */
  readonly missingIds?: readonly string[];
}

interface ClaimListResponse {
  readonly claims?: readonly ModelClaim[];
  readonly queue?: readonly ModelClaim[];
}

interface ClaimCreateResponse {
  readonly claim?: ModelClaim;
  /** Present (with HTTP 202) when `queue` was set and the target was held. */
  readonly status?: 'queued';
  readonly claimId?: string;
  readonly position?: number;
}

interface CapabilityCreateResponse {
  readonly capabilityId?: string;
  readonly id?: string;
  readonly token: string;
  readonly expiresAt: string;
  readonly organizationId: string;
  readonly scope: CapabilityScope;
  readonly userMeta?: Record<string, unknown>;
}

interface CapabilityRotateResponse {
  readonly capabilityId?: string;
  readonly id?: string;
  readonly token: string;
  /** Restricted keys (the only kind this route rotates) always carry an expiry. */
  readonly expiresAt: string;
  readonly organizationId: string;
  readonly scope: CapabilityScope;
  readonly rotatedFrom: {
    readonly capabilityId?: string;
    readonly id?: string;
    readonly expiresAt: string;
  };
}

interface CapabilityRetrieveResponse {
  readonly capabilityId?: string;
  readonly id?: string;
  readonly organizationId: string;
  readonly participantKind: CapabilityParticipantKind;
  readonly participantId: string;
  readonly label: string | null;
  readonly status: 'active' | 'expired' | 'revoked';
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly lastUsedAt: string | null;
  readonly operations?: readonly string[];
  readonly syncGroups?: readonly string[];
}

interface CapabilityRevokeResponse {
  readonly id?: string;
  readonly capabilityId?: string;
  readonly deleted?: boolean;
  readonly activeSessionsClosed?: number;
}

const DEFAULT_AGENT_LEASE: Duration = '10m';

export function createProtocolClient(options: AbloApiClientOptions): AbloApi {
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

  let readyPromise: Promise<void> | null = null;

  async function ready(): Promise<void> {
    if (readyPromise) return readyPromise;

    readyPromise = (async () => {
      if (!configuredDatabaseUrl) return;
      await registerDataSource({
        baseUrl: apiBaseUrl,
        apiKey: await resolveApiKeyValue(configuredApiKey),
        databaseUrl: configuredDatabaseUrl,
        ...(options.fetch ? { fetchImpl: options.fetch } : {}),
      });
    })();

    try {
      await readyPromise;
    } catch (error) {
      readyPromise = null;
      throw error;
    }
  }

  async function authHeaders(): Promise<Record<string, string>> {
    const apiKey = await resolveApiKeyValue(configuredApiKey);
    const token = apiKey ?? configuredAuthToken;
    if (!token) {
      throw new AbloAuthenticationError(
        'Ablo({ apiKey }) requires an API key. Pass `apiKey` or set ABLO_API_KEY.',
        { code: 'api_key_required' },
      );
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };

    for (const [key, value] of Object.entries(options.defaultHeaders ?? {})) {
      if (value == null) {
        delete headers[key];
      } else {
        headers[key] = value;
      }
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

  async function requestJson<T>(
    path: string,
    init: RequestInit & { readonly idempotencyKey?: string | null },
  ): Promise<T> {
    await ready();
    const { idempotencyKey, ...requestInit } = init;
    const headers = await authHeaders();
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    const res = await fetchImpl(endpoint(path), {
      ...requestInit,
      headers: {
        ...headers,
        ...(requestInit.headers as Record<string, string> | undefined),
      },
    });

    const bodyText = await res.text();
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

  function createModelId(): string {
    return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `id_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function childClient(authToken: string): AbloApi {
    return createProtocolClient({
      ...options,
      apiKey: null,
      authToken,
      schema: null,
    });
  }

  function normalizeCommitOperation(
    op: CommitOperationInput,
    defaults: Pick<CommitCreateOptions, 'readAt' | 'onStale'>,
  ): CommitOperationInput {
    const model = op.model ?? op.target?.model;
    if (!model) {
      throw new AbloValidationError(
        'Commit operation requires `model` or `target.model`.',
        { code: 'commit_operation_model_required' },
      );
    }

    const id = op.id ?? op.target?.id ?? null;
    return {
      action: op.action,
      model,
      id,
      data: op.data ?? null,
      transactionId: op.transactionId ?? null,
      readAt: op.readAt ?? defaults.readAt ?? null,
      onStale: op.onStale ?? defaults.onStale ?? null,
    };
  }

  function normalizeCommitOperations(
    commitOptions: CommitCreateOptions,
  ): readonly CommitOperationInput[] {
    if (commitOptions.operation && commitOptions.operations) {
      throw new AbloValidationError(
        'Pass either `operation` or `operations`, not both.',
        { code: 'commit_operations_ambiguous' },
      );
    }
    const inputOperations = commitOptions.operation
      ? [commitOptions.operation]
      : commitOptions.operations ?? [];
    if (inputOperations.length === 0) {
      throw new AbloValidationError(
        'Commit requires at least one operation.',
        { code: 'commit_operation_required' },
      );
    }
    return inputOperations.map((op) => normalizeCommitOperation(op, commitOptions));
  }

  async function listClaims(
    target?: Partial<ModelTarget>,
  ): Promise<readonly ModelClaim[]> {
    const state = await listClaimState(target);
    return state.active;
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

  function delay(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(
        new AbloConnectionError('Claim wait aborted.', {
          code: 'claim_wait_aborted',
          cause: signal.reason,
        }),
      );
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(done, ms);

      function cleanup(): void {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
      }

      function done(): void {
        cleanup();
        resolve();
      }

      function onAbort(): void {
        cleanup();
        reject(
          new AbloConnectionError('Claim wait aborted.', {
            code: 'claim_wait_aborted',
            cause: signal?.reason,
          }),
        );
      }

      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async function waitForNoClaims(
    target: Partial<ModelTarget>,
    options?: ClaimWaitOptions,
  ): Promise<void> {
    const startedAt = Date.now();
    const pollInterval = options?.pollInterval;

    for (;;) {
      const claims = await listClaims(target);
      if (claims.length === 0) return;

      if (pollInterval == null) {
        throw new AbloValidationError(
          'Cannot wait for claims over the HTTP client without `pollInterval`. ' +
            'Use the schema client for event-driven claim waits, pass `ifClaimed: "return"`, ' +
            'or provide an explicit poll interval for this runtime.',
          { code: 'claim_wait_poll_interval_required' },
        );
      }

      if (options?.timeout != null && Date.now() - startedAt >= options.timeout) {
        throw claimedError(target, claims, 'model_claimed_timeout');
      }

      const remaining =
        options?.timeout == null
          ? pollInterval
          : Math.max(0, Math.min(pollInterval, options.timeout - (Date.now() - startedAt)));
      await delay(remaining, options?.signal);
    }
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
      const body = await requestJson<CommitResponse>('/v1/commits', {
        method: 'POST',
        idempotencyKey: clientTxId,
        body: JSON.stringify({
          clientTxId,
          idempotencyKey: clientTxId,
          claim: normalizeClaimId(commitOptions.claimRef) ?? claim?.id,
          operations,
        }),
      });

      // `requestJson` throws via `translateHttpError` on any non-2xx,
      // so reaching here implies success. Narrow `status` to the
      // `CommitWait`-compatible subset; `'rejected'` only appears on
      // the rejection body (already thrown).
      const status: 'queued' | 'confirmed' =
        body.status === 'queued' ? 'queued' : 'confirmed';
      return {
        id: body.id ?? body.clientTxId ?? clientTxId,
        status,
        lastSyncId: body.lastSyncId,
        ...(body.missingIds && body.missingIds.length > 0
          ? { missingIds: body.missingIds }
          : {}),
      };
    },
  };

  const capabilities: CapabilityResource = {
    async create(capabilityOptions: CapabilityCreateOptions): Promise<Capability> {
      const ttlSeconds =
        capabilityOptions.ttlSeconds ??
        capabilityOptions.leaseSeconds ??
        toSeconds(capabilityOptions.ttl ?? capabilityOptions.lease ?? DEFAULT_AGENT_LEASE);
      const body = await requestJson<CapabilityCreateResponse>('/v1/capabilities', {
        method: 'POST',
        body: JSON.stringify({
          participantKind: capabilityOptions.participantKind ?? 'agent',
          participantId: capabilityOptions.participantId,
          syncGroups: capabilityOptions.syncGroups,
          operations: capabilityOptions.operations,
          ttlSeconds,
          label: capabilityOptions.label,
          wideScope: capabilityOptions.wideScope,
          userMeta: capabilityOptions.userMeta,
        }),
      });
      const id = body.capabilityId ?? body.id;
      if (!id) {
        throw new AbloValidationError(
          'Capability create response did not include an id.',
          { code: 'capability_id_missing' },
        );
      }

      return {
        id,
        token: body.token,
        expiresAt: body.expiresAt,
        organizationId: body.organizationId,
        scope: body.scope,
        userMeta: body.userMeta,
        client: () => childClient(body.token),
      };
    },

    async retrieve(id: string): Promise<CapabilityRecord> {
      const body = await requestJson<CapabilityRetrieveResponse>(
        `/v1/capabilities/${encodeURIComponent(id)}`,
        { method: 'GET' },
      );
      return {
        id: body.capabilityId ?? body.id ?? id,
        organizationId: body.organizationId,
        participantKind: body.participantKind,
        participantId: body.participantId,
        label: body.label,
        status: body.status,
        issuedAt: body.issuedAt,
        expiresAt: body.expiresAt,
        revokedAt: body.revokedAt,
        lastUsedAt: body.lastUsedAt,
        operations: body.operations ?? [],
        syncGroups: body.syncGroups ?? [],
      };
    },

    async revoke(id: string): Promise<CapabilityRevocation> {
      const body = await requestJson<CapabilityRevokeResponse>(
        `/v1/capabilities/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
      return {
        id: body.capabilityId ?? body.id ?? id,
        deleted: body.deleted ?? true,
        activeSessionsClosed: body.activeSessionsClosed,
      };
    },

    async rotate(
      id: string,
      rotateOptions: CapabilityRotateOptions = {},
    ): Promise<RotatedCapability> {
      const graceSeconds =
        rotateOptions.graceSeconds ??
        (rotateOptions.grace !== undefined ? toSeconds(rotateOptions.grace) : undefined);
      const leaseSeconds =
        rotateOptions.leaseSeconds ??
        (rotateOptions.lease !== undefined ? toSeconds(rotateOptions.lease) : undefined);
      const body = await requestJson<CapabilityRotateResponse>(
        `/v1/capabilities/${encodeURIComponent(id)}/rotate`,
        {
          method: 'POST',
          body: JSON.stringify({
            ...(graceSeconds !== undefined ? { graceSeconds } : {}),
            ...(leaseSeconds !== undefined ? { ttlSeconds: leaseSeconds } : {}),
          }),
        },
      );
      const newId = body.capabilityId ?? body.id;
      if (!newId) {
        throw new AbloValidationError(
          'Capability rotate response did not include an id.',
          { code: 'capability_id_missing' },
        );
      }
      return {
        id: newId,
        token: body.token,
        expiresAt: body.expiresAt,
        organizationId: body.organizationId,
        scope: body.scope,
        rotatedFrom: {
          id: body.rotatedFrom.capabilityId ?? body.rotatedFrom.id ?? id,
          expiresAt: body.rotatedFrom.expiresAt,
        },
        client: () => childClient(body.token),
      };
    },

    mint(options: CapabilityCreateOptions): Promise<Capability> {
      return capabilities.create(options);
    },
  };


  const claims: AbloApiClaims = {
    async create(claimOptions: ClaimCreateOptions): Promise<Claim> {
      const claimId = createClaimId();
      const body = await requestJson<ClaimCreateResponse>('/v1/claims', {
        method: 'POST',
        body: JSON.stringify({
          claimId,
          target: claimOptions.target,
          reason: claimOptions.reason,
          ttl: claimOptions.ttl,
          queue: claimOptions.queue,
        }),
      });
      // The fair-queue grant is PUSHED over a WebSocket (`claim_granted`),
      // which this stateless HTTP client doesn't hold. Returning a handle here
      // would be a phantom holder — a lease we can't confirm is ours. So a
      // queued response is surfaced as a typed claimed signal; callers that need
      // to *wait* in line use the realtime (WS-backed) `ablo.<model>.claim`.
      if (body.status === 'queued') {
        throw new AbloClaimedError(
          `Target ${claimOptions.target.model}/${claimOptions.target.id} is held; ` +
            `queued at position ${body.position ?? 0}. The HTTP client can't await ` +
            `the grant (no socket) — use the realtime client to wait in line.`,
          { code: 'claim_queued' },
        );
      }
      const id = body.claim?.id ?? claimId;
      let released = false;

      const release = async (): Promise<void> => {
        if (released) return;
        released = true;
        await requestJson<{ ok: true }>(
          `/v1/claims/${encodeURIComponent(id)}`,
          { method: 'DELETE' },
        );
      };

      return {
        object: 'claim',
        id,
        reason: claimOptions.reason,
        target: {
          type: claimOptions.target.model,
          id: claimOptions.target.id,
          ...(claimOptions.target.field ? { field: claimOptions.target.field } : {}),
          ...(claimOptions.target.path ? { path: claimOptions.target.path } : {}),
          ...(claimOptions.target.range ? { range: claimOptions.target.range } : {}),
          ...(claimOptions.target.meta ? { meta: claimOptions.target.meta } : {}),
        },
        release,
        revoke: () => {
          void release().catch(() => {});
        },
        [Symbol.asyncDispose]: release,
      };
    },

    list: listClaims,
    waitFor(target: Partial<ModelTarget>, options?: ClaimWaitOptions): Promise<void> {
      return waitForNoClaims(target, options);
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
  ): Promise<ModelRead<T>> {
    await applyClaimedPolicy({ model: modelName, id: params.id }, params);

    const query = await requestJson<QueryResponse>(
      `/v1/models/${encodeURIComponent(modelName)}/${encodeURIComponent(params.id)}`,
      {
        method: 'GET',
      },
    );

    const data = query.data as T | undefined;
    if (!data) {
      throw new AbloValidationError(
        `Model row not found: ${modelName}/${params.id}`,
        { code: 'model_not_found' },
      );
    }

    return {
      data,
      stamp: query.stamp ?? 0,
      claims: query.claims ?? [],
    };
  }

  /**
   * Single-op mutation over the model-scoped routes — the canonical surface
   * that mirrors `ablo.<model>.create/update/delete`:
   *
   *   POST   /v1/models/:model        create
   *   PATCH  /v1/models/:model/:id     update
   *   DELETE /v1/models/:model/:id     delete
   *
   * This replaces the previous indirection through `POST /v1/commits`. The raw
   * `commits.create(...)` resource is still the path for ATOMIC MULTI-OP
   * envelopes — this helper is the one-op, one-record path only.
   */
  async function mutateModel(
    action: 'create' | 'update' | 'delete',
    modelName: string,
    id: string,
    data: Record<string, unknown> | undefined,
    options: ModelMutationOptions | undefined,
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
    const claimHandle =
      typeof options?.claim === 'object' &&
      options?.claim !== null &&
      (options.claim as { object?: unknown }).object === 'claim' &&
      typeof (options.claim as { id?: unknown }).id === 'string'
        ? (options.claim as Claim)
        : undefined;
    const readAt = options?.readAt ?? claimHandle?.readAt;
    const requestBody: Record<string, unknown> = {
      idempotencyKey: clientTxId,
      claim: normalizeClaimId(options?.claimRef) ?? claimHandle?.id,
      onStale:
        options?.onStale ?? (claimHandle?.readAt !== undefined ? 'reject' : undefined),
      readAt,
    };
    if (action === 'create') requestBody.id = id;
    if (data !== undefined) requestBody.data = data;

    const body = await requestJson<CommitResponse>(path, {
      method,
      idempotencyKey: clientTxId,
      body: JSON.stringify(requestBody),
    });

    // `requestJson` throws via `translateHttpError` on any non-2xx, so reaching
    // here implies success. Narrow `status` to the `CommitWait`-compatible
    // subset; `'rejected'` only appears on a thrown rejection body.
    const status: 'queued' | 'confirmed' = body.status === 'queued' ? 'queued' : 'confirmed';
    return {
      id: body.serverTxId ?? body.id ?? body.clientTxId ?? clientTxId,
      status,
      lastSyncId: body.lastSyncId,
    };
  }

  function model<T = Record<string, unknown>>(name: string): ModelClient<T> {
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
      return body.claim?.id ?? body.id ?? body.id ?? createClaimId();
    };
    const releaseClaim = (params: ClaimLookupParams<T> | Claim<T>): Promise<void> =>
      requestJson<unknown>(
        claimPath(isClaimHandle(params) ? params.target.id : params.id),
        { method: 'DELETE' },
      ).then(() => undefined);

    async function claimImpl(params: ClaimParams<T>): Promise<HeldClaim<T>> {
      const claimId = await acquireClaim(params);
      const { data, stamp } = await retrieveModel<T>(name, { id: params.id });
      const release = () => releaseClaim(params);
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
        [Symbol.asyncDispose]: release,
      };
    }
    const claimsForEntity = async (params: ClaimLookupParams<T>): Promise<{ claims?: Claim[]; queue?: Claim[] }> =>
      requestJson<{ claims?: Claim[]; queue?: Claim[] }>(
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
        return first ?? null;
      },
      queue: async (
        params: ClaimLookupParams<T>,
      ): Promise<{ readonly object: 'list'; readonly data: readonly Claim[] }> => {
        const res = await claimsForEntity(params);
        return { object: 'list', data: res.queue ?? [] };
      },
      reorder: async (params: ClaimReorderParams<T>): Promise<void> => {
        await requestJson<unknown>(`${claimPath(params.id)}/reorder`, {
          method: 'POST',
          // The reorder route's payload is `{ heldBy, claimId }[]` — Claim's id
          // IS the claimId.
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

      const claimId = await acquireClaim({ id, ...claimInput });
      try {
        return await run({ ...input, claimRef: { id: claimId }, claim: undefined });
      } finally {
        await releaseClaim({ id }).catch(() => {});
      }
    };

    return {
      claim,
      retrieve(params: ModelReadOptions & { readonly id: string }): Promise<ModelRead<T>> {
        return retrieveModel<T>(name, params);
      },
      list(options?: ServerReadOptions<T>): Promise<T[]> {
        return listModel<T>(name, options);
      },
      async create(
        params: ModelMutationOptions & { readonly data: Record<string, unknown>; readonly id?: string | null },
      ): Promise<CommitReceipt> {
        const id = params.id ?? createModelId();
        return withMutationClaim(id, params, async (options) => {
          await applyClaimedPolicy({ model: name, id }, options);
          return mutateModel('create', name, id, params.data, options);
        });
      },
      async update(
        params: ModelMutationOptions & { readonly id: string; readonly data: Record<string, unknown> },
      ): Promise<CommitReceipt> {
        return withMutationClaim(params.id, params, async (options) => {
          await applyClaimedPolicy({ model: name, id: params.id }, options);
          return mutateModel('update', name, params.id, params.data, options);
        });
      },
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
    async waitForFlush() {},
    async dispose() {},
    async purge() {},
    capabilities,
    claims,
    commits,
    model,
    sessions: {
      async create(params: CreateSessionParams<SchemaRecord>): Promise<AbloSession> {
        // Stateless mint: the configured key IS the control-plane credential here
        // (no startup `rk_` exchange runs on this client). Reuse the resolved base
        // URL + fetch; the shared `mintSession` owns the two server doors.
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
