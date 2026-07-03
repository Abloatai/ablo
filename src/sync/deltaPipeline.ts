/**
 * deltaPipeline — the incoming-delta dedup/batch/flush pipeline.
 *
 * Extracted from BaseSyncedStore.ts as a cohesive leaf: state-signature
 * dedup, per-delta bookkeeping + enqueue, the live-traffic debounce, and
 * the IDB→pool flush. The store keeps thin protected delegates with
 * unchanged signatures, and the leaf routes every call to a protected
 * override point (getStateFields, isCustomEntity, deduplicateDeltas,
 * flushPendingDeltas, the G/S handlers, …) back through the minimal
 * {@link DeltaPipelineContext} so subclass dynamic dispatch is preserved.
 * `applyDeltaFrame` — the authoritative-apply correctness seam — stays in
 * BaseSyncedStore and drives this pipeline via `enqueueDelta` +
 * `flushPendingDeltas`.
 */

import { runInAction } from 'mobx';
import { getContext } from '../context.js';
import { ModelScope } from '../ObjectPool.js';
import type { Model } from '../Model.js';
import type { ModelData } from '../types/modelData.js';
import type { SyncDelta } from './SyncWebSocket.js';

/** One applied-delta result out of `Database.processDeltaBatch`, forwarded to the pool. */
interface DeltaDbResult {
  action: 'add' | 'update' | 'remove' | 'archive' | 'verify';
  modelName: string;
  modelId: string;
  data?: ModelData | null;
  transactionId?: string;
}

/**
 * What the pipeline needs back from its host store: the shared mutable
 * pipeline state (backed by host fields via get/set accessors), narrow
 * persistence/pool facades, and the host's own protected hooks so subclass
 * overrides keep taking effect.
 */
export interface DeltaPipelineContext {
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
  onDeltaReceived(syncId: number): void;
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
  ): Promise<{ results: DeltaDbResult[]; persistedSyncId: number }>;
  /** `SyncClient.applyDeltaBatchToPool` with the host's `enrichRelations` bound. */
  applyDeltaBatchToPool(results: DeltaDbResult[]): void;
  /** `syncWebSocket?.acknowledge?.(syncId)` — no-op when the socket is down. */
  acknowledge(syncId: number): void;

  // ── Custom-entity pool ops (deltas that skip IDB) ──
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
 * A 'G'/'S' handler rejected AFTER the applied watermark already advanced —
 * the delta will never be re-delivered, so a failed SECURITY clear (revoked
 * data must not persist) would otherwise be permanently silent. Fall back to
 * the bluntest safe response: drop the whole in-memory pool and force a full
 * re-bootstrap so local state is rebuilt from server truth. Never throws —
 * this runs inside the delta pipeline's fire-and-forget seam.
 */
