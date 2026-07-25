/**
 * Factories that build well-formed delta objects for tests. A delta, a
 * {@link SyncAction}, is a single change to one model instance in the wire
 * format the server sends: an insert, update, delete, archive, and so on.
 * These helpers let tests construct deltas without a live server.
 */

import type { SyncActionType, SyncAction } from '../../stores/syncAction.js';

let deltaCounter = 0;

/** Reset the delta counter (call in beforeEach for deterministic IDs) */
export function resetDeltaCounter(): void {
  deltaCounter = 0;
}

export interface CreateDeltaOptions {
  /** Sync ID (auto-increments if not provided) */
  id?: number;
  /** Model name (e.g., 'Task', 'Slide') */
  modelName: string;
  /** Model ID */
  modelId: string;
  /** Action type: I=Insert, U=Update, D=Delete, A=Archive, V=Unarchive */
  action: SyncActionType;
  /** Delta payload data */
  data?: Record<string, unknown>;
}

/**
 * Builds a single delta ({@link SyncAction}) in the server's wire format.
 */
export function createDelta(options: CreateDeltaOptions): SyncAction {
  deltaCounter++;
  return {
    id: options.id ?? deltaCounter,
    modelName: options.modelName,
    modelId: options.modelId,
    action: options.action,
    data: options.data ?? {},
    __class: 'SyncAction',
  };
}

/**
 * Builds an insert delta for a new entity.
 */
export function createInsertDelta(
  modelName: string,
  modelId: string,
  data: Record<string, unknown>,
  syncId?: number
): SyncAction {
  return createDelta({ modelName, modelId, action: 'I', data, id: syncId });
}

/**
 * Builds an update delta for an existing entity.
 */
export function createUpdateDelta(
  modelName: string,
  modelId: string,
  data: Record<string, unknown>,
  syncId?: number
): SyncAction {
  return createDelta({ modelName, modelId, action: 'U', data, id: syncId });
}

/**
 * Builds a delete delta.
 */
export function createDeleteDelta(
  modelName: string,
  modelId: string,
  syncId?: number
): SyncAction {
  return createDelta({ modelName, modelId, action: 'D', data: {}, id: syncId });
}

/**
 * Builds an archive delta, stamping `archivedAt` with the current time.
 */
export function createArchiveDelta(
  modelName: string,
  modelId: string,
  syncId?: number
): SyncAction {
  return createDelta({
    modelName,
    modelId,
    action: 'A',
    data: { archivedAt: new Date().toISOString() },
    id: syncId,
  });
}

/**
 * Builds an unarchive delta, clearing `archivedAt`.
 */
export function createUnarchiveDelta(
  modelName: string,
  modelId: string,
  syncId?: number
): SyncAction {
  return createDelta({
    modelName,
    modelId,
    action: 'V',
    data: { archivedAt: null },
    id: syncId,
  });
}

/**
 * Builds a covering ('C') delta. It signals that the client has gained
 * permission to see an entity that already exists. The client treats it
 * like an insert, adding the entity to its local store as if newly created.
 * A covering delta typically follows a group-added delta.
 */
export function createCoveringDelta(
  modelName: string,
  modelId: string,
  data: Record<string, unknown>,
  syncId?: number
): SyncAction {
  return createDelta({ modelName, modelId, action: 'C', data, id: syncId });
}

/**
 * Builds a group-added ('G') delta in the incremental payload shape. It
 * signals that the recipient was added to a single sync group. The client
 * updates its subscription state and waits for covering deltas to deliver
 * the newly visible entities. Unlike the older payload that carries both
 * added and removed groups, this shape does not trigger a re-bootstrap.
 */
export function createGroupAddedDelta(
  userId: string,
  group: string,
  syncId?: number
): SyncAction {
  return createDelta({
    modelName: 'SyncGroupChange',
    modelId: `sga_${userId}`,
    action: 'G',
    data: { group, userId },
    id: syncId,
  });
}

/**
 * Builds a group-change ('G') delta in the older payload shape, which
 * carries both added and removed groups in one delta and forces a full
 * re-bootstrap on the client. Useful for testing backward compatibility
 * with that older shape.
 */
export function createLegacyGroupChangeDelta(
  userId: string,
  added: string[],
  removed: string[],
  syncId?: number
): SyncAction {
  return createDelta({
    modelName: 'SyncGroupChange',
    modelId: `sgc_${userId}`,
    action: 'G',
    data: { addedGroups: added, removedGroups: removed },
    id: syncId,
  });
}

/**
 * Builds a group-removed ('S') delta. It signals that the recipient lost
 * access to a sync group. The client purges the affected local state and
 * re-bootstraps with the updated group list.
 */
export function createGroupRemovedDelta(
  userId: string,
  group: string,
  syncId?: number
): SyncAction {
  return createDelta({
    modelName: 'SyncGroupChange',
    modelId: `sgr_${userId}`,
    action: 'S',
    data: { group, userId },
    id: syncId,
  });
}

/**
 * Builds a batch of deltas with sequential sync IDs.
 */
export function createDeltaBatch(
  deltas: Omit<CreateDeltaOptions, 'id'>[],
  startingSyncId?: number
): SyncAction[] {
  const start = startingSyncId ?? deltaCounter + 1;
  return deltas.map((d, i) => createDelta({ ...d, id: start + i }));
}

/**
 * Builds a confirmation delta, which signals that a mutation was persisted
 * by the server. The client's transaction queue watches for these to
 * confirm its in-flight writes.
 */
export function createConfirmationDelta(
  modelName: string,
  modelId: string,
  syncId: number,
  action: SyncActionType = 'U',
  data: Record<string, unknown> = {}
): SyncAction {
  return createDelta({ modelName, modelId, action, data, id: syncId });
}
