/**
 * Handles the delta types that change which sync groups a session can see. A
 * sync group is a fan-out scope the server uses to decide which entities a
 * client receives. When a session's membership changes, these handlers update
 * the client's subscription list; when access is revoked, they clear cached
 * data and trigger a full re-bootstrap so revoked rows cannot linger on the
 * device.
 *
 * Every handler takes a {@link GroupChangeContext}, the narrow facade through
 * which it reaches the client's local storage and connection lifecycle hooks.
 */

import { getContext } from '../context.js';
import type {
  SyncDelta,
  SyncGroupChangePayload,
  GroupAddedPayload,
} from './SyncWebSocket.js';

/**
 * The collaborators the group-change handlers depend on. It gathers the
 * client's local storage, in-memory pool, and connection lifecycle hooks
 * behind one narrow interface, so the handlers stay decoupled from the larger
 * store that supplies them.
 */
export interface GroupChangeContext {
  /**
   * Local persistence. Performs the security clear, reads and writes the
   * subscription metadata, and sets the flag that forces a full bootstrap.
   */
  readonly database: {
    clear(): Promise<void>;
    getWorkspaceMetadata(): Promise<{ subscribedSyncGroups?: string[] } | null>;
    updateWorkspaceMetadata(metadata: { subscribedSyncGroups: string[] }): Promise<void>;
    markRequiresFullBootstrap(): void;
  };
  /** The in-memory object cache, cleared alongside local storage when access is revoked. */
  readonly objectPool: { clear(): void };
  /** Returns the sync groups the live connection is currently subscribed to. */
  getSubscribedSyncGroups(): readonly string[];
  /**
   * Returns the session's authoritative sync groups, resolved from the current
   * user context via {@link resolveSyncGroups}; null when no user context has
   * been set yet.
   */
  getCurrentSyncGroups(): readonly string[] | null;
  /**
   * Returns the session's bootstrap mode. A value of 'none' means the
   * participant never pulls a baseline, so it never re-bootstraps.
   */
  getBootstrapMode(): 'full' | 'none' | undefined;
  /** Disconnects the live connection, one step of the forced re-bootstrap cycle. */
  disconnectWebSocket(): void;
  /** Emits a connection lifecycle event to any registered listener; a no-op when none is set. */
  emitConnectionEvent(event: string): void;
  // Entry points the handlers call into each other through. Routing them via
  // the context keeps any override the surrounding store provides in effect.
  handleGroupAdded(payload: GroupAddedPayload, syncId: number): Promise<void>;
  computeUpdatedSyncGroups(payload: SyncGroupChangePayload): string[];
  forceFullRebootstrap(): void;
}

/**
 * Marker returned when a group-change payload cannot be parsed, kept distinct
 * from a valid null or absent payload, which the handlers accept normally.
 */
const MALFORMED_PAYLOAD: unique symbol = Symbol('malformed-group-change-payload');

/**
 * Parses a group-change delta payload without ever throwing. The server sends
 * these as JSON strings. If a frame is corrupt, this returns
 * {@link MALFORMED_PAYLOAD} rather than raising, because an error escaping here
 * would leave the delta pipeline after the watermark has already advanced. The
 * delta is never re-delivered, so the security clear it carried would be lost.
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
 * Fallback for a group-change delta that could not be read. Because we know
 * access changed but not how, this treats it as a revocation: it clears cached
 * data from both local storage and the in-memory pool, then forces a full
 * re-bootstrap from the server.
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
  // Revoked data must not persist if the device goes offline before the
  // re-bootstrap, the same reasoning as the explicit removed-groups path.
  await ctx.database.clear();
  ctx.objectPool.clear();
  ctx.forceFullRebootstrap();
}

/**
 * Handles a 'G' (group-change) delta. The server sends two shapes of this
 * delta, told apart by the payload:
 *
 *   Incremental — `{ group, userId }`: the recipient was added to a single
 *   sync group. No re-bootstrap follows; the newly visible entities arrive as
 *   ordinary 'C' (covering) deltas through the normal insert path.
 *
 *   Full diff — `{ addedGroups, removedGroups }`: one delta carrying the whole
 *   membership change. This forces a full re-bootstrap (disconnect, reconnect,
 *   and refetch), clearing cached data first if any group was removed.
 */
