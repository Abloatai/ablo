/**
 * Delta factories for sync engine tests.
 *
 * Creates well-formed SyncAction objects matching the server wire format.
 */

import type { SyncActionType, SyncAction } from '../../types/index.js';

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
 * Create a single SyncAction (delta) matching the server wire format.
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
 * Create an INSERT delta for a new entity.
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
 * Create an UPDATE delta for an existing entity.
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
 * Create a DELETE delta.
 */
export function createDeleteDelta(
  modelName: string,
  modelId: string,
  syncId?: number
): SyncAction {
  return createDelta({ modelName, modelId, action: 'D', data: {}, id: syncId });
}

/**
 * Create an ARCHIVE delta.
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
 * Create an UNARCHIVE (reVive) delta.
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
 * Create a COVERING ('C') delta.
 *
 * Signals that the client has gained permission to see an existing entity.
 * Treated as an insert by the client — the entity is added to the local
 * store as if newly created. Typically follows a GroupAdded delta.
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
 * Create a GROUP ADDED ('G') delta using the incremental payload shape.
 *
 * Signals that the recipient was added to a single sync group. The client
 * updates its subscription metadata and waits for Covering deltas to
 * deliver the newly-visible entities. Unlike the legacy 'G' payload
 * (addedGroups/removedGroups), this does not trigger a re-bootstrap.
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
 * Create a legacy GROUP CHANGE ('G') delta with the old payload shape.
 *
 * Carries both added and removed groups in one delta and forces a full
 * re-bootstrap on the client. Use for testing backward compatibility with
 * the deprecated EmitGroupChange path.
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
 * Create a GROUP REMOVED ('S') delta.
 *
 * Signals that the recipient lost access to a sync group. The client
 * purges affected local state and triggers a re-bootstrap with the
 * updated group list.
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
 * Create a batch of deltas with sequential sync IDs.
 */
export function createDeltaBatch(
  deltas: Array<Omit<CreateDeltaOptions, 'id'>>,
  startingSyncId?: number
): SyncAction[] {
  const start = startingSyncId ?? deltaCounter + 1;
  return deltas.map((d, i) => createDelta({ ...d, id: start + i }));
}

/**
 * Create a confirmation delta — used to confirm that a mutation
 * was persisted by the server (TransactionQueue watches for this).
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
