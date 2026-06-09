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
} from './auth.js';
import { toSeconds } from '../utils/duration.js';
import type {
  AbloOptions,
  ClaimedOptions,
  CommitCreateOptions,
  CommitOperationInput,
  CommitReceipt,
  CommitResource,
  IntentCreateOptions,
  IntentHandle,
  IntentWaitOptions,
  HttpClaimApi,
  ModelClient,
  ModelClaim,
  ModelMutationOptions,
  ModelReadOptions,
  ModelRead,
  ModelTarget,
} from './Ablo.js';
import type {
  ClaimHandle,
  ClaimLookupParams,
  ClaimOptions,
  ClaimParams,
  ClaimReorderParams,
  ModelLoadOptions,
} from './createModelProxy.js';
import type { Duration } from '../utils/duration.js';
import type { Intent } from '../types/streams.js';
import { assertWriteOptions } from './writeOptionsSchema.js';

export type AbloApiClientOptions = Omit<AbloOptions, 'schema'> & {
  readonly schema?: null | undefined;
  readonly bootstrapBaseUrl?: string | undefined;
};

export interface AbloApiIntents {
  create(options: IntentCreateOptions): Promise<IntentHandle>;
  list(target?: Partial<ModelTarget>): Promise<readonly ModelClaim[]>;
  waitFor(target: Partial<ModelTarget>, options?: IntentWaitOptions): Promise<void>;
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
  readonly intents: AbloApiIntents;
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
}

interface IntentListResponse {
  readonly intents?: readonly ModelClaim[];
  readonly queue?: readonly ModelClaim[];
}

