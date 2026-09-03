import {
  CONNECT_RESULT_CODES,
  absentConnectionStatus,
  inspectRegisteredConnection,
} from '../connect/index';

describe('connect reconciliation lifecycle', () => {
  it('publishes the stable result vocabulary', () => {
    expect(CONNECT_RESULT_CODES).toEqual([
      'absent', 'reconciling', 'loading', 'ready', 'operator_action_required',
    ]);
    expect(absentConnectionStatus()).toMatchObject({ code: 'absent', steps: { registration: 'pending' } });
  });

  it('repairs historical RLS registrations without replacing credentials', () => {
    expect(inspectRegisteredConnection({
      ok: true,
      reachable: true,
      ready: false,
      failures: [{ item: 'snapshot_row_security', fix: 'owned by reconcile' }],
      initialSnapshot: { status: 'retrying' },
    })).toEqual({
      object: 'database_connection_reconcile',
      code: 'reconciling',
      steps: { database: 'pending', registration: 'unchanged', snapshot: 'pending', readiness: 'pending' },
      repairItems: ['snapshot_row_security'],
      needsDatabaseReconcile: true,
      needsSnapshotRequest: true,
    });
  });

  it('resumes after database repair by requesting only the snapshot', () => {
    expect(inspectRegisteredConnection({
      ok: true,
      reachable: true,
      ready: false,
      failures: [],
      initialSnapshot: { status: 'retrying', detail: 'previous attempt failed' },
    })).toMatchObject({
      code: 'reconciling', needsDatabaseReconcile: false, needsSnapshotRequest: true,
      steps: { database: 'unchanged', registration: 'unchanged' },
    });
  });

  it('does not restart a loading snapshot and makes a healthy rerun a no-op', () => {
    expect(inspectRegisteredConnection({
      ok: true, reachable: true, ready: false, failures: [], initialSnapshot: { status: 'loading' },
    }).code).toBe('loading');
    expect(inspectRegisteredConnection({
      ok: true, reachable: true, ready: true, failures: [], initialSnapshot: { status: 'complete' },
    })).toMatchObject({
      code: 'ready', needsDatabaseReconcile: false, needsSnapshotRequest: false,
      steps: { database: 'unchanged', registration: 'unchanged', readiness: 'ready' },
    });
  });

  it('requires operator action when the registered route cannot be reached', () => {
    expect(inspectRegisteredConnection({
      ok: true, reachable: false, ready: false, reason: 'private route unavailable', failures: [],
    })).toMatchObject({ code: 'operator_action_required', detail: 'private route unavailable' });
  });

  it('does not mutate for invariants the database reconcile plan cannot repair', () => {
    expect(inspectRegisteredConnection({
      ok: true,
      reachable: true,
      ready: false,
      failures: [{ item: 'server_version', actual: '13', fix: 'upgrade PostgreSQL' }],
    })).toMatchObject({
      code: 'operator_action_required',
      detail: 'server_version',
      needsDatabaseReconcile: false,
    });
  });
});
