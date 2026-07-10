/**
 * Applies a bootstrap result to the in-memory object pool. When a client
 * connects, the server sends either a full snapshot of the models it can see or
 * a partial catch-up of the deltas it missed. These functions route that result
 * into the pool, protect entities that arrived mid-bootstrap from being swept
 * away as stale, and replay any deltas that queued while the bootstrap was in
 * flight.
 *
 * The functions here reach their host store only through the small
 * {@link PoolContext} interface, not the store's concrete class, so the two can
 * reference each other without forming an import cycle. The pool writes
 * themselves — creating models, healing partial rows, upserting, and removing
 * stale local copies the server no longer reports — are performed by the sync
 * client behind that interface.
 */

import { getContext } from '../context.js';
import type { BootstrapResult } from '../Database.js';
import type { SyncDelta } from './SyncWebSocket.js';

/** Counts describing what applying a bootstrap changed in the pool: entities
 *  added, updated, removed, skipped, and healed, plus the elapsed time. */
export interface RehydrationStats {
  added: number;
  updated: number;
  removed: number;
  skipped: number;
  healed: number;
  elapsedMs: number;
}

/**
 * The methods the bootstrap-apply functions call back into on the host store.
 * The two data-application methods arrive with relation enrichment already
 * bound by the host, so a subclass override of how relations are enriched still
 * takes effect through this interface.
 */
export interface PoolContext {
  /** Applies persisted delta results to the in-memory pool, with the host's relation enrichment bound. */
  applyDeltaBatchToPool(results: NonNullable<BootstrapResult['deltaResults']>): void;
  /** Writes bootstrap data into the pool: creates models, heals partial rows, upserts, and removes stale local copies the server no longer reports. */
  applyBootstrapDataToPool(
    bootstrapData: { models?: Record<string, unknown[]>; failedModels?: string[] },
    protectedIds?: ReadonlySet<string>,
  ): { added: number; updated: number; removed: number; skipped: number; healed: number };
  /** Pool size — for the completion log line. */
  getPoolSize(): number;
  /** Every id currently in the pool, used to work out which entities must survive the stale-sweep (see {@link collectDeltaProtectedIds}). */
  getAllPoolIds(): string[];
  /** Deltas that queued while a bootstrap was in flight; null when no bootstrap
   *  is running. The host backs this with a field exposed through accessors. */
  bootstrapDeltaQueue: SyncDelta[] | null;
  /** Applies a complete set of deltas to the pool atomically — one write, one
   *  re-render. This entry point lives on the host, not in this module. */
  applyDeltaFrame(deltas: SyncDelta[]): void;
}

/**
 * Applies a bootstrap result to the in-memory pool and returns what changed.
 * A full bootstrap creates, heals, and upserts models and removes stale local
 * copies the server no longer reports; a partial bootstrap routes the missed
 * deltas through the delta-apply path so deletions evict their entities. See
 * {@link RehydrationStats} for the returned counts.
 */
export function applyBootstrapToPool(
  ctx: PoolContext,
  bootstrapResult: BootstrapResult,
  protectedIds?: ReadonlySet<string>,
): RehydrationStats {
  const { bootstrapData } = bootstrapResult;

  // Partial bootstrap: the missed deltas are already written to the local
  // store. Route the same results through the delta-apply path so the
  // in-memory pool also evicts deleted entities and updates modified ones.
  // Without this, a reconnect delete persists locally but its stale copy
  // lingers in the pool until a full reload.
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

  // Creates models, heals partial rows, upserts, and removes stale local copies.
  const stats = ctx.applyBootstrapDataToPool(bootstrapData, protectedIds);

  const elapsedMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - start);

  getContext().logger.info('[BaseSyncedStore] Bootstrap applied', {
    ...stats, elapsedMs, poolSize: ctx.getPoolSize(),
  });

  return { ...stats, elapsedMs };
}

/** Collects the ids that must survive the post-bootstrap stale-sweep: entities added by deltas that arrived while the bootstrap was in flight. */
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

/** Replays the deltas that queued while a bootstrap was in flight, applying them as one atomic frame. */
export function replayQueuedDeltas(ctx: PoolContext): void {
  const queue = ctx.bootstrapDeltaQueue;
  ctx.bootstrapDeltaQueue = null;
  if (!queue || queue.length === 0) return;
  // Deltas that landed during bootstrap are a complete frame — apply
  // them atomically (one flush, one re-render) rather than dribbling
  // each back through the live debounce path.
  ctx.applyDeltaFrame(queue);
}
