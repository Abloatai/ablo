/**
 * bootstrapApply — applying bootstrap results to the in-memory pool.
 *
 * Extracted from BaseSyncedStore.ts as a cohesive leaf: routing a
 * full/partial bootstrap result through the pool-write facade, collecting
 * the delta-protected ids that must survive ghost removal, and replaying
 * the deltas queued during an active bootstrap. The store keeps thin
 * protected delegates with unchanged signatures and talks back through the
 * minimal {@link PoolContext} — never the store's class type — so no
 * module cycle forms. The heavy lifting (model creation, healing, upsert,
 * ghost removal) stays owned by `SyncClient`.
 */

import { getContext } from '../context.js';
import type { BootstrapResult } from '../Database.js';
import type { SyncDelta } from './SyncWebSocket.js';

/** Rehydration statistics from bootstrap */
export interface RehydrationStats {
  added: number;
  updated: number;
  removed: number;
  skipped: number;
  healed: number;
  elapsedMs: number;
}

/**
 * What the bootstrap-apply path needs back from its host store. The two
 * `SyncClient` facades come with enrichment pre-bound by the host, so the
 * store's `enrichRelations` override point keeps its dynamic dispatch.
 */
export interface PoolContext {
  /** `SyncClient.applyDeltaBatchToPool` with the host's `enrichRelations` bound. */
  applyDeltaBatchToPool(results: NonNullable<BootstrapResult['deltaResults']>): void;
  /** `SyncClient.applyBootstrapDataToPool` — model creation, healing, pool upsert, ghost removal. */
  applyBootstrapDataToPool(
    bootstrapData: { models?: Record<string, unknown[]>; failedModels?: string[] },
    protectedIds?: ReadonlySet<string>,
  ): { added: number; updated: number; removed: number; skipped: number; healed: number };
  /** Pool size — for the completion log line. */
  getPoolSize(): number;
  /** Every id currently in the pool — for delta-protected-id collection. */
  getAllPoolIds(): string[];
  /** Deltas queued during an active bootstrap; null when none is in flight.
   *  Backed by the host's `bootstrapDeltaQueue` field (get/set accessors). */
  bootstrapDeltaQueue: SyncDelta[] | null;
  /** The host's atomic frame apply — `applyDeltaFrame` deliberately stays
   *  in BaseSyncedStore (the authoritative-apply correctness seam). */
  applyDeltaFrame(deltas: SyncDelta[]): void;
}

/** Apply bootstrap data to the ObjectPool with ghost removal */
/** Apply bootstrap data to the ObjectPool. Delegates pool writes to SyncClient. */
export function applyBootstrapToPool(
  ctx: PoolContext,
  bootstrapResult: BootstrapResult,
  protectedIds?: ReadonlySet<string>,
): RehydrationStats {
  const { bootstrapData } = bootstrapResult;

  // Partial bootstrap: Database.processDeltaBatch already wrote the deltas
  // to IDB. Route the same results through the delta-apply path so the
  // in-memory pool evicts deleted entities (and updates modified ones).
  // Without this, reconnect DELETEs persist to IDB but the canvas keeps
  // showing ghost layers until a full reload.
  if (bootstrapData.type === 'partial') {
    const deltaResults = bootstrapResult.deltaResults;
    if (deltaResults && deltaResults.length > 0) {
      ctx.applyDeltaBatchToPool(deltaResults);
    }
    return { added: 0, updated: 0, removed: 0, skipped: 0, healed: 0, elapsedMs: 0 };
  }

  if (!bootstrapData.models) {
    return { added: 0, updated: 0, removed: 0, skipped: 0, healed: 0, elapsedMs: 0 };
  }

  const start = typeof performance !== 'undefined' ? performance.now() : Date.now();

  // SyncClient owns: model creation, healing, pool upsert, ghost removal
  const stats = ctx.applyBootstrapDataToPool(bootstrapData, protectedIds);

  const elapsedMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - start);

  getContext().logger.info('[BaseSyncedStore] Bootstrap applied', {
    ...stats, elapsedMs, poolSize: ctx.getPoolSize(),
  });

  return { ...stats, elapsedMs };
}

/** Collect IDs that must survive ghost removal (added by deltas during bootstrap) */
export function collectDeltaProtectedIds(
  ctx: PoolContext,
  preBootstrapIds: ReadonlySet<string>,
): Set<string> {
  const protectedIds = new Set<string>();
  for (const id of ctx.getAllPoolIds()) {
    if (!preBootstrapIds.has(id)) protectedIds.add(id);
  }
  for (const delta of ctx.bootstrapDeltaQueue ?? []) {
    if (delta.actionType !== 'D' && delta.modelId) protectedIds.add(delta.modelId);
  }
  return protectedIds;
}

/** Replay deltas queued during bootstrap */
export function replayQueuedDeltas(ctx: PoolContext): void {
  const queue = ctx.bootstrapDeltaQueue;
  ctx.bootstrapDeltaQueue = null;
  if (!queue || queue.length === 0) return;
  // Deltas that landed during bootstrap are a complete frame — apply
  // them atomically (one flush, one re-render) rather than dribbling
  // each back through the live debounce path.
  ctx.applyDeltaFrame(queue);
}
