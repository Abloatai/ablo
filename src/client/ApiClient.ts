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
  ModelClient,
  ModelClaim,
  ModelMutationOptions,
  ModelReadOptions,
  ModelRead,
  ModelTarget,
  Turn,
} from './Ablo.js';
import type { Duration } from '../utils/duration.js';

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

export interface CapabilityResource {
  create(options: CapabilityCreateOptions): Promise<Capability>;
  retrieve(id: string): Promise<CapabilityRecord>;
  revoke(id: string): Promise<CapabilityRevocation>;
  /**
   * Alias for `create`. Kept because "mint" is common capability-token
   * language, but `create` is the canonical SDK verb.
   */
  mint(options: CapabilityCreateOptions): Promise<Capability>;
}

export interface TaskCreateOptions {
  readonly prompt: string;
  readonly parentTaskId?: string;
  readonly surface?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface TaskCloseOptions {
  readonly costInputTokens?: number;
  readonly costOutputTokens?: number;
  readonly costComputeMs?: number;
}

export interface Task {
  readonly id: string;
  readonly turnId: string;
  readonly promptHash?: string;
  readonly openedAt?: string;
  close(stats?: TaskCloseOptions): Promise<TaskCloseResult>;
}

export interface TaskCloseResult {
  readonly id: string;
  readonly turnId: string;
  readonly closed: boolean;
  readonly alreadyClosed?: boolean;
  readonly endedAt?: string;
}

export interface TaskResource {
  create(options: TaskCreateOptions): Promise<Task>;
  close(id: string, stats?: TaskCloseOptions): Promise<TaskCloseResult>;
  /**
   * Alias for `create`. Kept for the agent-run vocabulary; `create` is
   * the canonical SDK verb.
   */
  open(options: TaskCreateOptions): Promise<Task>;
}

export interface AgentOptions {
  readonly can: readonly string[];
  readonly syncGroups?: readonly string[];
  readonly label?: string;
  readonly userMeta?: Record<string, unknown>;
  /**
   * Internal lease for the run capability. Most callers should omit it.
   * The SDK revokes the capability when `run` finishes; the lease exists
   * to clean up crashed or abandoned runs.
   */
  readonly lease?: Duration;
  readonly leaseSeconds?: number;
}

export interface AgentRunOptions extends TaskCreateOptions {
  readonly signal?: AbortSignal;
  readonly costInputTokens?: number;
  readonly costOutputTokens?: number;
  readonly costComputeMs?: number;
}

export type AgentRunStatus = 'done' | 'failed' | 'cancelled';

export interface AgentRunDone<T> {
  readonly status: 'done';
  readonly task: Task;
  readonly value: T;
}

export interface AgentRunFailed {
  readonly status: 'failed';
  readonly task?: Task;
  readonly error: unknown;
}

export interface AgentRunCancelled {
  readonly status: 'cancelled';
  readonly task?: Task;
  readonly error?: unknown;
}

export type AgentRunResult<T> =
  | AgentRunDone<T>
  | AgentRunFailed
  | AgentRunCancelled;

export interface AgentIntentOptions {
  readonly action: string;
  readonly field?: string;
  readonly ttl?: Duration;
  readonly target?: Partial<ModelTarget>;
}

export type AgentIntentInput = string | AgentIntentOptions;

export interface AgentModelReadOptions extends ModelReadOptions {}

export interface AgentModelMutationOptions
  extends Omit<ModelMutationOptions, 'intent'> {
  readonly intent?: AgentIntentInput | { readonly id: string } | null;
}

export interface AgentModelClient<T = Record<string, unknown>> {
  retrieve(id: string, options?: AgentModelReadOptions): Promise<ModelRead<T>>;
  create(
    data: Record<string, unknown>,
    options?: AgentModelMutationOptions & { readonly id?: string | null },
  ): Promise<CommitReceipt>;
  update(
    id: string,
    data: Record<string, unknown>,
    options?: AgentModelMutationOptions,
  ): Promise<CommitReceipt>;
  delete(id: string, options?: AgentModelMutationOptions): Promise<CommitReceipt>;
}

export interface AgentRunContext {
  readonly task: Task;
  readonly ablo: AbloApi;
  model<T = Record<string, unknown>>(name: string): AgentModelClient<T>;
}

export interface Agent {
  readonly id: string;
  run<T>(
    options: AgentRunOptions,
    handler: (context: AgentRunContext) => Promise<T> | T,
  ): Promise<AgentRunResult<T>>;
}

export interface AbloApi {
  ready(): Promise<void>;
  waitForFlush(): Promise<void>;
  dispose(): Promise<void>;
  purge(): Promise<void>;
  readonly capabilities: CapabilityResource;
  readonly tasks: TaskResource;
  readonly intents: AbloApiIntents;
  readonly commits: CommitResource;
  agent(id: string, options: AgentOptions): Agent;
  model<T = Record<string, unknown>>(name: string): ModelClient<T>;
  beginTurn(options: TaskCreateOptions): Promise<Turn>;
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

interface TaskCreateResponse {
  readonly id?: string;
  readonly taskId?: string;
  readonly turnId?: string;
  readonly promptHash?: string;
  readonly openedAt?: string;
}

interface TaskCloseResponse {
  readonly id?: string;
  readonly taskId?: string;
  readonly turnId?: string;
  readonly closed?: boolean;
  readonly alreadyClosed?: boolean;
  readonly endedAt?: string;
}

const DEFAULT_AGENT_LEASE: Duration = '10m';
const DEFAULT_INTENT_LEASE: Duration = '2m';

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

