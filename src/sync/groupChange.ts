/**
 * groupChange — sync-group change / shrinkage handling.
 *
 * Extracted from BaseSyncedStore.ts as a cohesive leaf: the 'G'/'S' delta
 * handlers (incremental group-added, legacy group-diff, group-removed), the
 * group-set math, the force-re-bootstrap trigger, and the security-critical
 * shrinkage check. The store keeps thin protected delegates with unchanged
 * signatures — subclass override points stay overridable, and the leaf
 * routes every cross-handler call back through the minimal
 * {@link GroupChangeContext} so dynamic dispatch is preserved.
 */

import { getContext } from '../context.js';
import type {
  SyncDelta,
  SyncGroupChangePayload,
  GroupAddedPayload,
} from './SyncWebSocket.js';

/**
 * What the group-change handlers need back from their host store —
 * narrow collaborator facades plus the host's own protected hooks (so a
 * subclass override of e.g. `forceFullRebootstrap` still takes effect).
 */
export interface GroupChangeContext {
  /** Local persistence — SECURITY clears, subscription metadata, and the
   *  full-bootstrap flag. Structural subset of `Database`. */
  readonly database: {
    clear(): Promise<void>;
    getWorkspaceMetadata(): Promise<{ subscribedSyncGroups?: string[] } | null>;
    updateWorkspaceMetadata(metadata: { subscribedSyncGroups: string[] }): Promise<void>;
    markRequiresFullBootstrap(): void;
  };
  /** The in-memory pool — cleared alongside IDB on revocation. */
  readonly objectPool: { clear(): void };
  /** Groups the CURRENT socket is subscribed to (`syncWebSocket?.getSyncGroups() ?? []`). */
  getSubscribedSyncGroups(): readonly string[];
  /** The session's authoritative groups via the host's `resolveSyncGroups`;
   *  null when no user context has been set yet. */
  getCurrentSyncGroups(): readonly string[] | null;
  /** `userContext?.bootstrapMode` — 'none' participants never re-bootstrap. */
  getBootstrapMode(): 'full' | 'none' | undefined;
  /** Disconnect the live socket (part of the force-re-bootstrap cycle). */
  disconnectWebSocket(): void;
  /** Forward to the host's `onConnectionEvent` lifecycle hook (no-op when unwired). */
  emitConnectionEvent(event: string): void;
  // Dynamic-dispatch hooks back into the store (protected override points).
  handleGroupAdded(payload: GroupAddedPayload, syncId: number): Promise<void>;
  computeUpdatedSyncGroups(payload: SyncGroupChangePayload): string[];
  forceFullRebootstrap(): void;
}

/** Sentinel for a 'G'/'S' payload that could not be parsed (vs a valid
 *  `null`/absent payload, which the handlers already tolerate). */
const MALFORMED_PAYLOAD: unique symbol = Symbol('malformed-group-change-payload');

/**
 * Parse a group-change delta payload without ever throwing. The server
 * serializes these as JSON strings; a corrupt frame used to escape the
 * whole delta pipeline as an unhandled rejection AFTER the watermark had
 * advanced — the delta is never re-delivered, so the security clear it
 * carried was permanently lost.
 */
function parseGroupChangePayload(delta: SyncDelta): unknown {
  if (typeof delta.data !== 'string') return delta.data;
  try {
    return JSON.parse(delta.data);
  } catch (error) {
    getContext().logger.debug('[BaseSyncedStore] Malformed group-change payload', {
      syncId: delta.id,
      actionType: delta.actionType,
      error: error instanceof Error ? error.message : String(error),
    });
    return MALFORMED_PAYLOAD;
  }
}

/**
 * The legacy-clear fallback for an unparseable group-change delta: we know
 * access changed but not how, so treat it as a revocation — clear cached
 * data (IDB + pool) and force a full re-bootstrap with server truth.
 */
async function clearForUnknownGroupChange(
  ctx: GroupChangeContext,
  delta: SyncDelta,
  kind: string,
): Promise<void> {
  getContext().logger.debug(
    `[BaseSyncedStore] Unreadable ${kind} payload — clearing cached data and re-bootstrapping`,
    { syncId: delta.id },
  );
  // SECURITY: same rationale as the legacy removedGroups path — revoked data
  // must not persist if the device goes offline before the re-bootstrap.
  await ctx.database.clear();
  ctx.objectPool.clear();
  ctx.forceFullRebootstrap();
}

