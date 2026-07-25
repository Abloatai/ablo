/**
 * The pipeline that takes incoming deltas from the server and lands them in
 * local state. It has four stages: deduplicating deltas by state signature,
 * per-delta bookkeeping and enqueue, a debounce for live traffic, and a flush
 * that writes to the local store and then the in-memory pool. Every call it
 * makes back into the surrounding store — resolving state fields, identifying
 * custom entities, deduplicating, flushing, handling sync-group changes —
 * routes through the {@link DeltaPipelineContext} interface, so a subclass that
 * overrides any of those hooks still takes effect. The atomic frame-apply entry
 * point lives on the store and drives this pipeline through {@link enqueueDelta}
 * and {@link flushPendingDeltas}.
 */

import { runInAction } from 'mobx';
import { globalRuntime } from '../context.js';
import type { RuntimeContext } from '../RuntimeContext.js';
import { ModelScope } from '../InstanceCache.js';
import type { Model } from '../Model.js';
import type { SyncDelta } from './SyncWebSocket.js';
import type { ModelData } from '@abloatai/transaction/types/modelData';
import {
  runStage,
  pluginsForStage,
  type AbloPlugin,
  type AppliedChange,
} from '../../plugin.js';

/**
 * What the pipeline needs back from the surrounding store: the shared mutable
 * pipeline state (backed by the store's own fields through accessors), narrow
 * persistence and pool facades, and the store's overridable hooks, so a
 * subclass's overrides continue to take effect.
 */
export interface DeltaPipelineContext {
  /** The owning client's runtime. Defaults to the module-global bridge. */
  readonly runtime?: RuntimeContext;
  /**
   * The installed plugins, whose declared stage handlers this pipeline
   * dispatches at each boundary. Empty (or absent) on directly-constructed
   * stores, where the store's own apply is the whole pipeline.
   */
  readonly stagePlugins?: readonly AbloPlugin[];
  // ── Shared pipeline state (host fields behind accessors) ──
  pendingDeltas: SyncDelta[];
  batchTimer: ReturnType<typeof setTimeout> | null;
  /** Queue for deltas arriving during an active bootstrap; null when none. */
  readonly bootstrapDeltaQueue: SyncDelta[] | null;
  readonly smartSyncOptions: { readonly batchingDelay: number; readonly maxBatchSize: number };
  /** Pool-applied cursor (`syncClient.position.applied`). */
  readonly highestProcessedSyncId: number;
  /** Resume/ack cursor (`syncClient.position.persisted`). */
  readonly lastAckedId: number;

  // ── SyncClient position/transaction bookkeeping ──
  onDeltaReceived(
    syncId: number,
    transactionId?: string,
    correlationId?: string,
  ): void;
  advanceApplied(syncId: number): void;
  advancePersisted(syncId: number): void;

  // ── Persistence + pool writes ──
  processDeltaBatch(
    deltas: {
      syncId?: number;
      actionType: SyncDelta['actionType'];
      modelName: string;
      modelId: string;
      data: ModelData | null;
      transactionId?: string;
    }[],
  ): Promise<{ results: AppliedChange[]; persistedSyncId: number }>;
  /** Applies persisted delta results to the in-memory pool, with the host's relation enrichment bound. */
  applyDeltaBatchToPool(results: AppliedChange[]): void;
  /** Acknowledges a sync id back to the server; a no-op when the socket is down. */
  acknowledge(syncId: number): void;

  // ── Custom-entity pool ops (deltas that skip the local store) ──
  readonly objectPool: {
    get(id: string): Model | undefined;
    add(model: Model, scope: ModelScope): void;
    remove(id: string): boolean;
    /** Full in-memory clear — the revocation-failure fallback (see
     *  {@link handleGroupHandlerFailure}). */
    clear(): void;
  };