  function createAgent(id: string, agentOptions: AgentOptions): Agent {
    return {
      id,
      async run<T>(
        runOptions: AgentRunOptions,
        handler: (context: AgentRunContext) => Promise<T> | T,
      ): Promise<AgentRunResult<T>> {
        if (runOptions.signal?.aborted) {
          return { status: 'cancelled' };
        }

        let capability: Capability | null = null;
        let task: Task | null = null;
        try {
          const leaseOptions =
            agentOptions.leaseSeconds !== undefined
              ? { leaseSeconds: agentOptions.leaseSeconds }
              : { lease: agentOptions.lease ?? DEFAULT_AGENT_LEASE };
          capability = await capabilities.create({
            participantKind: 'agent',
            participantId: id,
            syncGroups: agentOptions.syncGroups ?? ['default'],
            operations: agentOptions.can,
            label: agentOptions.label ?? id,
            userMeta: agentOptions.userMeta,
            ...leaseOptions,
          } as CapabilityCreateOptions);

          const agentClient = capability.client();
          task = await agentClient.tasks.create({
            prompt: runOptions.prompt,
            parentTaskId: runOptions.parentTaskId,
            surface: runOptions.surface ?? 'agent',
            metadata: runOptions.metadata,
          });

          const context = createAgentRunContext(agentClient, task);
          const value = await handler(context);
          await task.close({
            costInputTokens: runOptions.costInputTokens,
            costOutputTokens: runOptions.costOutputTokens,
            costComputeMs: runOptions.costComputeMs,
          });
          return { status: 'done', task, value };
        } catch (error) {
          if (task) {
            await task.close({
              costInputTokens: runOptions.costInputTokens,
              costOutputTokens: runOptions.costOutputTokens,
              costComputeMs: runOptions.costComputeMs,
            }).catch(() => {});
          }
          if (isAbortError(error) || runOptions.signal?.aborted) {
            return { status: 'cancelled', task: task ?? undefined, error };
          }
          return { status: 'failed', task: task ?? undefined, error };
        } finally {
          if (capability) {
            await capabilities.revoke(capability.id).catch(() => {});
          }
        }
      },
    };
  }

  function createAgentRunContext(agentClient: AbloApi, task: Task): AgentRunContext {
    return {
      task,
      ablo: agentClient,
      model<T = Record<string, unknown>>(name: string): AgentModelClient<T> {
        return createAgentModelClient<T>(agentClient, name);
      },
    };
  }

  function createAgentModelClient<T>(
    agentClient: AbloApi,
    name: string,
  ): AgentModelClient<T> {
    const base = agentClient.model<T>(name);

    return {
      retrieve(id: string, options?: AgentModelReadOptions): Promise<ModelRead<T>> {
        // Reads are never blocked by a claim (coordination.md): a claim
        // serializes WRITERS, not readers. So — unlike the create/update/
        // delete paths below — retrieve does NOT apply the agent claimed
        // default; options pass through and the read path's `'return'`
        // default keeps a claimed row readable. A caller can still opt into
        // gating with an explicit `ifClaimed` (developer's choice).
        return base.retrieve(id, options);
      },

      create(
        data: Record<string, unknown>,
        mutationOptions?: AgentModelMutationOptions & { readonly id?: string | null },
      ): Promise<CommitReceipt> {
        const id = mutationOptions?.id ?? createModelId();
        return withAgentIntent(
          agentClient,
          name,
          id,
          mutationOptions,
          (commitIntent) => base.create(data, {
            ...stripAgentRuntimeOptions(mutationOptions),
            id,
            intent: commitIntent,
          }),
        );
      },

      update(
        id: string,
        data: Record<string, unknown>,
        mutationOptions?: AgentModelMutationOptions,
      ): Promise<CommitReceipt> {
        return withAgentIntent(
          agentClient,
          name,
          id,
          mutationOptions,
          (commitIntent) => base.update(id, data, {
            ...stripAgentRuntimeOptions(mutationOptions),
            intent: commitIntent,
          }),
        );
      },

      delete(
        id: string,
        mutationOptions?: AgentModelMutationOptions,
      ): Promise<CommitReceipt> {
        return withAgentIntent(
          agentClient,
          name,
          id,
          mutationOptions,
          (commitIntent) => base.delete(id, {
            ...stripAgentRuntimeOptions(mutationOptions),
            intent: commitIntent,
          }),
        );
      },
    };
  }

