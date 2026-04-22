/**
 * Property-Based E2E: Random operations against real Go server
 *
 * Uses fast-check to generate random sequences and verify the server
 * handles them correctly.
 *
 * Requires: GO_ENV=test go run cmd/server/main.go
 * Run: E2E_TEST=true npx jest --config jest.e2e.config.ts __tests__/e2e/property-e2e.test.ts
 */

import fc from 'fast-check';
import WebSocket from 'ws';
import { v4 as uuid } from 'uuid';
import type { MutationExecutor, BatchAckResult, MutationOperation } from '../../src/interfaces';
import { initSyncEngine, resetSyncEngine } from '../../src/context';
import { noopLogger, noopObservability, defaultSessionErrorDetector, emptyConfig } from '../../src/SyncEngineContext';

const E2E_ENABLED = process.env.E2E_TEST === 'true';
const SERVER_URL = process.env.SYNC_SERVER_URL ?? 'http://localhost:8080';
const GRAPHQL_URL = `${SERVER_URL}/api/graphql`;
const HEALTH_URL = `${SERVER_URL}/api/health`;
const WS_URL = SERVER_URL.replace(/^http/, 'ws') + '/api/sync/ws';
const ORG_ID = process.env.E2E_ORG_ID ?? 'b605f83d-1015-400c-9a9f-9e292c7a1b8c';
const USER_ID = process.env.E2E_USER_ID ?? 'e039da97-4c81-4387-bb2f-fbd6dac9792d';

const describeE2E = E2E_ENABLED ? describe : describe.skip;

async function callBatchAck(operations: Array<Record<string, unknown>>): Promise<number> {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-User-Id': USER_ID,
      'X-Organization-Id': ORG_ID,
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

function connectWS(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ userId: USER_ID, organizationId: ORG_ID });
    const ws = new WebSocket(`${WS_URL}?${params}`, {
      headers: { 'X-User-Id': USER_ID, 'X-Organization-Id': ORG_ID },
    });
    const timeout = setTimeout(() => { ws.close(); reject(new Error('WS timeout')); }, 5000);
    ws.on('open', () => { clearTimeout(timeout); resolve(ws); });
    ws.on('error', (err: Error) => { clearTimeout(timeout); reject(err); });
  });
}

describeE2E('Property-Based E2E: Random Operations', () => {
  beforeAll(async () => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(HEALTH_URL, { signal: controller.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(`Health check failed`);
    } catch (e) {
      clearTimeout(t);
      throw new Error(`Server unreachable: ${e instanceof Error ? e.message : e}`);
    }
  }, 10000);

  it('batchAck always returns monotonically increasing lastSyncId', () => {
    return fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({ title: fc.string({ minLength: 1, maxLength: 30 }) }),
          { minLength: 1, maxLength: 5 }
        ),
        async (tasks) => {
          let prevSyncId = 0;
          for (const task of tasks) {
            const syncId = await callBatchAck([{
              type: 'CREATE',
              model: 'task',
              id: uuid(),
              input: { title: task.title, organizationId: ORG_ID, createdBy: USER_ID },
            }]);
            expect(syncId).toBeGreaterThan(0);
            expect(syncId).toBeGreaterThanOrEqual(prevSyncId);
            prevSyncId = syncId;
          }
        }
      ),
      { numRuns: 5 }
    );
  }, 30000);

  it('every batchAck CREATE produces a delta on WebSocket', async () => {
    const ws = await connectWS();

    const receivedModelIds = new Set<string>();
    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'delta' && msg.payload?.modelId) {
          receivedModelIds.add(msg.payload.modelId);
        }
      } catch { /* ignore */ }
    });

    // Create several tasks
    const createdIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = uuid();
      createdIds.push(id);
      await callBatchAck([{
        type: 'CREATE',
        model: 'task',
        id,
        input: { title: `Delta prop ${i}`, organizationId: ORG_ID, createdBy: USER_ID },
      }]);
    }

    // Wait for deltas
    await new Promise((r) => setTimeout(r, 3000));

    // Every created task should have produced a delta
    for (const id of createdIds) {
      expect(receivedModelIds.has(id)).toBe(true);
    }

    ws.close();
  }, 15000);

  it('server handles rapid-fire batch operations without errors', async () => {
    // Send 10 operations concurrently
    const promises = Array.from({ length: 10 }, () =>
      callBatchAck([{
        type: 'CREATE',
        model: 'task',
        id: uuid(),
        input: { title: 'Rapid', organizationId: ORG_ID, createdBy: USER_ID },
      }])
    );

    const results = await Promise.all(promises);

    for (const syncId of results) {
      expect(syncId).toBeGreaterThan(0);
    }

    // All sync IDs should be unique
    const unique = new Set(results);
    expect(unique.size).toBe(10);
  }, 15000);
});