  // ── Dynamic-dispatch hooks back into the store (protected override points) ──
  getStateFields(modelName: string): string[];
  isCustomEntity(modelName: string): boolean;
  createCustomEntity(modelName: string, modelId: string, data: Record<string, unknown>): Model | null;
  deduplicateDeltas(deltas: SyncDelta[]): SyncDelta[];
  flushPendingDeltas(): Promise<void>;
  handleFlushError(error: unknown): void;
  handleSyncGroupChange(delta: SyncDelta): Promise<void>;
  handleGroupRemoved(delta: SyncDelta): Promise<void>;
  /** Host's re-bootstrap trigger — the revocation-failure fallback. */
  forceFullRebootstrap(): void;
  cascadeCancelTransactionsForDeletedParent(parentModelName: string, parentId: string): void;
}

/**
 * One drain per store. Incoming WebSocket frames may arrive while persistence
 * and pool application are awaiting. Without a single-flight guard every
 * frame starts another flush over the same mutable queue, duplicating work and
 * allowing acknowledgements to race.
 *
 * The context object is memoized by BaseSyncedStore, so a WeakMap keeps this
 * coordination private to the pipeline without adding lifecycle state to the
 * public store surface.
 */
const activeFlushes = new WeakMap<DeltaPipelineContext, Promise<void>>();

/**
 * Handles a sync-group ('G' or 'S') delta whose handler rejected after the
 * applied watermark had already advanced. That delta will never be redelivered,
 * so a failed security clear — revoked data that must not stay cached — would
 * otherwise fail silently. The safe fallback is blunt: drop the whole in-memory
 * pool and force a full re-bootstrap, rebuilding local state from the server.
 * It never throws, because it runs inside the pipeline's fire-and-forget path.
 */
export function handleGroupHandlerFailure(
  ctx: DeltaPipelineContext,
  delta: SyncDelta,
  error: unknown,
): void {
  (ctx.runtime ?? globalRuntime).logger.error(
    'Your access changed but cached data could not be cleared — resetting local data.',
    {
      syncId: delta.id,
      error: error instanceof Error ? error.message : String(error),
    },
  );
  try {
    ctx.objectPool.clear();
  } catch {
    // In-memory clear must never mask the re-bootstrap below.
  }
  try {
    ctx.forceFullRebootstrap();
  } catch {
    // Best-effort: the reconnect/bootstrap cycle self-heals on next connect.
  }
}

/** Builds a small signature of a delta's state fields, used to detect no-op duplicate deltas. */
function extractStateSignature(
  ctx: DeltaPipelineContext,
  delta: SyncDelta,
): Record<string, unknown> | null {
  if (!delta.data || typeof delta.data !== 'object') return null;

  const data = typeof delta.data === 'string'
    ? (JSON.parse(delta.data) as Record<string, unknown>)
    : (delta.data);

  // Generic state fields — subclasses can override getStateFields() for model-specific fields
  const fieldsToCheck = ctx.getStateFields(delta.modelName);
  const signature: Record<string, unknown> = {
    actionType: delta.actionType,
    modelName: delta.modelName,
  };

  for (const field of fieldsToCheck) {
    if (field in data) signature[field] = data[field];
  }

  return signature;
}

function isSameState(a: Record<string, unknown> | null, b: Record<string, unknown> | null): boolean {
  if (!a || !b) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => a[k] === b[k]);
}

