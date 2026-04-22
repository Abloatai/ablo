/**
 * SyncAgent — AI agent as a first-class sync participant.
 *
 * Connects to the sync engine via WebSocket, subscribes to entity changes,
 * and emits mutations with agent attribution. Every mutation is tracked
 * in the delta log with `createdBy: "agent:<agentId>"`.
 */

// ── Types ─────────────────────────────────────────────────────────────────

export interface SyncAgentOptions {
  /** WebSocket URL of the sync server */
  url: string;
  /**
   * @deprecated Legacy opaque token field, unused on the wire. Capability
   * bearers flow through `capabilityToken` instead. Kept in the shape for
   * one release to avoid breaking existing callers.
   */
  token?: string;
  /**
   * Biscuit capability bearer token (obtained from `POST /api/auth/capability`).
   * When set, the SDK sends it as `?authorization=Bearer+<token>` on the
   * WebSocket upgrade — the query-param form works in both Node and
   * browsers (browser WebSocket cannot set custom headers on the
   * upgrade request). The server's `agentTokenProvider` accepts either
   * the header or this query param, so behavior is uniform across envs.
   */
  capabilityToken?: string;
  /**
   * Biscuit root public key (hex). Only required when calling
   * `attenuate()` — the SDK uses it to parse + re-sign the narrowed
   * token without contacting the server. Get the same value the server
   * has in `BISCUIT_ROOT_PUBLIC_KEY`.
   */
  biscuitRootPublicKey?: string;
  /** Unique agent identifier — mutations attributed as `agent:<agentId>` */
  agentId: string;
  /** Sync groups this agent subscribes to */
  syncGroups?: string[];
  /** Organization ID for multi-tenant scoping */
  organizationId?: string;
  /** Auto-reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** Max reconnect attempts (default: 10) */
  maxReconnectAttempts?: number;
  /** Base reconnect delay in ms (default: 1000, exponential backoff) */
  reconnectDelay?: number;
  /**
   * Buffer mutations while the WebSocket is closed and flush them on
   * reconnect. Default: `true` — agents are expected to tolerate
   * flakey networks. Disable only if fail-fast-while-offline is the
   * product requirement (in which case a closed-socket write throws
   * `AbloConnectionError` immediately, matching pre-offline-queue
   * behavior).
   *
   * Queued mutations keep their original `clientTxId` across retries,
   * so server-side `mutation_log` idempotency dedups anything that
   * got persisted before the disconnect.
   */
  offlineQueue?: boolean;
  /**
   * Per-mutation ack timeout in ms. Applies only after a commit is
   * actually sent on the wire — queued-while-offline entries do NOT
   * start their clock until they reach the server. Default: 10_000.
   */
  mutationTimeoutMs?: number;
}

import type {
  AgentActivity,
  PresenceEntry,
  PresenceAnnouncer,
  IntentClaim,
} from './types';
export type { AgentActivity, PresenceEntry, IntentClaim } from './types';

/**
 * Structured participant reference carried on every delta. Matches the
 * server-side `ParticipantRef` in apps/sync-server/src/db/deltas.ts so
 * SDK consumers get the same typed attribution the server records.
 * Agent-first ontology: no `agent:` string-prefix parsing anywhere.
 */
export interface ParticipantRef {
  kind: 'user' | 'agent' | 'system';
  id: string;
}

export interface AgentDelta {
  id: number;
  actionType: 'I' | 'U' | 'D' | 'A';
  modelName: string;
  modelId: string;
  data: Record<string, unknown>;
  previousData?: Record<string, unknown>;
  createdBy?: ParticipantRef | null;
  createdAt: string;
}

/**
 * One operation inside a commit batch. Matches
 * `apps/sync-server/src/hub/types.ts CommitMessage.payload.operations[]`.
 * Declared here so `sendCommit` and the offline queue share the
 * same exact typing without re-copying the shape.
 */
interface CommitOperation {
  type: string;
  model: string;
  id: string;
  input?: Record<string, unknown>;
  readAt?: number;
  onStale?: 'reject' | 'force' | 'flag' | 'merge';
}

/**
 * Handle returned by `SyncAgent.beginIntent()`. Call `abandon()` to
 * explicitly release the intent before commit — for example if the
 * LLM generation failed and no mutation will follow. Idempotent; safe
 * to call multiple times or after the server has already cleared it
 * (on commit, TTL, or disconnect).
 */
export interface IntentHandle {
  readonly intentId: string;
  abandon(): void;
}

/**
 * Options for agent-side mutations (`create` / `update` / `delete`).
 *
 * `readAt` stamps the write with the sync id the caller reasoned
 * against — usually from `mesh.participant.context.capture(...)`. If
 * the target entity has received deltas since `readAt`, the server's
 * stale check rejects with `AbloStaleContextError` (unless `onStale`
 * says otherwise). Omit both fields for fire-and-forget writes that
 * don't depend on a captured snapshot.
 */
