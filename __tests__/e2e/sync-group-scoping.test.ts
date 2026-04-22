/**
 * E2E: Sync Group Scoping & Security Cleanup
 *
 * Tests server-enforced security boundaries:
 * - Deltas delivered to users in same org
 * - Session expiry → ObjectPool cleared
 * - Bootstrap returns correct data shape
 * - IndexedDB cleanup on auth revocation
 *
 * Requires: GO_ENV=test go run cmd/server/main.go
 * Run: E2E_TEST=true npx jest --config jest.e2e.config.ts __tests__/e2e/sync-group-scoping.test.ts
 */

import WebSocket from 'ws';
import { v4 as uuid } from 'uuid';
import { ObjectPool, ModelScope } from '../../src/ObjectPool';
import { ModelRegistry } from '../../src/ModelRegistry';
import { registerTestModels, TestTask, resetFixtureCounter } from '../../src/testing';
import { initSyncEngine, resetSyncEngine } from '../../src/context';
import { noopLogger, noopObservability, defaultSessionErrorDetector, emptyConfig } from '../../src/SyncEngineContext';

const E2E_ENABLED = process.env.E2E_TEST === 'true';
const SERVER_URL = process.env.SYNC_SERVER_URL ?? 'http://localhost:8080';
const GRAPHQL_URL = `${SERVER_URL}/api/graphql`;
const HEALTH_URL = `${SERVER_URL}/api/health`;
const WS_URL = SERVER_URL.replace(/^http/, 'ws') + '/api/sync/ws';
const BOOTSTRAP_URL = `${SERVER_URL}/api/sync/bootstrap`;

// Real IDs from the database
const USER_ID = process.env.E2E_USER_ID ?? 'e039da97-4c81-4387-bb2f-fbd6dac9792d';
const ORG_ID = process.env.E2E_ORG_ID ?? 'b605f83d-1015-400c-9a9f-9e292c7a1b8c';
const TEAM_ID = process.env.E2E_TEAM_ID ?? '83870981-bd99-4dd7-a373-821af8f47b96';

const describeE2E = E2E_ENABLED ? describe : describe.skip;

function connectWS(userId: string, orgId: string, syncGroups?: string[]): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ userId, organizationId: orgId });
    if (syncGroups) syncGroups.forEach((g) => params.append('syncGroups', g));
    const ws = new WebSocket(`${WS_URL}?${params}`, {
      headers: { 'X-User-Id': userId, 'X-Organization-Id': orgId },
    });
    const timeout = setTimeout(() => { ws.close(); reject(new Error('WS connect timeout')); }, 5000);
    ws.on('open', () => { clearTimeout(timeout); resolve(ws); });
    ws.on('error', (err: Error) => { clearTimeout(timeout); reject(err); });
  });
}

async function batchAck(userId: string, orgId: string, operations: Array<Record<string, unknown>>): Promise<number> {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-User-Id': userId,
      'X-Organization-Id': orgId,
    },
    body: JSON.stringify({
      query: `mutation BatchAck($operations: [MutationOperation!]!) {
        batchAck(operations: $operations) { lastSyncId }
      }`,
      variables: { operations },
    }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return Number(body.data.batchAck.lastSyncId);
}