export async function handleSyncGroupChange(
  ctx: GroupChangeContext,
  delta: SyncDelta,
): Promise<void> {
  const raw = parseGroupChangePayload(delta);
  if (raw === MALFORMED_PAYLOAD) {
    // The payload is unreadable, so we cannot tell which groups changed, and
    // this delta will never be re-delivered because the watermark has already
    // advanced. Fall back to the safe direction: assume a revocation, clear
    // cached data, and rebuild from the server rather than throwing.
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

  // Full-diff payload: { addedGroups, removedGroups }
  const payload: SyncGroupChangePayload = {
    removedGroups: (rawObj.removedGroups as string[]) ?? [],
    addedGroups: (rawObj.addedGroups as string[]) ?? [],
  };

  getContext().logger.info('[BaseSyncedStore] Sync group change received (legacy)', {
    removedGroups: payload.removedGroups,
    addedGroups: payload.addedGroups,
    syncId: delta.id,
  });

  // If any groups were removed, clear cached data immediately so revoked data
  // cannot persist should the device go offline before the re-bootstrap
  // completes.
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
 * Handles an incremental group-added delta. It records the new sync group in
 * the subscription metadata without forcing a re-bootstrap; the server then
 * sends a 'C' (covering) delta for each newly visible entity, which flows
 * through the normal insert path.
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
  // No forceFullRebootstrap() here; the covering deltas will bring the entities.
}

/**
 * Handles an 'S' (group-removed) delta, which signals the recipient has lost
 * access to a sync group. The client does not track which entities belong to
 * which group, so it cannot purge only the affected rows; instead it clears
 * local state and forces a re-bootstrap with the updated group list.
 */
export async function handleGroupRemoved(
  ctx: GroupChangeContext,
  delta: SyncDelta,
): Promise<void> {
  const raw = parseGroupChangePayload(delta);
  if (raw === MALFORMED_PAYLOAD) {
    // The payload is unreadable: access was revoked but we cannot tell which
    // group. Fall back to a full clear, the safe direction for an
    // access-revocation delta, rather than throwing.
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

  // Clear cached data before the re-bootstrap so revoked-group data cannot
  // persist if the device goes offline between receiving this delta and
  // completing the re-bootstrap.
  await ctx.database.clear();
  ctx.objectPool.clear();

  // Update subscription metadata so the re-bootstrap fetches the
  // correct set of groups.
  const current = new Set(ctx.getSubscribedSyncGroups());
  current.delete(groupKey);
  await ctx.database.updateWorkspaceMetadata({ subscribedSyncGroups: Array.from(current) });

  ctx.forceFullRebootstrap();
}

/** Computes the new sync-group set after applying the additions and removals in a diff. */
export function computeUpdatedSyncGroups(
  ctx: GroupChangeContext,
  payload: SyncGroupChangePayload,
): string[] {
  const current = new Set(ctx.getSubscribedSyncGroups());
  for (const g of payload.removedGroups) current.delete(g);
  for (const g of payload.addedGroups) current.add(g);
  return Array.from(current);
}

/**
 * Forces a full re-bootstrap by marking local storage as needing one,
 * disconnecting, and emitting a connection lifecycle event that the reconnect
 * path acts on. Does nothing for participants whose bootstrap mode is 'none':
 * they never pull a baseline, so after a trigger such as a sync-group shrink or
 * an access revocation they rely on covering deltas to repopulate the data they
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
 * Resolves the sync-group list this session subscribes to, and is the single
 * place that decision is made. The server-issued `context.syncGroups` is
 * authoritative; when it is absent, the session subscribes to no explicit
 * groups. {@link checkSyncGroupShrinkage} and connection setup both read
 * through here, so the live subscription and the access-revocation check can
 * never disagree.
 */
export function resolveSyncGroups(context: {
  syncGroups?: readonly string[];
}): readonly string[] {
  if (context.syncGroups && context.syncGroups.length > 0) {
    return context.syncGroups;
  }
  return [];
}

/**
 * Compares the session's current sync groups against the set stored from the
 * last session. If any group is now missing, access has narrowed, so this
 * clears cached data and forces a full bootstrap before recording the new set.
 */
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

      // Clear cached data before the re-bootstrap so revoked-group data cannot
      // persist if the device goes offline first.
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
