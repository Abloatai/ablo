import type { RemoteValidation } from '../remoteValidation';

export const CONNECT_RESULT_CODES = [
  'absent',
  'reconciling',
  'loading',
  'ready',
  'operator_action_required',
] as const;

export type ConnectResultCode = (typeof CONNECT_RESULT_CODES)[number];
export type ConnectStepState =
  | 'pending'
  | 'changed'
  | 'unchanged'
  | 'loading'
  | 'ready'
  | 'action_required';

export interface ConnectReconcileStatus {
  readonly object: 'database_connection_reconcile';
  readonly code: ConnectResultCode;
  readonly steps: {
    readonly database: ConnectStepState;
    readonly registration: ConnectStepState;
    readonly snapshot: ConnectStepState;
    readonly readiness: ConnectStepState;
  };
  readonly repairItems: readonly string[];
  readonly needsDatabaseReconcile: boolean;
  readonly needsSnapshotRequest: boolean;
  readonly detail?: string;
}

const SNAPSHOT_SENSITIVE_ITEMS: ReadonlySet<string> = new Set([
  'publication',
  'publication_drift',
  'replica_identity',
  'snapshot_row_security',
  'table_select',
]);

const DATABASE_RECONCILABLE_ITEMS: ReadonlySet<string> = new Set([
  'publication',
  'replication_role',
  'replica_identity',
  'table_select',
  'snapshot_row_security',
  'write_role',
  'row_security',
  'database_privileges',
  'schema_privileges',
  'idempotency_ledger',
  'table_privileges',
  'logical_marker',
  'publication_drift',
]);

/** Reduce the authoritative registered-source check to the stable lifecycle contract. */
export function inspectRegisteredConnection(
  validation: RemoteValidation,
): ConnectReconcileStatus {
  if (!validation.ok) {
    return {
      object: 'database_connection_reconcile',
      code: 'operator_action_required',
      steps: {
        database: 'pending',
        registration: 'unchanged',
        snapshot: 'pending',
        readiness: 'action_required',
      },
      repairItems: [],
      needsDatabaseReconcile: false,
      needsSnapshotRequest: false,
      detail: validation.code ?? validation.message,
    };
  }
  if (!validation.reachable) {
    return {
      object: 'database_connection_reconcile',
      code: 'operator_action_required',
      steps: {
        database: 'action_required',
        registration: 'unchanged',
        snapshot: 'pending',
        readiness: 'action_required',
      },
      repairItems: [],
      needsDatabaseReconcile: false,
      needsSnapshotRequest: false,
      detail: validation.reason ?? 'source_unreachable',
    };
  }
  if (validation.failures.length > 0) {
    const repairItems = [...new Set(validation.failures.map((failure) => failure.item))].sort();
    const operatorItems = repairItems.filter((item) => !DATABASE_RECONCILABLE_ITEMS.has(item));
    if (operatorItems.length > 0) {
      return {
        object: 'database_connection_reconcile',
        code: 'operator_action_required',
        steps: {
          database: 'action_required',
          registration: 'unchanged',
          snapshot: 'pending',
          readiness: 'action_required',
        },
        repairItems,
        needsDatabaseReconcile: false,
        needsSnapshotRequest: false,
        detail: operatorItems.join(','),
      };
    }
    return {
      object: 'database_connection_reconcile',
      code: 'reconciling',
      steps: {
        database: 'pending',
        registration: 'unchanged',
        snapshot: 'pending',
        readiness: 'pending',
      },
      repairItems,
      needsDatabaseReconcile: true,
      needsSnapshotRequest:
        repairItems.some((item) => SNAPSHOT_SENSITIVE_ITEMS.has(item)) ||
        validation.initialSnapshot?.status === 'retrying',
    };
  }
  if (validation.initialSnapshot?.status === 'retrying') {
    return {
      object: 'database_connection_reconcile',
      code: 'reconciling',
      steps: {
        database: 'unchanged',
        registration: 'unchanged',
        snapshot: 'pending',
        readiness: 'pending',
      },
      repairItems: [],
      needsDatabaseReconcile: false,
      needsSnapshotRequest: true,
      ...(validation.initialSnapshot.detail ? { detail: validation.initialSnapshot.detail } : {}),
    };
  }
  if (validation.initialSnapshot?.status === 'loading') {
    return {
      object: 'database_connection_reconcile',
      code: 'loading',
      steps: {
        database: 'unchanged',
        registration: 'unchanged',
        snapshot: 'loading',
        readiness: 'pending',
      },
      repairItems: [],
      needsDatabaseReconcile: false,
      needsSnapshotRequest: false,
    };
  }
  if (validation.ready) {
    return {
      object: 'database_connection_reconcile',
      code: 'ready',
      steps: {
        database: 'unchanged',
        registration: 'unchanged',
        snapshot: 'ready',
        readiness: 'ready',
      },
      repairItems: [],
      needsDatabaseReconcile: false,
      needsSnapshotRequest: false,
    };
  }
  return {
    object: 'database_connection_reconcile',
    code: 'operator_action_required',
    steps: {
      database: 'unchanged',
      registration: 'unchanged',
      snapshot: 'pending',
      readiness: 'action_required',
    },
    repairItems: [],
    needsDatabaseReconcile: false,
    needsSnapshotRequest: false,
    detail: 'unclassified_not_ready',
  };
}

export function absentConnectionStatus(): ConnectReconcileStatus {
  return {
    object: 'database_connection_reconcile',
    code: 'absent',
    steps: {
      database: 'pending',
      registration: 'pending',
      snapshot: 'pending',
      readiness: 'pending',
    },
    repairItems: [],
    needsDatabaseReconcile: true,
    needsSnapshotRequest: false,
  };
}