  async function withAgentIntent(
    agentClient: AbloApi,
    modelName: string,
    id: string,
    mutationOptions: AgentModelMutationOptions | undefined,
    commit: (intent: string | { readonly id: string } | null | undefined) => Promise<CommitReceipt>,
  ): Promise<CommitReceipt> {
    const intentInput = mutationOptions?.intent;
    const targetOverride =
      intentInput != null && typeof intentInput === 'object' && !isIntentHandleRef(intentInput)
        ? intentInput.target ?? {}
        : {};
    const target: ModelTarget = {
      ...targetOverride,
      model: targetOverride.model ?? modelName,
      id: targetOverride.id ?? id,
      ...(intentInput != null && typeof intentInput === 'object' && !isIntentHandleRef(intentInput) && intentInput.field
        ? { field: intentInput.field }
        : {}),
    };

    await applyClaimedPolicy(target, withAgentClaimedDefault(mutationOptions), 'wait');

    if (intentInput == null || isIntentHandleRef(intentInput)) {
      return commit(intentInput);
    }

    const action = typeof intentInput === 'string' ? intentInput : intentInput.action;
    const intent = await agentClient.intents.create({
      target,
      action,
      ttl: typeof intentInput === 'object'
        ? intentInput.ttl ?? DEFAULT_INTENT_LEASE
        : DEFAULT_INTENT_LEASE,
    });
    try {
      return await commit(intent);
    } finally {
      await intent.release().catch(() => {});
    }
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
      const clientTxId = createClientTxId(commitOptions.idempotencyKey);
      const operations = normalizeCommitOperations(commitOptions);
      const body = await requestJson<CommitResponse>('/v1/commits', {
        method: 'POST',
        idempotencyKey: clientTxId,
        body: JSON.stringify({
          clientTxId,
          idempotencyKey: clientTxId,
          intent: normalizeIntentId(commitOptions.intent),
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

    mint(options: CapabilityCreateOptions): Promise<Capability> {
      return capabilities.create(options);
    },
  };

  const tasks: TaskResource = {
    async create(taskOptions: TaskCreateOptions): Promise<Task> {
      const body = await requestJson<TaskCreateResponse>('/v1/tasks', {
        method: 'POST',
        body: JSON.stringify({
          prompt: taskOptions.prompt,
          parentTaskId: taskOptions.parentTaskId,
          surface: taskOptions.surface,
          metadata: taskOptions.metadata,
        }),
      });
      const id = body.id ?? body.taskId ?? body.turnId;
      if (!id) {
        throw new AbloValidationError(
          'Task create response did not include an id.',
          { code: 'task_id_missing' },
        );
      }
      return {
        id,
        turnId: id,
        promptHash: body.promptHash,
        openedAt: body.openedAt,
        close: (stats?: TaskCloseOptions) => tasks.close(id, stats),
      };
    },

    async close(id: string, stats?: TaskCloseOptions): Promise<TaskCloseResult> {
      const body = await requestJson<TaskCloseResponse>(
        `/v1/tasks/${encodeURIComponent(id)}/close`,
        {
          method: 'POST',
          body: JSON.stringify({
            costInputTokens: stats?.costInputTokens ?? 0,
            costOutputTokens: stats?.costOutputTokens ?? 0,
            costComputeMs: stats?.costComputeMs ?? 0,
          }),
        },
      );
      const closedId = body.id ?? body.taskId ?? body.turnId ?? id;
      return {
        id: closedId,
        turnId: closedId,
        closed: body.closed ?? body.alreadyClosed ?? true,
        alreadyClosed: body.alreadyClosed,
        endedAt: body.endedAt,
      };
    },

    open(options: TaskCreateOptions): Promise<Task> {
      return tasks.create(options);
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

  async function retrieveModel<T>(
    modelName: string,
    id: string,
    options?: ModelReadOptions,
  ): Promise<ModelRead<T>> {
    await applyClaimedPolicy({ model: modelName, id }, options);

    const query = await requestJson<QueryResponse>(
      `/v1/models/${encodeURIComponent(modelName)}/${encodeURIComponent(id)}`,
      {
        method: 'GET',
      },
    );

    const data = query.data as T | undefined;
    if (!data) {
      throw new AbloValidationError(
        `Model row not found: ${modelName}/${id}`,
        { code: 'model_not_found' },
      );
    }

    return {
      data,
      stamp: query.stamp ?? 0,
      claims: query.claims ?? [],
    };
  }

  function model<T = Record<string, unknown>>(name: string): ModelClient<T> {
    return {
      retrieve(id: string, options?: ModelReadOptions): Promise<ModelRead<T>> {
        return retrieveModel<T>(name, id, options);
      },
      async create(
        data: Record<string, unknown>,
        mutationOptions?: ModelMutationOptions & { readonly id?: string | null },
      ): Promise<CommitReceipt> {
        const id = mutationOptions?.id ?? createModelId();
        await applyClaimedPolicy({ model: name, id }, mutationOptions);
        return commits.create({
          intent: mutationOptions?.intent,
          idempotencyKey: mutationOptions?.idempotencyKey,
          readAt: mutationOptions?.readAt,
          onStale: mutationOptions?.onStale,
          wait: mutationOptions?.wait,
          operations: [
            {
              action: 'create',
              model: name,
              id,
              data,
            },
          ],
        });
      },
      async update(
        id: string,
        data: Record<string, unknown>,
        mutationOptions?: ModelMutationOptions,
      ): Promise<CommitReceipt> {
        await applyClaimedPolicy({ model: name, id }, mutationOptions);
        return commits.create({
          intent: mutationOptions?.intent,
          idempotencyKey: mutationOptions?.idempotencyKey,
          readAt: mutationOptions?.readAt,
          onStale: mutationOptions?.onStale,
          wait: mutationOptions?.wait,
          operations: [
            {
              action: 'update',
              model: name,
              id,
              data,
            },
          ],
        });
      },
      async delete(
        id: string,
        mutationOptions?: ModelMutationOptions,
      ): Promise<CommitReceipt> {
        await applyClaimedPolicy({ model: name, id }, mutationOptions);
        return commits.create({
          intent: mutationOptions?.intent,
          idempotencyKey: mutationOptions?.idempotencyKey,
          readAt: mutationOptions?.readAt,
          onStale: mutationOptions?.onStale,
          wait: mutationOptions?.wait,
          operations: [
            {
              action: 'delete',
              model: name,
              id,
            },
          ],
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
    tasks,
    intents,
    commits,
    model,
    agent: createAgent,
    async beginTurn(turnOptions: TaskCreateOptions): Promise<Turn> {
      const task = await tasks.create(turnOptions);
      let closed = false;
      const close = async (stats?: TaskCloseOptions): Promise<void> => {
        if (closed) return;
        closed = true;
        await task.close(stats);
      };
      const dispose = (): void => {
        closed = true;
      };
      return {
        turnId: task.id,
        close,
        dispose,
        [Symbol.asyncDispose]: close,
      };
    },
  };
}

function normalizeIntentId(
  intent: string | { readonly id: string } | null | undefined,
): string | undefined {
  if (typeof intent === 'string') return intent;
  return intent?.id;
}

function withAgentClaimedDefault<T extends ClaimedOptions | undefined>(
  options: T,
): ClaimedOptions & NonNullable<T> {
  return {
    ifClaimed: 'fail',
    ...(options ?? {}),
  } as ClaimedOptions & NonNullable<T>;
}

function stripAgentRuntimeOptions(
  options: AgentModelMutationOptions | undefined,
): Omit<
  ModelMutationOptions,
  'intent' | 'ifClaimed' | 'claimedTimeout' | 'claimedPollInterval' | 'maxQueueDepth'
> | undefined {
  if (!options) return undefined;
  const {
    intent: _intent,
    ifClaimed: _ifClaimed,
    claimedTimeout: _claimedTimeout,
    claimedPollInterval: _claimedPollInterval,
    maxQueueDepth: _maxQueueDepth,
    ...rest
  } = options;
  return rest;
}

function isIntentHandleRef(
  input: AgentIntentInput | { readonly id: string },
): input is { readonly id: string } {
  return (
    typeof input === 'object' &&
    input !== null &&
    'id' in input &&
    typeof input.id === 'string' &&
    !('action' in input)
  );
}

function isAbortError(error: unknown): boolean {
  return (
    typeof DOMException !== 'undefined' &&
    error instanceof DOMException &&
    error.name === 'AbortError'
  ) || (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'AbortError'
  );
}

function parseBody(bodyText: string): unknown {
  if (bodyText.length === 0) return null;
  try {
    return JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
}