interface IntentCreateResponse {
  readonly intent?: ModelClaim;
  /** Present (with HTTP 202) when `queue` was set and the target was held. */
  readonly status?: 'queued';
  readonly intentId?: string;
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
  assertBrowserSafety({
    apiKey: configuredApiKey,
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

  function createIntentId(): string {
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

  async function listIntents(
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
    const body = await requestJson<IntentListResponse>(
      `/v1/intents${suffix ? `?${suffix}` : ''}`,
      { method: 'GET' },
    );
    return {
      active: body.intents ?? [],
      queue: body.queue ?? [],
    };
  }

  function claimedError(
    target: Partial<ModelTarget>,
    claims: readonly ModelClaim[],
    code: 'model_claimed' | 'model_claimed_timeout' | 'queue_too_deep',
  ): AbloClaimedError {
    const label = [target.model, target.id, target.field].filter(Boolean).join('/');
    const holder = claims[0];
    const suffix = holder
      ? ` held by ${holder.actor} (${holder.action})`
      : ' held by another participant';
    return new AbloClaimedError(
      `Model row is claimed: ${label || 'target'}${suffix}.`,
      { code, claims },
    );
  }

  function delay(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(
        new AbloConnectionError('Intent wait aborted.', {
          code: 'intent_wait_aborted',
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
          new AbloConnectionError('Intent wait aborted.', {
            code: 'intent_wait_aborted',
            cause: signal?.reason,
          }),
        );
      }

      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async function waitForNoIntents(
    target: Partial<ModelTarget>,
    options?: IntentWaitOptions,
  ): Promise<void> {
    const startedAt = Date.now();
    const pollInterval = options?.pollInterval;

    for (;;) {
      const intents = await listIntents(target);
      if (intents.length === 0) return;

      if (pollInterval == null) {
        throw new AbloValidationError(
          'Cannot wait for claims over the HTTP client without `pollInterval`. ' +
            'Use the schema client for event-driven claim waits, pass `ifClaimed: "return"`, ' +
            'or provide an explicit poll interval for this runtime.',
          { code: 'intent_wait_poll_interval_required' },
        );
      }

      if (options?.timeout != null && Date.now() - startedAt >= options.timeout) {
        throw claimedError(target, intents, 'model_claimed_timeout');
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

    const state = await listClaimState(target);
    if (state.active.length === 0) return;
    if (policy === 'fail') {
      throw claimedError(target, state.active, 'model_claimed');
    }
    if (
      options?.maxQueueDepth !== undefined &&
      state.queue.length >= options.maxQueueDepth
    ) {
      throw claimedError(target, state.active, 'queue_too_deep');
    }

    await waitForNoIntents(target, {
      timeout: options?.claimedTimeout,
      pollInterval: options?.claimedPollInterval,
    });
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
          intent: commitOptions.intent,
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
          intent: normalizeIntentId(commitOptions.intent) ?? claim?.claimId,
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


  const intents: AbloApiIntents = {
    async create(intentOptions: IntentCreateOptions): Promise<IntentHandle> {
      const intentId = createIntentId();
      const body = await requestJson<IntentCreateResponse>('/v1/intents', {
        method: 'POST',
        body: JSON.stringify({
          intentId,
          target: intentOptions.target,
          action: intentOptions.action,
          ttl: intentOptions.ttl,
          queue: intentOptions.queue,
        }),
      });
      // The fair-queue grant is PUSHED over a WebSocket (`intent_granted`),
      // which this stateless HTTP client doesn't hold. Returning a handle here
      // would be a phantom holder — a lease we can't confirm is ours. So a
      // queued response is surfaced as a typed claimed signal; callers that need
      // to *wait* in line use the realtime (WS-backed) `ablo.<model>.claim`.
      if (body.status === 'queued') {
        throw new AbloClaimedError(
          `Target ${intentOptions.target.model}/${intentOptions.target.id} is held; ` +
            `queued at position ${body.position ?? 0}. The HTTP client can't await ` +
            `the grant (no socket) — use the realtime client to wait in line.`,
          { code: 'intent_queued' },
        );
      }
      const id = body.intent?.id ?? intentId;
      let released = false;

      const release = async (): Promise<void> => {
        if (released) return;
        released = true;
        await requestJson<{ ok: true }>(
          `/v1/intents/${encodeURIComponent(id)}`,
          { method: 'DELETE' },
        );
      };

      return {
        id,
        release,
        revoke: () => {
          void release().catch(() => {});
        },
        [Symbol.asyncDispose]: release,
      };
    },

    list: listIntents,
    waitFor(target: Partial<ModelTarget>, options?: IntentWaitOptions): Promise<void> {
      return waitForNoIntents(target, options);
    },
  };

  async function listModel<T>(
    modelName: string,
    options?: ModelLoadOptions<T>,
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
        intent: options.intent,
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
      typeof (options.claim as { claimId?: unknown }).claimId === 'string'
        ? (options.claim as ClaimHandle)
        : undefined;
    const readAt = options?.readAt ?? claimHandle?.readAt;
    const requestBody: Record<string, unknown> = {
      idempotencyKey: clientTxId,
      intent: normalizeIntentId(options?.intent) ?? claimHandle?.claimId,
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
    const isClaimHandle = (value: unknown): value is ClaimHandle<T> =>
      typeof value === 'object' &&
      value !== null &&
      (value as { object?: unknown }).object === 'claim' &&
      typeof (value as { claimId?: unknown }).claimId === 'string' &&
      typeof (value as { release?: unknown }).release === 'function';
    const claimMeta = (options: ClaimOptions<T> | undefined): Record<string, unknown> | undefined => {
      if (!options?.description) return options?.meta;
      return { ...(options.meta ?? {}), description: options.description };
    };
    const acquireClaim = async (params: ClaimParams<T>): Promise<string> => {
      const body = await requestJson<{
        id?: string;
        intent?: { id?: string };
        intentId?: string;
        status?: 'queued';
        position?: number;
      }>(claimPath(params.id), {
        method: 'POST',
        body: JSON.stringify({
          action: params.action ?? 'editing',
          ...(params.ttl !== undefined ? { ttl: params.ttl } : {}),
          ...(params.description !== undefined ? { description: params.description } : {}),
          ...(claimMeta(params) ? { meta: claimMeta(params) } : {}),
          // `wait` (default true) → queue behind the holder; false → fail-fast
          // with AbloClaimedError (work-distribution dedup).
          queue: params.wait ?? true,
        }),
      });
      if (body.status === 'queued') {
        throw new AbloClaimedError(
          `Target ${name}/${params.id} is held; queued at position ${body.position ?? 0}. ` +
            `The HTTP client cannot await the grant without a WebSocket.`,
          { code: 'intent_queued' },
        );
      }
      return body.intent?.id ?? body.id ?? body.intentId ?? createIntentId();
    };
    const releaseClaim = (params: ClaimLookupParams<T> | ClaimHandle<T>): Promise<void> =>
      requestJson<unknown>(
        claimPath(isClaimHandle(params) ? params.target.id : params.id),
        { method: 'DELETE' },
      ).then(() => undefined);

    async function claimImpl(params: ClaimParams<T>): Promise<ClaimHandle<T>> {
      const claimId = await acquireClaim(params);
      const { data, stamp } = await retrieveModel<T>(name, { id: params.id });
      const release = () => releaseClaim(params);
      return {
        object: 'claim',
        claimId,
        readAt: stamp,
        target: {
          model: name,
          id: params.id,
          ...(params.field ? { field: params.field } : {}),
          ...(params.path ? { path: params.path } : {}),
          ...(params.range ? { range: params.range } : {}),
          ...(claimMeta(params) ? { meta: claimMeta(params) } : {}),
        },
        action: params.action ?? 'editing',
        ...(params.description ? { description: params.description } : {}),
        data,
        release,
        revoke: () => {
          void release().catch(() => {});
        },
        [Symbol.asyncDispose]: release,
      };
    }
    const intentsForEntity = async (params: ClaimLookupParams<T>): Promise<{ intents?: Intent[]; queue?: Intent[] }> =>
      requestJson<{ intents?: Intent[]; queue?: Intent[] }>(
        `/v1/intents?model=${encodeURIComponent(name)}&id=${encodeURIComponent(params.id)}${
          params.field ? `&field=${encodeURIComponent(params.field)}` : ''
        }`,
        { method: 'GET' },
      );
    const claim = Object.assign(claimImpl, {
      release: releaseClaim,
      state: async (params: ClaimLookupParams<T>): Promise<Intent | null> => {
        const res = await intentsForEntity(params);
        return res.intents?.[0] ?? null;
      },
      queue: async (
        params: ClaimLookupParams<T>,
      ): Promise<{ readonly object: 'list'; readonly data: readonly Intent[] }> => {
        const res = await intentsForEntity(params);
        return { object: 'list', data: res.queue ?? [] };
      },
      reorder: async (params: ClaimReorderParams<T>): Promise<void> => {
        await requestJson<unknown>(`${claimPath(params.id)}/reorder`, {
          method: 'POST',
          // The reorder route's payload is `{ heldBy, intentId }[]` — Intent's id
          // IS the intentId.
          body: JSON.stringify({ order: params.order.map((i) => ({ heldBy: i.heldBy, intentId: i.id })) }),
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
        return run({ ...input, intent: { id: claimInput.claimId }, claim: undefined });
      }

      const claimId = await acquireClaim({ id, ...claimInput });
      try {
        return await run({ ...input, intent: { id: claimId }, claim: undefined });
      } finally {
        await releaseClaim({ id }).catch(() => {});
      }
    };

    return {
      claim,
      retrieve(params: ModelReadOptions & { readonly id: string }): Promise<ModelRead<T>> {
        return retrieveModel<T>(name, params);
      },
      list(options?: ModelLoadOptions<T>): Promise<T[]> {
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
    async ready() {},
    async waitForFlush() {},
    async dispose() {},
    async purge() {},
    capabilities,
    intents,
    commits,
    model,
    async getAuthToken(): Promise<string | null> {
      // Mirror `authHeaders()`: a configured API key wins, else the
      // construction-time auth token. Resolve the (possibly async) key setter.
      return (await resolveApiKeyValue(configuredApiKey)) ?? configuredAuthToken ?? null;
    },
  };
}

function normalizeIntentId(
  intent: string | { readonly id: string } | null | undefined,
): string | undefined {
  if (typeof intent === 'string') return intent;
  return intent?.id;
}


function parseBody(bodyText: string): unknown {
  if (bodyText.length === 0) return null;
  try {
    return JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
}