/**
 * Handle an actionType 'G' delta.
 *
 * The server emits 'G' via two distinct pathways, distinguished by payload
 * shape:
 *
 *   Incremental (EmitGroupAdded):   { group, userId }
 *     - The recipient was added to a single sync group.
 *     - Subsequent 'C' (Covering) deltas deliver each newly-visible entity.
 *     - No re-bootstrap — entities arrive via the normal insert path.
 *
 *   Legacy (EmitGroupChange):       { addedGroups, removedGroups }
 *     - Single delta carrying the full group membership diff.
 *     - Forces a full re-bootstrap (disconnect + reconnect + fetch all).
 *     - Deprecated on the server; kept here for wire-level backward compat.
 */
export async function handleSyncGroupChange(
  ctx: GroupChangeContext,
  delta: SyncDelta,
): Promise<void> {
  const raw = parseGroupChangePayload(delta);
  if (raw === MALFORMED_PAYLOAD) {
    // Malformed payload — we can't know WHICH groups changed, and this
    // delta will never be re-delivered (the watermark already advanced).
    // Degrade to the legacy security path: assume a removal, clear cached
    // data, and rebuild from server truth. Never throw out of the pipeline.
    await clearForUnknownGroupChange(ctx, delta, 'sync-group change');
    return;
  }
  const rawObj = (raw ?? {}) as Record<string, unknown>;

  // Detect incremental payload shape: { group, userId }
  if (typeof rawObj.group === 'string' && typeof rawObj.userId === 'string') {
    const incremental: GroupAddedPayload = {
      group: rawObj.group,
      userId: rawObj.userId,
    };
    await ctx.handleGroupAdded(incremental, delta.id);
    return;
  }

  // Legacy payload: { addedGroups, removedGroups }
  const payload: SyncGroupChangePayload = {
    removedGroups: (rawObj.removedGroups as string[]) ?? [],
    addedGroups: (rawObj.addedGroups as string[]) ?? [],
  };

  getContext().logger.info('[BaseSyncedStore] Sync group change received (legacy)', {
    removedGroups: payload.removedGroups,
    addedGroups: payload.addedGroups,
    syncId: delta.id,
  });

  // SECURITY: If groups were removed, clear cached data immediately.
  // This prevents revoked data from persisting if the device goes offline
  // before the full re-bootstrap completes.
  if (payload.removedGroups.length > 0) {
    await ctx.database.clear();
    ctx.objectPool.clear();
    getContext().logger.info('[BaseSyncedStore] Cleared cached data due to revoked sync groups', {
      removedGroups: payload.removedGroups,
    });
  }

  const updatedGroups = ctx.computeUpdatedSyncGroups(payload);
  await ctx.database.updateWorkspaceMetadata({ subscribedSyncGroups: updatedGroups });
  ctx.forceFullRebootstrap();
}

/**
 * Handle an incremental GroupAdded delta.
 *
 * Adds the new group to the subscription metadata without triggering a
 * re-bootstrap. The server will follow up with 'C' (Covering) deltas for
 * each newly-visible entity, which flow through the normal insert path.
 */
export async function handleGroupAdded(
  ctx: GroupChangeContext,
  payload: GroupAddedPayload,
  syncId: number,
): Promise<void> {
  getContext().logger.info('[BaseSyncedStore] Group added (incremental)', {
    group: payload.group,
    syncId,
  });

  const current = new Set(ctx.getSubscribedSyncGroups());
  current.add(payload.group);
  await ctx.database.updateWorkspaceMetadata({ subscribedSyncGroups: Array.from(current) });
  // Note: no forceFullRebootstrap() — covering deltas will bring the entities.
}

/**
 * Handle an actionType 'S' (GroupRemoved) delta.
 *
 * Signals that the recipient has lost access to a sync group. Because
 * the client does not track per-entity group membership, we can't
 * selectively purge entities belonging to that group. The safe fallback
 * is the legacy behavior: clear local state and force a re-bootstrap
 * with the updated group list.
 *
 * Future optimization: track group membership in the ObjectPool so 'S'
 * can do a targeted purge instead of a full re-bootstrap.
 */
