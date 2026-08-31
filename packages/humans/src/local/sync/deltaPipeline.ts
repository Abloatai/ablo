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
import {
  observeDrainBatch,
  observeDrainAcknowledge,
  timeDrainStage,
  timeDrainStageAsync,
  openDrainBatchRow,
  closeDrainBatchRow,
} from './drainProfile.js';

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
  readonly smartSyncOptions: {
    readonly batchingDelay: number;
    readonly maxBatchSize: number;
    readonly applySliceDeltas: number;
  };
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
  /** Optional whole-batch projection performed before bounded apply slicing. */
  projectDeltaBatchForPool?(results: readonly AppliedChange[]): readonly AppliedChange[];
  /** Acknowledges a sync id back to the server; a no-op when the socket is down. */
  acknowledge(syncId: number): void;

  // ── Custom-entity pool ops (deltas that skip the local store) ──
  readonly objectPool: {
    /** Ingestion-side lookup — resolves without activating observability. */
    peek(id: string): Model | undefined;
    add(model: Model, scope: ModelScope): void;
    remove(id: string): boolean;
    /** Full in-memory clear — the revocation-failure fallback (see
     *  {@link handleGroupHandlerFailure}). */
    clear(): void;
  };

  // ── Dynamic-dispatch hooks back into the store (protected override points) ──
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

/**
 * Deduplicate repeated delivery of the same log entry.
 *
 * A row may legitimately change several times in one receive frame. Those
 * changes are ordered facts, even when a small subset of fields (such as
 * `status`) happens to remain equal. Collapsing by entity or a partial state
 * signature can therefore discard the newest row image while the cursor still
 * advances past it. Only an identical positive sync id proves duplicate
 * delivery; non-positive ids carry no usable log identity and stay untouched.
 */
export function deduplicateDeltas(deltas: SyncDelta[]): SyncDelta[] {
  if (deltas.length < 2 || deltas.some((delta) => delta.id <= 0)) return deltas;

  let strictlyOrdered = true;
  for (let index = 1; index < deltas.length; index += 1) {
    if (deltas[index - 1]!.id >= deltas[index]!.id) {
      strictlyOrdered = false;
      break;
    }
  }
  if (strictlyOrdered) return deltas;

  const seen = new Set<number>();
  return [...deltas]
    .sort((a, b) => a.id - b.id)
    .filter((delta) => {
      if (seen.has(delta.id)) return false;
      seen.add(delta.id);
      return true;
    });
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
  pipelineDebug.enqueued += 1;
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
      // replication keepalives. Give the host one macroitem turn between
      // owned batches; Node has setImmediate, browsers fall back to a timer.
      await yieldToHost();
    }
  }

  if (ctx.batchTimer) {
    clearTimeout(ctx.batchTimer);
    ctx.batchTimer = null;
  }
}

/**
 * Uninterrupted apply time allowed before the sliced loop yields — the
 * "no visible stall" bound. Yields are amortized against it because one host
 * yield costs milliseconds under load; at the measured per-delta apply cost
 * this works out to roughly one yield per one to two 600-delta slices.
 */
const APPLY_YIELD_BUDGET_MS = 12;

/**
 * Wedge forensics: where the pipeline currently is, updated synchronously at
 * every stage boundary. A hang diagnoses itself by which counter pair
 * diverged and which phase the active flush froze in. Mirrored onto
 * `globalThis.__abloPipelineDebug` so a bench watchdog in the same thread
 * can read it without an import path into SDK internals — diagnostics only,
 * a handful of numbers, no payload data.
 */
export const pipelineDebug = {
  flushesStarted: 0,
  flushesSettled: 0,
  persistsStarted: 0,
  persistsSettled: 0,
  applySlices: 0,
  applyYields: 0,
  enqueued: 0,
  phase: 'idle' as string,
};
(globalThis as { __abloPipelineDebug?: typeof pipelineDebug }).__abloPipelineDebug =
  pipelineDebug;

/**
 * Split applied changes into slices of at most `maxDeltas`, never splitting a
 * transaction: consecutive changes sharing a `transactionId` form one
 * indivisible group (a commit reveals whole), while changes without one are
 * individually splittable. A single transaction larger than the bound forms
 * its own oversized slice, so apply always advances rather than stalling on
 * an oversized commit — the same rule the server's publication chunking uses.
 */