export interface MutationOptions {
  /** Sync id snapshot from `context.capture`. See class-level JSDoc. */
  readonly readAt?: number;
  /**
   * Mode on stale detection. `'reject'` (default) throws; `'force'`
   * applies unconditionally. `'flag'` / `'merge'` are reserved.
   */
  readonly onStale?: 'reject' | 'force' | 'flag' | 'merge';
}

export interface EntityFilter {
  where?: Record<string, unknown>;
}

export type DeltaHandler = (
  entity: Record<string, unknown>,
  delta: AgentDelta
) => void | Promise<void>;

interface Subscription {
  modelName: string;
  filter?: EntityFilter;
  handler: DeltaHandler;
}

type EventHandler = (...args: unknown[]) => void;

import { AgentQueryView, type AgentQueryViewOptions } from './AgentQueryView';
import { AgentViewRegistry } from './AgentViewRegistry';
import {
  AbloConnectionError,
  AbloError,
  AbloIdempotencyError,
  AbloPermissionError,
  AbloStaleContextError,
  AbloValidationError,
  translateHttpError,
} from '../errors';

/**
 * Reconstruct a typed error class from the `{ code, message }` envelope
 * the server sends over WebSocket `mutation_result`. Class identity
 * doesn't survive the wire automatically — this reviver maps stable
 * `code` strings back to the right `AbloError` subclass so callers can
 * `instanceof AbloStaleContextError` (or equivalent) just like on the
 * HTTP path.
 */
function reviveAgentMutationError(
  error: { code?: string; message?: string } | undefined,
): Error {
  const code = error?.code;
  const message = error?.message ?? 'Agent mutation failed';
  switch (code) {
    case 'stale_context':
      return new AbloStaleContextError(message, { code, httpStatus: 409 });
    case 'idempotency_conflict':
      return new AbloIdempotencyError(message, { code, httpStatus: 409 });
    case 'forbidden':
    case 'capability_scope_denied':
    case 'capability_invalid':
      return new AbloPermissionError(message, { code, httpStatus: 403 });
    case 'validation_failed':
    case 'server_execute_unknown_model':
    case 'mesh_scope_empty':
    case 'mesh_entity_not_scopable':
      return new AbloValidationError(message, { code });
    default:
      // Unknown code → still an AbloError (instanceof AbloError works),
      // but no specific subclass. Caller can inspect `.code`.
      return new AbloError(message, { code });
  }
}

// ── Agent ─────────────────────────────────────────────────────────────────

/** Internal options shape with defaults applied. Optional fields that
 *  have no meaningful default (`capabilityToken`, `biscuitRootPublicKey`)
 *  stay optional; everything else has a default so call-site code can
 *  access without guards. */
type ResolvedSyncAgentOptions = Required<
  Omit<SyncAgentOptions, 'token' | 'capabilityToken' | 'biscuitRootPublicKey'>
> & {
  token?: string;
  capabilityToken?: string;
  biscuitRootPublicKey?: string;
};