export async function handleGroupRemoved(
  ctx: GroupChangeContext,
  delta: SyncDelta,
): Promise<void> {
  const raw = parseGroupChangePayload(delta);
  if (raw === MALFORMED_PAYLOAD) {
    // Malformed 'S' payload — access WAS revoked but we can't tell which
    // group. Degrade to the legacy clear (the safe direction for a
    // security delta) instead of throwing out of the pipeline.
    await clearForUnknownGroupChange(ctx, delta, 'group-removed');
    return;
  }
  const rawObj = (raw ?? {}) as Record<string, unknown>;
  const groupKey = typeof rawObj.group === 'string' ? rawObj.group : undefined;

  if (!groupKey) {
    getContext().logger.debug('[BaseSyncedStore] Group removed delta missing group key', {
      syncId: delta.id,
    });
    return;
  }

  getContext().logger.info('[BaseSyncedStore] Group removed', {
    group: groupKey,
    syncId: delta.id,
  });

  // SECURITY: Clear cached data before re-bootstrap. This prevents
  // revoked-group data from persisting if the device goes offline
  // between receiving 'S' and completing the re-bootstrap.
  await ctx.database.clear();
  ctx.objectPool.clear();

  // Update subscription metadata so the re-bootstrap fetches the
  // correct set of groups.
  const current = new Set(ctx.getSubscribedSyncGroups());
  current.delete(groupKey);
  await ctx.database.updateWorkspaceMetadata({ subscribedSyncGroups: Array.from(current) });

  ctx.forceFullRebootstrap();
}

/** Compute new sync groups after applying additions and removals */
export function computeUpdatedSyncGroups(
  ctx: GroupChangeContext,
  payload: SyncGroupChangePayload,
): string[] {
  const current = new Set(ctx.getSubscribedSyncGroups());
  for (const g of payload.removedGroups) current.delete(g);
  for (const g of payload.addedGroups) current.add(g);
  return Array.from(current);
}

/** Force a full re-bootstrap via connection lifecycle event.
 *
 * No-op for `bootstrapMode: 'none'` participants — they never pull
 * baseline state, so a "force re-bootstrap" trigger (sync-group
 * shrink, scope revocation) instead just flushes the local pool and
 * relies on covering deltas to repopulate the data they actually
 * subscribe to.
 */
export function forceFullRebootstrap(ctx: GroupChangeContext): void {
  if (ctx.getBootstrapMode() === 'none') {
    getContext().logger.info(
      '[BaseSyncedStore] forceFullRebootstrap skipped (bootstrapMode=none)',
    );
    return;
  }
  ctx.database.markRequiresFullBootstrap();
  ctx.disconnectWebSocket();
  ctx.emitConnectionEvent('WS_DISCONNECTED');
}

/**
 * Single source of truth for the sync-group list this session is
 * subscribed to. Server-issued (`context.syncGroups`) is authoritative.
 * When absent, the SDK subscribes to no explicit groups. Both
 * `checkSyncGroupShrinkage` and `setupWebSocketSync` resolve through
 * here so the WS subscription and the security-critical shrinkage
 * check can never disagree.
 */
export function resolveSyncGroups(context: {
  syncGroups?: readonly string[];
}): readonly string[] {
  if (context.syncGroups && context.syncGroups.length > 0) {
    return context.syncGroups;
  }
  return [];
}

/** Check if sync groups shrank since last session — force full bootstrap if so */
export async function checkSyncGroupShrinkage(ctx: GroupChangeContext): Promise<void> {
  const currentSyncGroups = ctx.getCurrentSyncGroups();
  if (!currentSyncGroups) return;

  try {
    const metadata = await ctx.database.getWorkspaceMetadata();
    const stored = metadata?.subscribedSyncGroups ?? [];
    if (stored.length === 0) return;

    const currentGroups = new Set(currentSyncGroups);

    const removedGroups = stored.filter((g: string) => !currentGroups.has(g));

    if (removedGroups.length > 0) {
      getContext().logger.info('[BaseSyncedStore] Sync groups shrank — forcing full bootstrap', {
        removedGroups,
        storedCount: stored.length,
        currentCount: currentGroups.size,
      });

      // SECURITY: Clear cached data before re-bootstrap to prevent
      // revoked-group data from persisting if device goes offline
      await ctx.database.clear();
      ctx.objectPool.clear();

      ctx.database.markRequiresFullBootstrap();
    }

    await ctx.database.updateWorkspaceMetadata({
      subscribedSyncGroups: Array.from(currentGroups),
    });
  } catch (error) {
    getContext().logger.debug('[BaseSyncedStore] Failed to check sync group shrinkage', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