export function handleGroupHandlerFailure(
  ctx: DeltaPipelineContext,
  delta: SyncDelta,
  error: unknown,
): void {
  getContext().logger.error(
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

/** State signature for delta deduplication */
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
 * Per-delta bookkeeping + enqueue. Returns `true` when the delta was
 * pushed onto `pendingDeltas` (a regular batchable I/U/C/D delta that a
 * subsequent flush must drain), `false` when it was skipped (dedup),
 * deferred (bootstrap queue), or handled immediately out-of-band (G/S
 * sync-group mutations). Does NOT schedule a flush — callers decide
 * whether to debounce (live) or flush atomically (catch-up frame).
 */
export function enqueueDelta(
  ctx: DeltaPipelineContext,
  delta: SyncDelta,
  options: { authoritative?: boolean } = {},
): boolean {
  // Dedup guard — skip already-processed deltas. The `applied` watermark is a
  // valid skip threshold ONLY for in-order live traffic; an authoritative
  // catch-up frame bypasses it (see `applyDeltaFrame`) so an out-of-order
  // live delta that advanced the watermark can't cause the frame's lower ids
  // to be silently dropped.
  if (!options.authoritative && delta.id > 0 && delta.id <= ctx.highestProcessedSyncId) {
    return false;
  }

  // Confirm awaiting transactions via sync ID threshold (before batching)
  ctx.onDeltaReceived(delta.id);

  // Queue during active bootstrap
  if (ctx.bootstrapDeltaQueue !== null) {
    ctx.bootstrapDeltaQueue.push(delta);
    return false;
  }

  // Advance watermark
  ctx.advanceApplied(delta.id);

  // Sync group added — handle immediately. Supports both legacy
  // (addedGroups/removedGroups) and incremental (group/userId) payloads.
  // NOT fire-and-forget: the watermark above already advanced, so a rejected
  // handler (a failed security clear) must trigger the fallback, not vanish.
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

  // DELETE — fire the cascade cancel immediately (O(1) via FK index;
  // must run BEFORE any subsequent update on the same model lands so
  // pending update transactions for soon-deleted children don't race
  // their parent's delete) but route the IDB+pool write through the
  // same batched path as UPDATEs. The previous immediate-flush path
  // produced N IDB writes + N pool mutations + N `models:changed`
  // events when a peer deleted a chart with N layers; the batched
  // path produces one of each per microtask flush. Dedup in
  // `flushPendingDeltas` handles the U-then-D-on-same-model case
  // correctly via arrival-order replay through `processDeltaBatch`.
  if (delta.actionType === 'D') {
    ctx.cascadeCancelTransactionsForDeletedParent(delta.modelName, delta.modelId);
  }

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

/** Flush pending deltas with deduplication and batched ObjectPool mutations */
/** Flush pending deltas with deduplication. Delegates pool writes to SyncClient. */
export async function flushPendingDeltas(ctx: DeltaPipelineContext): Promise<void> {
  if (ctx.pendingDeltas.length === 0) return;

  const deduplicatedDeltas = ctx.deduplicateDeltas(ctx.pendingDeltas);

  // Custom entities → apply directly to ObjectPool (skip IDB)
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

  // Regular deltas → IDB then ObjectPool via SyncClient.
  // 'G' and 'S' deltas are routed upstream (handleSyncGroupChange,
  // handleGroupRemoved) and never reach flushPendingDeltas, but the
  // Database.processDelta signature accepts them defensively.
  const regularDeltas = deduplicatedDeltas.filter((d) => !ctx.isCustomEntity(d.modelName));
  const batch = await ctx.processDeltaBatch(
    regularDeltas.map((d) => ({
      syncId: d.id,
      actionType: d.actionType,
      modelName: d.modelName,
      modelId: d.modelId,
      data: typeof d.data === 'string' ? JSON.parse(d.data) : d.data,
      // Thread `transactionId` through so the receive layer can
      // recognize echoes of locally-applied transactions and skip
      // the pool mutation. See `OPTIMISTIC_RECONCILIATION.md`.
      transactionId: d.transactionId,
    }))
  );
  const dbResults = batch.results;

  // Delegate ObjectPool writes to SyncClient (owns pool operations)
  ctx.applyDeltaBatchToPool(dbResults);

  // Acknowledge + advance sync cursor — gated on IDB persistence.
  //
  // We MUST ack `persistedSyncId` (the high-water mark of deltas whose
  // store transaction actually committed), NOT the input batch's last
  // delta id. Acking by input range advances the server's view past
  // deltas that never wrote to IDB; the next catch-up request would
  // then send the advanced cursor and the server replies "you're up
  // to date" — losing the un-persisted delta forever. This is the
  // Replicache "same-transaction" invariant: the cursor and the
  // persisted view must be consistent.
  const persistedSyncId = batch.persistedSyncId;
  if (persistedSyncId > ctx.lastAckedId) {
    ctx.acknowledge(persistedSyncId);
    ctx.advancePersisted(persistedSyncId);
  }

  // Cache invalidation is automatic via SyncClient 'models:changed' event

  ctx.pendingDeltas = [];
  if (ctx.batchTimer) { clearTimeout(ctx.batchTimer); ctx.batchTimer = null; }
}