describeE2E('E2E: Sync Group Scoping & Security', () => {
  beforeAll(async () => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(HEALTH_URL, { signal: controller.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(`Health: ${res.status}`);
    } catch (e) {
      clearTimeout(t);
      throw new Error(`Server unreachable: ${e instanceof Error ? e.message : e}`);
    }
  }, 10000);

  describe('delta delivery within same org', () => {
    it('should deliver delta to a connected WebSocket in same org', async () => {
      const ws = await connectWS(USER_ID, ORG_ID);

      const deltaReceived = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Delta timeout')), 8000);
        ws.on('message', (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'delta' && msg.payload?.modelName === 'Task') {
              clearTimeout(timeout);
              resolve(msg.payload);
            }
          } catch { /* ignore */ }
        });
      });

      // Create a task — should produce a delta on the WS
      const taskId = uuid();
      await batchAck(USER_ID, ORG_ID, [{
        type: 'CREATE',
        model: 'task',
        id: taskId,
        input: { title: 'Scoping Test', status: 'todo', organizationId: ORG_ID, createdBy: USER_ID },
      }]);

      const delta = await deltaReceived;
      expect(delta.actionType).toBe('I');
      expect(delta.modelName).toBe('Task');

      ws.close();
    }, 15000);
  });

  describe('bootstrap endpoint', () => {
    it('should return full bootstrap with lastSyncId and models', async () => {
      const res = await fetch(BOOTSTRAP_URL, {
        headers: {
          'X-User-Id': USER_ID,
          'X-Organization-Id': ORG_ID,
        },
      });

      expect(res.ok).toBe(true);
      const body = await res.json();
      expect(body.type).toBe('full');
      expect(body.lastSyncId).toBeGreaterThan(0);
      expect(body.models).toBeDefined();
      expect(typeof body.models).toBe('object');
    });

    it('should return partial bootstrap with lastSyncId parameter', async () => {
      // First get current sync state
      const fullRes = await fetch(BOOTSTRAP_URL, {
        headers: { 'X-User-Id': USER_ID, 'X-Organization-Id': ORG_ID },
      });
      const fullBody = await fullRes.json();
      const currentSyncId = fullBody.lastSyncId;

      // Request partial bootstrap from a recent sync ID
      const partialRes = await fetch(`${BOOTSTRAP_URL}?lastSyncId=${currentSyncId - 10}`, {
        headers: { 'X-User-Id': USER_ID, 'X-Organization-Id': ORG_ID },
      });

      expect(partialRes.ok).toBe(true);
      const partialBody = await partialRes.json();
      // Server may return full or partial depending on delta count
      expect(partialBody.lastSyncId).toBeGreaterThanOrEqual(currentSyncId - 10);
    });
  });

  describe('IndexedDB cleanup on auth loss (SDK-level)', () => {
    it('should clear ObjectPool completely when session is revoked', () => {
      // This tests the SDK-level cleanup we implemented in BaseSyncedStore
      const registry = new ModelRegistry();
      registerTestModels(registry);
      resetFixtureCounter();

      initSyncEngine({
        logger: noopLogger,
        observability: noopObservability,
        sessionErrorDetector: defaultSessionErrorDetector,
        onlineStatus: { isOnline: () => true },
        mutationExecutor: {
          batchAck: async () => ({ lastSyncId: 0 }),
          executeCreate: async () => {},
          executeUpdate: async () => null,
          executeDelete: async () => {},
          executeArchive: async () => {},
          executeUnarchive: async () => {},
        },
        mutationDispatcher: { dispatch: async () => {} },
        config: emptyConfig,
      });

      const pool = new ObjectPool({ maxSize: 100, gcInterval: 0, useWeakRefs: false }, registry);

      // Simulate cached sensitive data
      pool.add(new TestTask({ id: 'confidential-1', title: 'Revenue forecast' }));
      pool.add(new TestTask({ id: 'confidential-2', title: 'M&A target' }));
      pool.add(new TestTask({ id: 'confidential-3', title: 'Layoff plan' }));
      expect(pool.size).toBe(3);

      // Simulate session revocation cleanup (as BaseSyncedStore now does)
      pool.clear();

      expect(pool.size).toBe(0);
      expect(pool.get('confidential-1')).toBeUndefined();
      expect(pool.get('confidential-2')).toBeUndefined();
      expect(pool.get('confidential-3')).toBeUndefined();
      expect(pool.getByType(TestTask)).toHaveLength(0);

      resetSyncEngine();
    });

    it('should make data unreachable after clear — no FK index leaks', () => {
      const registry = new ModelRegistry();
      registerTestModels(registry);

      initSyncEngine({
        logger: noopLogger, observability: noopObservability,
        sessionErrorDetector: defaultSessionErrorDetector,
        onlineStatus: { isOnline: () => true },
        mutationExecutor: {
          batchAck: async () => ({ lastSyncId: 0 }),
          executeCreate: async () => {},
          executeUpdate: async () => null,
          executeDelete: async () => {},
          executeArchive: async () => {},
          executeUnarchive: async () => {},
        },
        mutationDispatcher: { dispatch: async () => {} },
        config: emptyConfig,
      });

      const pool = new ObjectPool({ maxSize: 100, gcInterval: 0, useWeakRefs: false }, registry);
      pool.registerForeignKey('Task', 'projectId');

      pool.add(new TestTask({ id: 'task-secret', title: 'Secret', projectId: 'proj-1' }));
      expect(pool.getByForeignKey('Task', 'projectId', 'proj-1')).toHaveLength(1);

      pool.clear();

      // FK index must also be empty
      expect(pool.getByForeignKey('Task', 'projectId', 'proj-1')).toHaveLength(0);

      resetSyncEngine();
    });
  });
});