/** Deduplicate deltas to the same entity — keep meaningful state transitions only */
export function deduplicateDeltas(ctx: DeltaPipelineContext, deltas: SyncDelta[]): SyncDelta[] {
  // The dominant live-publication shape is a frame of independent entity
  // creates. When every entity key occurs once, reconciliation cannot remove
  // or reorder anything: preserve the already commit-ordered input directly
  // and avoid allocating a bucket array, state signature, and two sorts per
  // delta. The first duplicate falls through to the full transition logic.
  const uniqueEntities = new Set<string>();
  let hasDuplicateEntity = false;
  for (const delta of deltas) {
    const key = `${delta.modelName}:${delta.modelId}`;
    if (uniqueEntities.has(key)) {
      hasDuplicateEntity = true;
      break;
    }
    uniqueEntities.add(key);
  }
  if (!hasDuplicateEntity) return deltas;

  const byEntity = new Map<string, SyncDelta[]>();
  for (const d of deltas) {
    const key = `${d.modelName}:${d.modelId}`;
    if (!byEntity.has(key)) byEntity.set(key, []);
    byEntity.get(key)!.push(d);
  }

  const result: SyncDelta[] = [];
  for (const entityDeltas of byEntity.values()) {
    const sorted = entityDeltas.sort((a, b) => a.id - b.id);

    // DELETE wins — it's the final state
    const del = sorted.find((d) => d.actionType === 'D');
    if (del) { result.push(del); continue; }

    // Keep deltas that represent different states
    const unique: SyncDelta[] = [];
    let prev: Record<string, unknown> | null = null;
    for (const d of sorted) {
      const sig = extractStateSignature(ctx, d);
      if (!isSameState(prev, sig)) { unique.push(d); prev = sig; }
    }

    if (unique.length > 0) {
      result.push(...unique);
    } else {
      // `sorted` is never empty (every byEntity bucket gets at least one
      // delta pushed) — the guard only narrows the indexed access.
      const last = sorted.at(-1);
      if (last) result.push(last);
    }
  }

  return result.sort((a, b) => a.id - b.id);
}

/**
 * Performs per-delta bookkeeping and enqueues the delta. Returns `true` when
 * the delta was pushed onto `pendingDeltas` — a regular batchable insert,
 * update, covering, or delete that a later flush must drain — and `false` when
 * it was skipped as a duplicate, deferred into the bootstrap queue, or handled
 * immediately (a 'G'/'S' sync-group change). It does not schedule the flush
 * itself; the caller chooses whether to debounce live traffic or flush a
 * catch-up frame atomically.
 */
export function enqueueDelta(
  ctx: DeltaPipelineContext,
  delta: SyncDelta,
  options: { authoritative?: boolean } = {},
): boolean {
  // Dedup guard — skip already-processed deltas. The `applied` watermark is a
  // valid skip threshold only for in-order live traffic; an authoritative
  // catch-up frame bypasses it, so an out-of-order live delta that advanced the
  // watermark can't cause the frame's lower ids to be dropped silently.
  if (!options.authoritative && delta.id > 0 && delta.id <= ctx.highestProcessedSyncId) {
    return false;
  }

  // Confirm awaiting transactions via sync ID threshold (before batching)
  ctx.onDeltaReceived(delta.id, delta.transactionId, delta.correlationId);

  // Queue during active bootstrap
  if (ctx.bootstrapDeltaQueue !== null) {
    ctx.bootstrapDeltaQueue.push(delta);
    return false;
  }

  // Advance watermark
  ctx.advanceApplied(delta.id);

  // Sync group added — handle immediately. Accepts both the batched
  // (addedGroups/removedGroups) and incremental (group/userId) payloads. This
  // is deliberately not fire-and-forget: the watermark has already advanced, so
  // a rejected handler (a failed security clear) must trigger the fallback
  // rather than vanish.
  if (delta.actionType === 'G') {
    void ctx.handleSyncGroupChange(delta).catch((error: unknown) => {
      handleGroupHandlerFailure(ctx, delta, error);
    });
    return false;
  }

  // Sync group removed — handle immediately. Clears affected local state
  // and forces re-bootstrap with the updated group list. Same fallback:
  // a failed revocation clear escalates instead of leaving revoked rows.
  if (delta.actionType === 'S') {
    void ctx.handleGroupRemoved(delta).catch((error: unknown) => {
      handleGroupHandlerFailure(ctx, delta, error);
    });
    return false;
  }

  // Delete — run the cascade cancel immediately (O(1) through the foreign-key
  // index; it must run before any later update on the same model lands, so
  // pending update transactions for soon-deleted children don't race their
  // parent's delete). The persistence and pool write still goes through the
  // same batched path as updates: flushing each delete on its own produced one
  // store write, one pool mutation, and one `models:changed` event per row, so
  // deleting a parent with many children fanned out into many of each, whereas
  // the batched path collapses them into one per flush. Deduplication in
  // `flushPendingDeltas` handles an update-then-delete on the same model by
  // replaying in arrival order.
  if (delta.actionType === 'D') {
    ctx.cascadeCancelTransactionsForDeletedParent(delta.modelName, delta.modelId);
  }

  // The delta is accepted and queued — the `receive` stage boundary.
  runStage(ctx.stagePlugins ?? [], 'receive', { delta });
  ctx.pendingDeltas.push(delta);
  return true;
}