export function sliceApplyChanges<T extends { readonly transactionId?: string }>(
  changes: readonly T[],
  maxDeltas: number,
): readonly T[][] {
  if (changes.length <= maxDeltas) return changes.length > 0 ? [[...changes]] : [];
  const slices: T[][] = [];
  let current: T[] = [];
  let index = 0;
  while (index < changes.length) {
    // The indivisible unit starting here: one transaction's run, or a single
    // untransacted change.
    const transactionId = changes[index]!.transactionId;
    let end = index + 1;
    if (transactionId !== undefined) {
      while (end < changes.length && changes[end]!.transactionId === transactionId) end += 1;
    }
    const groupSize = end - index;
    if (current.length > 0 && current.length + groupSize > maxDeltas) {
      slices.push(current);
      current = [];
    }
    current.push(...changes.slice(index, end));
    index = end;
  }
  if (current.length > 0) slices.push(current);
  return slices;
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
  openDrainBatchRow(queuedDeltas.length);
  pipelineDebug.flushesStarted += 1;
  try {
    await flushDeltaBatchInner(ctx, queuedDeltas);
  } finally {
    pipelineDebug.flushesSettled += 1;
    pipelineDebug.phase = 'idle';
    closeDrainBatchRow();
  }
}

async function flushDeltaBatchInner(
  ctx: DeltaPipelineContext,
  queuedDeltas: SyncDelta[],
): Promise<void> {
  const stagePlugins = ctx.stagePlugins ?? [];
  pipelineDebug.phase = 'dedupe';
  const deduplicatedDeltas = timeDrainStage('dedupe', () => ctx.deduplicateDeltas(queuedDeltas));
  observeDrainBatch(queuedDeltas.length, deduplicatedDeltas.length);
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
          const existing = ctx.objectPool.peek(delta.modelId);
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
  pipelineDebug.phase = 'persist';
  pipelineDebug.persistsStarted += 1;
  const batch = await timeDrainStageAsync('persist', () =>
    ctx.processDeltaBatch(
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
    )
  );
  pipelineDebug.persistsSettled += 1;
  const dbResults = batch.results;
  runStage(stagePlugins, 'persist', { deltas: regularDeltas });

  // Apply the batch results to the in-memory graph. When a plugin has
  // declared the `apply` stage, its handlers ARE the apply — the
  // materialiser attached where it said it would. The direct call is the
  // bridge for stores constructed without plugins (subclasses, tests),
  // whose own apply is the whole pipeline.
  //
  // Large batches apply in TIME SLICES: split at transaction boundaries into
  // bounded chunks with the event loop yielded between them, so a catch-up
  // wave reveals commit-by-commit instead of holding the thread for one long
  // synchronous block. Each slice is still one MobX action (reactions fire
  // once per slice), and a transaction never splits across slices — the
  // commit remains the atomic unit of visibility.
  const poolResults = ctx.projectDeltaBatchForPool?.(dbResults) ?? dbResults;
  const slices = sliceApplyChanges(poolResults, ctx.smartSyncOptions.applySliceDeltas);
  await timeDrainStageAsync('apply', async () => {
    const hasApplyPlugins = pluginsForStage(stagePlugins, 'apply').length > 0;
    // Yield on a TIME budget, not per slice: a host yield costs milliseconds
    // under load (measured ~7x throughput collapse when yielding every few
    // deltas), so the yield decision amortizes it — only after the budget of
    // uninterrupted apply work has been spent, and never before the first
    // slice. Slices stay the atomicity unit; the budget only decides where
    // the loop breathes.
    let sliceStartedAt = performance.now();
    for (let index = 0; index < slices.length; index++) {
      if (index > 0 && performance.now() - sliceStartedAt > APPLY_YIELD_BUDGET_MS) {
        pipelineDebug.phase = `apply-yield-${index}`;
        pipelineDebug.applyYields += 1;
        await yieldToHost();
        sliceStartedAt = performance.now();
      }
      pipelineDebug.phase = `apply-slice-${index}`;
      pipelineDebug.applySlices += 1;
      const slice = slices[index]!;
      if (hasApplyPlugins) {
        runStage(stagePlugins, 'apply', { changes: slice });
      } else {
        ctx.applyDeltaBatchToPool(slice);
      }
    }
  });
  pipelineDebug.phase = 'acknowledge';

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
    timeDrainStage('acknowledge', () => {
      ctx.acknowledge(persistedSyncId);
      ctx.advancePersisted(persistedSyncId);
      observeDrainAcknowledge(persistedSyncId);
      runStage(stagePlugins, 'acknowledge', { syncId: persistedSyncId });
    });
  }

  // Cache invalidation happens automatically via the 'models:changed' event.
  timeDrainStage('notify', () => {
    runStage(stagePlugins, 'notify', { changes: dbResults });
  });
}