export class SyncAgent implements PresenceAnnouncer {
  private options: ResolvedSyncAgentOptions;
  private ws: WebSocket | null = null;
  private subscriptions: Subscription[] = [];
  private eventHandlers = new Map<string, Set<EventHandler>>();
  private reconnectAttempts = 0;
  private disposed = false;
  private lastSyncId = 0;
  private entityCache = new Map<string, Record<string, unknown>>();
  private readonly viewRegistry = new AgentViewRegistry();
  private readonly pendingMutations = new Map<
    string,
    {
      operations: CommitOperation[];
      resolve: (result: { lastSyncId: number }) => void;
      reject: (err: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  /**
   * Mutations submitted while the WebSocket is not OPEN. Drained on
   * `ws.onopen` (both first connect and reconnect). Each entry holds
   * the same `clientTxId` across retries so server-side
   * `mutation_log` idempotency prevents double-writes if the ack
   * missed a reconnect cycle.
   *
   * Populated from two paths:
   *   1. `sendCommit` called while `ws.readyState !== OPEN`.
   *   2. `ws.onclose` migrates still-unacked `pendingMutations` back
   *      here so they replay on the next connect.
   */
  private readonly offlineQueue: Array<{
    operations: CommitOperation[];
    clientTxId: string;
    resolve: (result: { lastSyncId: number }) => void;
    reject: (err: Error) => void;
  }> = [];

  /**
   * Rolling cache of the most recent presence state per user. Every
   * `presence_update` frame updates the entry for `payload.userId`.
   * Used by `waitForIntentToClear` so callers don't have to manage the
   * subscription themselves. Entries with `undefined` or empty
   * `activeIntents` mean "no pending intents from this user."
   */
  private readonly presenceByUserId = new Map<string, PresenceEntry>();

  constructor(options: SyncAgentOptions) {
    this.options = {
      syncGroups: ['default'],
      organizationId: '',
      autoReconnect: true,
      maxReconnectAttempts: 10,
      reconnectDelay: 1000,
      offlineQueue: true,
      mutationTimeoutMs: 10_000,
      ...options,
    };
  }

  // ── Connection ────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.ws) return;
    // A manual `connect()` after `disconnect()` (e.g. token refresh
    // on a long-running daemon) clears the disposed flag so
    // auto-reconnect works again on the fresh connection. Without
    // this, the second disconnect after a refresh would fail to
    // re-establish the WS automatically.
    this.disposed = false;

    const { url, agentId, organizationId, syncGroups, capabilityToken } =
      this.options;

    const wsUrl = new URL(url.replace(/^http/, 'ws'));
    wsUrl.pathname = wsUrl.pathname.replace(/\/?$/, '/api/sync/ws');
    // Participant typing: declare kind=agent on the wire. The server
    // records both kind and id independently; no string prefix in the
    // id itself (the server's formatCreatedBy adds the prefix at the
    // DB-column boundary, so a pre-prefixed id would double up).
    wsUrl.searchParams.set('kind', 'agent');
    wsUrl.searchParams.set('userId', agentId);
    wsUrl.searchParams.set('organizationId', organizationId);
    wsUrl.searchParams.set('lastSyncId', String(this.lastSyncId));
    // Capability bearer (query-param form so it works in both Node's
    // global WebSocket — which can't set headers — and browsers). The
    // server's `agentTokenProvider` reads either form.
    if (capabilityToken) {
      wsUrl.searchParams.set(
        'authorization',
        `Bearer ${capabilityToken}`,
      );
    }
    for (const group of syncGroups) {
      wsUrl.searchParams.append('syncGroups', group);
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl.toString());

      ws.onopen = () => {
        this.ws = ws;
        this.reconnectAttempts = 0;
        // Drain anything that queued up while we were offline. Runs
        // synchronously — the caller-visible promises resolve as
        // `mutation_result` frames arrive.
        this.flushOfflineQueue();
        this.emit('connected');
        resolve();
      };

      ws.onmessage = (event) => {
        this.handleMessage(typeof event.data === 'string' ? event.data : '');
      };

      ws.onclose = (event) => {
        this.ws = null;
        // Sent-but-unacked mutations migrate back to offlineQueue so
        // they replay on the next connect. Server-side `mutation_log`
        // dedups if any of them actually landed pre-disconnect.
        for (const [clientTxId, pending] of this.pendingMutations) {
          clearTimeout(pending.timeout);
          this.offlineQueue.push({
            operations: pending.operations,
            clientTxId,
            resolve: pending.resolve,
            reject: pending.reject,
          });
        }
        this.pendingMutations.clear();
        this.emit('disconnected', { code: event.code, reason: event.reason });
        if (this.options.autoReconnect && !this.disposed) {
          this.scheduleReconnect();
        }
      };

      ws.onerror = () => {
        if (!this.ws) reject(new Error('WebSocket connection failed'));
      };
    });
  }

  disconnect(): void {
    this.disposed = true;
    if (this.ws) {
      this.ws.close(1000, 'Agent disconnecting');
      this.ws = null;
    }
  }

  dispose(): void {
    this.disconnect();
    this.subscriptions = [];
    this.entityCache.clear();
    this.eventHandlers.clear();
    // Note: `this.disconnect()` migrated any unacked pending mutations
    // back to `offlineQueue`. Reject BOTH queues on dispose — the
    // agent is being torn down, no reconnect is coming.
    for (const pending of this.pendingMutations.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('SyncAgent disposed'));
    }
    this.pendingMutations.clear();
    for (const queued of this.offlineQueue) {
      queued.reject(new Error('SyncAgent disposed'));
    }
    this.offlineQueue.length = 0;
  }

  /**
   * The latest server-assigned sync id this agent has observed.
   * Monotonically increasing. Used by `mesh.participant.context.capture`
   * to stamp a watermark that subsequent writes can compare against
   * (`readAt` + `onStale`) to detect stale-read conflicts across the
   * LLM-generation window.
   */
  get currentSyncId(): number {
    return this.lastSyncId;
  }

  // ── Intent broadcast ────────────────────────────────────────────────
  //
  // Agents declare "I'm about to generate a mutation against entity X"
  // BEFORE an LLM starts composing the mutation. Other agents in the
  // same sync groups receive this via presence broadcasts and can
  // decide to defer their own reads/writes against the same entity.
  //
  // Clears automatically on: `.abandon()`, the agent's next commit,
  // WS disconnect, or the server-side TTL (default 2 minutes, capped
  // at 10 minutes). The handle is a no-op if already abandoned.
  //
  // Typical shape:
  //
  //   const i = agent.beginIntent({
  //     entityType: 'Task',
  //     entityId: 't-123',
  //     action: 'update',
  //     field: 'status',
  //     estimatedMs: 30_000,
  //   });
  //   try {
  //     // ... llm.generateText(...) ...
  //     await agent.update('Task', 't-123', { status: 'reviewed' });
  //   } catch (err) {
  //     i.abandon();   // release the intent if generation failed
  //     throw err;
  //   }

  beginIntent(spec: {
    entityType: string;
    entityId: string;
    action: string;
    field?: string;
    /** Hint for TTL. Server caps at 10 minutes. */
    estimatedMs?: number;
  }): IntentHandle {
    const intentId = crypto.randomUUID();
    if (this.ws?.readyState === 1 /* OPEN */) {
      this.ws.send(
        JSON.stringify({
          type: 'intent_begin',
          payload: {
            intentId,
            entityType: spec.entityType,
            entityId: spec.entityId,
            action: spec.action,
            field: spec.field,
            estimatedMs: spec.estimatedMs,
          },
        }),
      );
    }
    let abandoned = false;
    const abandon = () => {
      if (abandoned) return;
      abandoned = true;
      if (this.ws?.readyState === 1) {
        this.ws.send(
          JSON.stringify({
            type: 'intent_abandon',
            payload: { intentId },
          }),
        );
      }
    };
    return { intentId, abandon };
  }

  /**
   * Scan the rolling presence cache for intents matching the target
   * entity. Returns every pending intent from any user seen so far —
   * caller can inspect `intentId`, `declaredAt`, `expiresAt`, `field`,
   * etc. Synchronous; no network I/O. Empty array = no intents cached.
   *
   * Typical use inside a tool's pre-write check:
   *
   *   const pending = agent.pendingIntents('Task', 't-123');
   *   if (pending.some((i) => i.field === 'status')) {
   *     await agent.waitForIntentToClear('Task', 't-123', 'status');
   *   }
   */
  pendingIntents(
    entityType: string,
    entityId: string,
    field?: string,
  ): IntentClaim[] {
    const etLower = entityType.toLowerCase();
    const idLower = entityId.toLowerCase();
    const result: IntentClaim[] = [];
    for (const entry of this.presenceByUserId.values()) {
      if (!entry.activeIntents) continue;
      for (const intent of entry.activeIntents) {
        if (
          intent.entityType.toLowerCase() !== etLower ||
          intent.entityId.toLowerCase() !== idLower
        ) {
          continue;
        }
        if (field && intent.field !== field) continue;
        result.push(intent);
      }
    }
    return result;
  }

  /**
   * Wait until no cached presence entry has a pending intent matching
   * (entityType, entityId, field?). Resolves immediately if none are
   * currently observed. Rejects on timeout (default 30 s) so callers
   * don't block forever on a crashed peer — this is an advisory
   * coordination primitive, not a lock.
   */
  waitForIntentToClear(
    entityType: string,
    entityId: string,
    field?: string,
    timeoutMs: number = 30_000,
  ): Promise<void> {
    if (this.pendingIntents(entityType, entityId, field).length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const checkDone = () => {
        if (this.pendingIntents(entityType, entityId, field).length === 0) {
          cleanup();
          resolve();
        }
      };
      const handler = () => checkDone();
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `waitForIntentToClear timed out after ${timeoutMs}ms for ${entityType}/${entityId}`,
          ),
        );
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.eventHandlers.get('presence')?.delete(handler as EventHandler);
      };
      if (!this.eventHandlers.has('presence')) {
        this.eventHandlers.set('presence', new Set());
      }
      this.eventHandlers.get('presence')!.add(handler as EventHandler);
      // One more synchronous check in case the intent cleared between
      // our first check and handler registration.
      checkDone();
    });
  }

  // ── Capability token swap ────────────────────────────────────────────
  //
  // Returns a new SyncAgent bound to a different capability token
  // while inheriting every other option. The common use is delegation
  // to a sub-agent with a narrower token:
  //
  //   import { attenuate } from '@ablo/sync-engine/auth';
  //
  //   const narrowed = attenuate({
  //     publicKey: BISCUIT_ROOT_PUBLIC_KEY,
  //     token: parent.capabilityToken!,
  //     expiresAt: new Date(Date.now() + 60_000),
  //   });
  //   const subAgent = parent.withCapabilityToken(narrowed);
  //   await subAgent.connect();
  //
  // Split by design: this method is crypto-free, so every consumer of
  // the agent module pays zero WASM cost. Callers who actually want to
  // narrow a token import the crypto primitive explicitly from the
  // auth subpath — no hidden dep creep in the browser bundle.

  withCapabilityToken(capabilityToken: string): SyncAgent {
    return new SyncAgent({
      ...this.options,
      capabilityToken,
    });
  }

  /**
   * Replace the capability token on THIS agent in place. Used by the
   * mesh-level `participant.refresh()` primitive to rotate tokens on
   * a long-running daemon without throwing away the agent's state
   * (lastSyncId, subscriptions, entity cache, event handlers).
   *
   * Does NOT reconnect the WebSocket — the caller is responsible for
   * cycling the connection if one is open. The typical flow is:
   *
   *   agent.disconnect();
   *   agent.setCapabilityToken(freshToken);
   *   await agent.connect();
   *
   * The intermediate offline window is covered by the offline queue;
   * the reconnection catch-up path fetches any missed deltas.
   */
  setCapabilityToken(capabilityToken: string): void {
    this.options.capabilityToken = capabilityToken;
  }

  /** Read-only accessor for the current capability token — useful when
   *  feeding it to `attenuate()` or logging issuance state. */
  get capabilityToken(): string | undefined {
    return this.options.capabilityToken;
  }

  // ── Subscriptions ─────────────────────────────────────────────────────

  /**
   * Subscribe to changes on a model type.
   *
   * ```ts
   * agent.on('tasks', { where: { status: 'pending' } }, async (task, delta) => {
   *   await agent.update('tasks', task.id, { status: 'reviewed' });
   * });
   * ```
   */
  on(modelName: string, filter: EntityFilter, handler: DeltaHandler): this;
  on(modelName: string, handler: DeltaHandler): this;
  on(event: string, handler: EventHandler): this;
  on(event: string, ...args: unknown[]): this {
    if (args.length === 2 && typeof args[1] === 'function') {
      this.subscriptions.push({
        modelName: event,
        filter: args[0] as EntityFilter,
        handler: args[1] as DeltaHandler,
      });
      return this;
    }

    if (args.length === 1 && typeof args[0] === 'function') {
      const fn = args[0] as EventHandler;
      // Lifecycle events are lowercase
      if (event === 'connected' || event === 'disconnected' || event === 'error' || event === 'delta' || event === 'bootstrap_required') {
        if (!this.eventHandlers.has(event)) this.eventHandlers.set(event, new Set());
        this.eventHandlers.get(event)!.add(fn);
      } else {
        // Model subscription without filter
        this.subscriptions.push({ modelName: event, handler: fn as DeltaHandler });
      }
      return this;
    }

    return this;
  }

  /**
   * Unsubscribe a lifecycle-event handler previously registered via
   * `on(event, fn)`. Paired with `on` for opt-out symmetry — required
   * by the mesh-facing `onDelta(...)` wrapper's return-the-unsubscribe
   * contract, and useful for any consumer with a finite-lifetime
   * observer.
   */
  off(event: string, handler: EventHandler): this {
    this.eventHandlers.get(event)?.delete(handler);
    return this;
  }

  private emit(event: string, ...args: unknown[]): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try { handler(...args); } catch { /* ignore */ }
      }
    }
  }

  // ── Mutations ─────────────────────────────────────────────────────────
  //
  // Batch-always by standard. Every mutation takes an array. A
  // single-item write is just `create(Model, [{...}])`. Matches the
  // wire shape exactly — `CommitMessage.operations` was always an
  // array — so the "array in, array out" API collapses onto one
  // `sendCommit` call per method.

  async create(
    modelName: string,
    data: ReadonlyArray<Record<string, unknown>>,
    options?: MutationOptions,
  ): Promise<ReadonlyArray<Record<string, unknown>>> {
    const now = new Date().toISOString();
    const entities = data.map((d) => {
      const id = (d.id as string) || crypto.randomUUID();
      return { id, ...d, createdAt: now, updatedAt: now };
    });
    await this.sendCommit(
      entities.map((entity, i) => ({
        type: 'CREATE',
        model: modelName.toLowerCase(),
        id: entity.id,
        input: data[i] as Record<string, unknown>,
        readAt: options?.readAt,
        onStale: options?.onStale,
      })),
    );
    for (const e of entities) {
      this.entityCache.set(e.id, { ...e, __modelName: modelName });
    }
    return entities;
  }

  async update(
    modelName: string,
    patches: ReadonlyArray<{ id: string } & Record<string, unknown>>,
    options?: MutationOptions,
  ): Promise<void> {
    if (patches.length === 0) return;
    const now = new Date().toISOString();
    await this.sendCommit(
      patches.map((patch) => {
        const { id, ...input } = patch;
        return {
          type: 'UPDATE',
          model: modelName.toLowerCase(),
          id,
          input,
          readAt: options?.readAt,
          onStale: options?.onStale,
        };
      }),
    );
    for (const { id, ...input } of patches) {
      const existing = this.entityCache.get(id) ?? { id };
      this.entityCache.set(id, { ...existing, ...input, updatedAt: now });
    }
  }

  async delete(
    modelName: string,
    ids: ReadonlyArray<string>,
    options?: MutationOptions,
  ): Promise<void> {
    if (ids.length === 0) return;
    await this.sendCommit(
      ids.map((id) => ({
        type: 'DELETE',
        model: modelName.toLowerCase(),
        id,
        readAt: options?.readAt,
        onStale: options?.onStale,
      })),
    );
    for (const id of ids) this.entityCache.delete(id);
  }

  /**
   * Soft-delete — marks the entities archived without removing the row.
   * Archived entities stay queryable under `scope: 'archived'` or
   * `'all'` and can be restored via `unarchive()`. This is the
   * idiomatic deletion path for Ablo entities with an `archivedAt`
   * column (tasks, projects, documents, files). Use `delete()` only
   * for hard removal.
   */
  async archive(
    modelName: string,
    ids: ReadonlyArray<string>,
    options?: MutationOptions,
  ): Promise<void> {
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    await this.sendCommit(
      ids.map((id) => ({
        type: 'ARCHIVE',
        model: modelName.toLowerCase(),
        id,
        readAt: options?.readAt,
        onStale: options?.onStale,
      })),
    );
    for (const id of ids) {
      const existing = this.entityCache.get(id);
      if (existing) {
        this.entityCache.set(id, { ...existing, archivedAt: now });
      }
    }
  }

  /** Restore previously archived entities. Inverse of `archive()`. */
  async unarchive(
    modelName: string,
    ids: ReadonlyArray<string>,
    options?: MutationOptions,
  ): Promise<void> {
    if (ids.length === 0) return;
    await this.sendCommit(
      ids.map((id) => ({
        type: 'UNARCHIVE',
        model: modelName.toLowerCase(),
        id,
        readAt: options?.readAt,
        onStale: options?.onStale,
      })),
    );
    for (const id of ids) {
      const existing = this.entityCache.get(id);
      if (existing) {
        const { archivedAt: _archived, ...rest } = existing as Record<string, unknown>;
        this.entityCache.set(id, rest);
      }
    }
  }

  query(modelName: string, filter?: { where?: Record<string, unknown> }): Record<string, unknown>[] {
    const results: Record<string, unknown>[] = [];
    for (const entity of this.entityCache.values()) {
      if (entity.__modelName !== modelName) continue;
      if (filter?.where && !this.matchesFilter(entity, filter.where)) continue;
      results.push(entity);
    }
    return results;
  }

  // ── Reactive Queries ───────────────────────────────────────────────────

  /**
   * Create a reactive query view that updates incrementally as deltas arrive.
   * Same algorithm as the MobX QueryView used by React components, but
   * framework-agnostic (plain arrays + callbacks).
   *
   * ```ts
   * const slides = agent.watch('Slide', { where: { deckId: 'd1' }, orderBy: 'position' });
   * slides.subscribe((results) => console.log('Updated:', results.length));
   * ```
   */
  watch<T extends Record<string, unknown>>(
    modelName: string,
    options?: AgentQueryViewOptions<T>,
  ): AgentQueryView<T> {
    const view = new AgentQueryView<T>(options);
    this.viewRegistry.register(
      modelName,
      view as unknown as AgentQueryView<Record<string, unknown>>,
    );

    // Seed with current cache contents
    for (const entity of this.entityCache.values()) {
      if (entity.__modelName === modelName) {
        (view as AgentQueryView<Record<string, unknown>>).handleAdded(entity);
      }
    }

    return view;
  }

  // ── Presence ──────────────────────────────────────────────────────────

  /**
   * Announce what this agent is doing. Implements the PresenceAnnouncer
   * interface — same signature as AgentPerception.announce(), so callers
   * can swap transports without changing their code.
   *
   * Uses WebSocket if connected, falls back to REST POST /api/presence.
   */
  async announce(
    status: 'online' | 'away' | 'offline',
    activity?: AgentActivity,
  ): Promise<void> {
    // Do NOT include `isAgent` in the payload. The server derives it
    // authoritatively from the connection's userId prefix — hardcoding
    // `true` here caused every presence announcement from a human
    // session to broadcast `isAgent: true` to peers, making humans
    // render as agents in peer UIs after their first hover/activity
    // update. SyncAgent is used by both agent workers AND by the
    // browser SDK (human sessions go through the same class); neither
    // should self-declare kind. Server is the source of truth.
    const payload = { status, activity };

    if (this.ws?.readyState === 1 /* OPEN */) {
      this.ws.send(JSON.stringify({
        type: 'presence_update',
        payload,
      }));
      return;
    }

    // Fallback: POST to REST endpoint
    try {
      await this.setPresenceViaRest(payload);
    } catch {
      /* fire-and-forget — presence failures never block the agent */
    }
  }

  /**
   * @deprecated Use `announce()` which implements the PresenceAnnouncer
   * interface shared with AgentPerception.
   */
  setPresence(options: { status?: string; activity?: AgentActivity }): void {
    const status = (options.status ?? 'online') as 'online' | 'away' | 'offline';
    void this.announce(status, options.activity);
  }

  /**
   * Subscribe to presence updates from other participants.
   * Returns an unsubscribe function.
   */
  onPresence(handler: (entry: PresenceEntry) => void): () => void {
    const eventName = 'presence';
    if (!this.eventHandlers.has(eventName)) {
      this.eventHandlers.set(eventName, new Set());
    }
    const wrappedHandler = handler as EventHandler;
    this.eventHandlers.get(eventName)!.add(wrappedHandler);
    return () => {
      this.eventHandlers.get(eventName)?.delete(wrappedHandler);
    };
  }

  private async setPresenceViaRest(payload: {
    status: string;
    activity?: AgentActivity;
  }): Promise<void> {
    const { url, token, agentId, organizationId, syncGroups } = this.options;
    const httpUrl = `${url.replace(/^ws/, 'http')}/api/presence`;

    const res = await fetch(httpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        userId: `agent:${agentId}`,
        organizationId,
        status: payload.status,
        activity: payload.activity,
        syncGroups,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const requestId = res.headers.get('x-request-id') ?? undefined;
      let parsedBody: unknown = text;
      if (text) {
        try {
          parsedBody = JSON.parse(text);
        } catch {
          // leave as raw string; translateHttpError handles both shapes.
        }
      }
      throw translateHttpError(res.status, parsedBody, requestId);
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private async sendCommit(
    operations: CommitOperation[],
  ): Promise<{ lastSyncId: number }> {
    // Pre-generated clientTxId — stays stable across offline-queue
    // retries so server-side `mutation_log` idempotency dedups if the
    // mutation got persisted before an ack-losing disconnect.
    const clientTxId = crypto.randomUUID();

    return new Promise<{ lastSyncId: number }>((resolve, reject) => {
      // offlineQueue=false preserves pre-queue fail-fast behavior for
      // callers who explicitly want it (cron jobs, scripts, tests).
      if (this.options.offlineQueue === false && this.ws?.readyState !== 1) {
        reject(
          new AbloConnectionError(
            'SyncAgent not connected — call connect() before mutating',
            { code: 'agent_not_connected' },
          ),
        );
        return;
      }

      this.offlineQueue.push({ operations, clientTxId, resolve, reject });
      this.flushOfflineQueue();
    });
  }

  /**
   * Drain everything that's waiting in `offlineQueue` over the open
   * WebSocket, moving each entry into `pendingMutations` for ack
   * tracking. Safe to call on any state — if the WS isn't open, it's
   * a no-op (next `ws.onopen` will drain).
   *
   * Ack timeout is started only HERE (at send time), not at queue
   * time, so entries that sat offline for hours don't time out on
   * the client before they ever reached the server.
   */
  private flushOfflineQueue(): void {
    if (this.ws?.readyState !== 1 /* OPEN */) return;
    while (this.offlineQueue.length > 0) {
      const entry = this.offlineQueue.shift()!;
      const { operations, clientTxId, resolve, reject } = entry;
      const timeout = setTimeout(() => {
        const pending = this.pendingMutations.get(clientTxId);
        if (!pending) return;
        this.pendingMutations.delete(clientTxId);
        pending.reject(
          new AbloConnectionError('Agent mutation timed out', {
            code: 'agent_mutation_timeout',
          }),
        );
      }, this.options.mutationTimeoutMs);
      this.pendingMutations.set(clientTxId, {
        operations,
        resolve,
        reject,
        timeout,
      });
      this.ws!.send(
        JSON.stringify({
          type: 'commit',
          payload: { operations, clientTxId },
        }),
      );
    }
  }

  private handleMessage(raw: string): void {
    try {
      const message = JSON.parse(raw);
      if (message.type === 'delta') {
        // Wire format (apps/sync-server/src/hub/types.ts DeltaMessage):
        //   { type: 'delta', payload: { deltas: SyncDelta[] } }
        for (const delta of message.payload.deltas) this.processDelta(delta);
      } else if (message.type === 'sync_response') {
        // Wire format (apps/sync-server/src/hub/types.ts SyncResponseMessage):
        //   { type: 'sync_response', payload: { deltas?, requiresBootstrap?, bootstrapHint? } }
        //
        // The server ships `sync_response` on two distinct paths, both
        // of which deliver missed deltas:
        //   • Reconnection catch-up (Hub.sendCatchUpDeltas) — when the
        //     client reconnects with lastSyncId < currentSyncId, the
        //     Hub selects every delta matching (id > lastSyncId) ∩
        //     (sync_groups) and ships them in one `sync_response`.
        //   • Explicit sync_request (Hub.handleSyncRequest) — same
        //     query, caller-triggered.
        //
        // Live-push deltas travel on `type: 'delta'` (handled above).
        // Before this handler existed, `sync_response` was silently
        // dropped — the test that surfaced it was
        // apps/sync-server/scripts/e2e-reconnection-delta.ts, which
        // observes the reader NOT receiving the missed deltas.
        //
        // `requiresBootstrap: true` means the gap exceeded the Hub's
        // `maxDeltaGapForPartial` threshold — the client should do a
        // full HTTP bootstrap rather than expect WS catch-up. Emit a
        // lifecycle event so the caller can decide.
        const payload = message.payload as {
          deltas?: AgentDelta[];
          requiresBootstrap?: boolean;
          bootstrapHint?: { reason?: string };
        };
        if (payload.requiresBootstrap) {
          this.emit('bootstrap_required', payload.bootstrapHint ?? {});
        }
        if (Array.isArray(payload.deltas)) {
          for (const delta of payload.deltas) this.processDelta(delta);
        }
      } else if (message.type === 'presence_update') {
        // Server stamps every frame with `kind: 'enter' | 'update' |
        // 'leave'`. Pass it through so downstream reducers (mesh
        // presence stream, app hooks) dispatch on it instead of
        // diffing state.
        const entry: PresenceEntry = {
          kind: message.payload.kind,
          userId: message.payload.userId,
          status: message.payload.status,
          syncGroups: message.payload.syncGroups,
          activity: message.payload.activity,
          isAgent: message.payload.isAgent,
          timestamp: message.payload.timestamp,
          activeIntents: message.payload.activeIntents,
        };
        // Rolling cache — enables synchronous queries and
        // `waitForIntentToClear` without each caller re-subscribing.
        // On `leave` we delete instead of set, so the cache reflects
        // peer departure immediately.
        if (entry.userId) {
          if (entry.kind === 'leave') {
            this.presenceByUserId.delete(entry.userId);
          } else {
            this.presenceByUserId.set(entry.userId, entry);
          }
        }
        this.emit('presence', entry);
      } else if (message.type === 'mutation_result') {
        // Wire format (hub/types.ts MutationResultMessage):
        //   { clientTxId, serverTxId, success, lastSyncId?, error? }
        const { clientTxId, success, lastSyncId, error } = message.payload;
        const pending = this.pendingMutations.get(clientTxId);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pendingMutations.delete(clientTxId);
        if (success) {
          const effective = lastSyncId ?? 0;
          if (effective > this.lastSyncId) this.lastSyncId = effective;
          pending.resolve({ lastSyncId: effective });
        } else {
          // Revive the typed error class from the server's `{code, message}`
          // envelope. Without this, `instanceof AbloStaleContextError`
          // (etc.) fails on the WS path even when the HTTP path preserves it.
          pending.reject(reviveAgentMutationError(error));
        }
      } else if (message.type === 'intent_rejected') {
        // Server rejected an `intent_begin` because another participant
        // already holds an open claim on the same target. Emit on the
        // `intent_rejected` bus so the mesh-level IntentStream can
        // surface this to the caller. Cooperative mutex → enforced
        // mutex at the server boundary.
        this.emit('intent_rejected', message.payload);
      }
    } catch { /* ignore malformed messages */ }
  }

  private processDelta(delta: AgentDelta): void {
    if (delta.id > this.lastSyncId) this.lastSyncId = delta.id;

    const data = typeof delta.data === 'string' ? JSON.parse(delta.data as string) : delta.data;

    if (delta.actionType === 'I' || delta.actionType === 'U') {
      const entity = {
        ...(this.entityCache.get(delta.modelId) ?? {}),
        ...data,
        id: delta.modelId,
        __modelName: delta.modelName,
      };
      this.entityCache.set(delta.modelId, entity);

      // Notify reactive query views
      if (delta.actionType === 'I') {
        this.viewRegistry.notifyAdded(delta.modelName, entity);
      } else {
        this.viewRegistry.notifyUpdated(delta.modelName, entity);
      }
    } else if (delta.actionType === 'D') {
      this.entityCache.delete(delta.modelId);
      this.viewRegistry.notifyRemoved(delta.modelName, delta.modelId);
    }

    for (const sub of this.subscriptions) {
      if (sub.modelName !== delta.modelName) continue;
      if (sub.filter?.where && !this.matchesFilter(data, sub.filter.where)) continue;
      try {
        const result = sub.handler(data, delta);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch(() => {});
        }
      } catch { /* ignore handler errors */ }
    }

    this.emit('delta', delta);
  }

  private matchesFilter(entity: Record<string, unknown>, where: Record<string, unknown>): boolean {
    for (const [key, value] of Object.entries(where)) {
      if (entity[key] !== value) return false;
    }
    return true;
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) return;
    const delay = Math.min(this.options.reconnectDelay * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    setTimeout(() => {
      if (!this.disposed) this.connect().catch(() => {});
    }, delay);
  }
}