/** Debounce a flush for live single-delta traffic. */
export function scheduleDeltaFlush(ctx: DeltaPipelineContext): void {
  if (ctx.batchTimer) clearTimeout(ctx.batchTimer);

  if (ctx.pendingDeltas.length >= ctx.smartSyncOptions.maxBatchSize) {
    void ctx.flushPendingDeltas().catch(ctx.handleFlushError);
  } else {
    ctx.batchTimer = setTimeout(() => {
      void ctx.flushPendingDeltas().catch(ctx.handleFlushError);
    }, ctx.smartSyncOptions.batchingDelay);
  }
}

/** Apply an authoritative delta frame as one atomic flush. */
export function applyDeltaFrame(ctx: DeltaPipelineContext, deltas: SyncDelta[]): void {
  let enqueuedAny = false;
  for (const delta of deltas) {
    if (enqueueDelta(ctx, delta, { authoritative: true })) enqueuedAny = true;
  }
  if (!enqueuedAny) return;
  if (ctx.batchTimer) {
    clearTimeout(ctx.batchTimer);
    ctx.batchTimer = null;
  }
  void ctx.flushPendingDeltas().catch(ctx.handleFlushError);
}

/**
 * Flushes the queued deltas: deduplicates them, applies custom-entity deltas
 * straight to the pool, writes the rest to the local store and then the pool,
 * and advances the acknowledgement cursor once the store write has committed.
 */
export async function flushPendingDeltas(ctx: DeltaPipelineContext): Promise<void> {
  const activeFlush = activeFlushes.get(ctx);
  if (activeFlush) return activeFlush;

  const flush = drainPendingDeltas(ctx);
  activeFlushes.set(ctx, flush);
  try {
    await flush;
  } finally {
    if (activeFlushes.get(ctx) === flush) activeFlushes.delete(ctx);
  }
}

/**
 * Detaches each batch before its first await, then keeps draining anything
 * that arrived in the meantime. Detaching is the critical ownership transfer:
 * a later frame appends to a fresh queue instead of observing and reprocessing
 * the batch currently being persisted.
 */
async function drainPendingDeltas(ctx: DeltaPipelineContext): Promise<void> {
  while (ctx.pendingDeltas.length > 0) {
    if (ctx.batchTimer) {
      clearTimeout(ctx.batchTimer);
      ctx.batchTimer = null;
    }

    const queuedDeltas = ctx.pendingDeltas;
    ctx.pendingDeltas = [];
    try {
      await flushDeltaBatch(ctx, queuedDeltas);
    } catch (error) {
      // Preserve the pre-existing retry contract. The failed detached batch
      // goes back ahead of deltas received while it was in flight.
      ctx.pendingDeltas = [...queuedDeltas, ...ctx.pendingDeltas];
      throw error;
    }

    if (ctx.pendingDeltas.length > 0) {
      // A sustained stream can refill the detached queue before every
      // persistence promise settles. Promise-only looping then forms an
      // unbounded microtask chain that starves WebSocket reads, timers and
      // replication keepalives. Give the host one macrotask turn between
      // owned batches; Node has setImmediate, browsers fall back to a timer.
      await yieldToHost();
    }
  }

  if (ctx.batchTimer) {
    clearTimeout(ctx.batchTimer);
    ctx.batchTimer = null;
  }
}

function yieldToHost(): Promise<void> {
  const immediate = (
    globalThis as {
      setImmediate?: (callback: () => void) => unknown;
    }
  ).setImmediate;
  return new Promise((resolve) => {
    if (immediate) immediate(resolve);
    else setTimeout(resolve, 0);
  });
}

async function flushDeltaBatch(
  ctx: DeltaPipelineContext,
  queuedDeltas: SyncDelta[],
): Promise<void> {
  const stagePlugins = ctx.stagePlugins ?? [];
  const deduplicatedDeltas = ctx.deduplicateDeltas(queuedDeltas);
  runStage(stagePlugins, 'dedupe', { deltas: deduplicatedDeltas });

  // Custom entities → apply straight to the pool, skipping the local store.
  const customDeltas = deduplicatedDeltas.filter((d) => ctx.isCustomEntity(d.modelName));
  if (customDeltas.length > 0) {
    runInAction(() => {
      for (const delta of customDeltas) {
        const data = typeof delta.data === 'string'
          ? (JSON.parse(delta.data) as Record<string, unknown>)
          : (delta.data!);

        // 'C' (Covering) is treated identically to 'I' here — the client
        // gained permission to see the entity, so we insert it into the
        // pool as if newly created.
        if (delta.actionType === 'I' || delta.actionType === 'U' || delta.actionType === 'C') {
          const existing = ctx.objectPool.get(delta.modelId);
          if (existing) {
            existing.updateFromData(data);
          } else {
            const model = ctx.createCustomEntity(delta.modelName, delta.modelId, data);
            if (model) { model.markAsPersisted(); ctx.objectPool.add(model, ModelScope.live); }
          }
        } else if (delta.actionType === 'D') {
          ctx.objectPool.remove(delta.modelId);
        }
      }
    });
  }

  // Regular deltas → the local store, then the pool.
  // 'G' and 'S' deltas are handled earlier (handleSyncGroupChange /
  // handleGroupRemoved) and never reach here, though the persistence
  // signature accepts them defensively.
  const regularDeltas = deduplicatedDeltas.filter((d) => !ctx.isCustomEntity(d.modelName));
  const batch = await ctx.processDeltaBatch(
    regularDeltas.map((d) => ({
      syncId: d.id,
      actionType: d.actionType,
      modelName: d.modelName,
      modelId: d.modelId,
      data: typeof d.data === 'string' ? JSON.parse(d.data) : d.data,
      // Thread `transactionId` through so the receive layer can recognize
      // echoes of locally-applied transactions and skip the pool mutation.
      transactionId: d.transactionId,
    }))
  );
  const dbResults = batch.results;
  runStage(stagePlugins, 'persist', { deltas: regularDeltas });

  // Apply the batch results to the in-memory graph. When a plugin has
  // declared the `apply` stage, its handlers ARE the apply — the
  // materialiser attached where it said it would. The direct call is the
  // bridge for stores constructed without plugins (subclasses, tests),
  // whose own apply is the whole pipeline.
  if (pluginsForStage(stagePlugins, 'apply').length > 0) {
    runStage(stagePlugins, 'apply', { changes: dbResults });
  } else {
    ctx.applyDeltaBatchToPool(dbResults);
  }

  // Acknowledge and advance the sync cursor, gated on persistence.
  //
  // We must acknowledge `persistedSyncId` — the high-water mark of deltas whose
  // store transaction actually committed — not the input batch's last delta id.
  // Acknowledging the input range would advance the server's view past deltas
  // that never persisted; the next catch-up would then send the advanced cursor,
  // the server would answer "you're up to date", and the unpersisted delta would
  // be lost. The cursor and the persisted state must move together.
  const persistedSyncId = batch.persistedSyncId;
  if (persistedSyncId > ctx.lastAckedId) {
    ctx.acknowledge(persistedSyncId);
    ctx.advancePersisted(persistedSyncId);
    runStage(stagePlugins, 'acknowledge', { syncId: persistedSyncId });
  }

  // Cache invalidation happens automatically via the 'models:changed' event.
  runStage(stagePlugins, 'notify', { changes: dbResults });
}
