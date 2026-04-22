/**
 * Full-Stack E2E: Real SDK TransactionQueue → Real Go Server → Real Delta Confirmation
 *
 * The crown jewel: wires real TransactionQueue to real batchAck to real Postgres,
 * and verifies delta arrives via real WebSocket and confirms the transaction.
 *
 * Requires: GO_ENV=test go run cmd/server/main.go
 * Run: E2E_TEST=true npx jest __tests__/e2e/full-stack-sync.test.ts
 *
 */

import WebSocketClient from 'ws';
import { v4 as uuid } from 'uuid';
import { TransactionQueue } from '../../src/transactions/TransactionQueue';
import { initSyncEngine, resetSyncEngine } from '../../src/context';
import {
  noopLogger,
  noopObservability,
  defaultSessionErrorDetector,
  emptyConfig,
} from '../../src/SyncEngineContext';
import type { MutationExecutor, BatchAckResult, MutationOperation } from '../../src/interfaces';
import { flushMicrotasks, TestTask, TestProject, registerTestModels } from '../../src/testing';
import { ModelRegistry } from '../../src/ModelRegistry';

const E2E_ENABLED = process.env.E2E_TEST === 'true';
const SERVER_URL = process.env.SYNC_SERVER_URL ?? 'http://localhost:8080';
const GRAPHQL_URL = `${SERVER_URL}/api/graphql`;
const HEALTH_URL = `${SERVER_URL}/api/health`;
const WS_URL = SERVER_URL.replace(/^http/, 'ws') + '/api/sync/ws';
const TEST_USER = process.env.E2E_USER_ID ?? 'e039da97-4c81-4387-bb2f-fbd6dac9792d';
const TEST_ORG = process.env.E2E_ORG_ID ?? 'b605f83d-1015-400c-9a9f-9e292c7a1b8c';

const describeE2E = E2E_ENABLED ? describe : describe.skip;

// Real MutationExecutor that calls the Go server
class RealMutationExecutor implements MutationExecutor {
  async batchAck(operations: MutationOperation[]): Promise<BatchAckResult> {
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': TEST_USER,
        'X-Organization-Id': TEST_ORG,
      },
      body: JSON.stringify({
        query: `mutation BatchAck($operations: [MutationOperation!]!) {
          batchAck(operations: $operations) { lastSyncId }
        }`,
        variables: { operations },
      }),
    });
    const body = await res.json();
    if (body.errors) throw new Error(`GraphQL: ${JSON.stringify(body.errors)}`);
    return { lastSyncId: Number(body.data.batchAck.lastSyncId) };
  }

  async executeCreate(m: string, id: string, input: Record<string, unknown>): Promise<void> {
    await this.batchAck([{ type: 'CREATE', model: m.toLowerCase(), id, input }]);
  }
  async executeUpdate(m: string, id: string, data: Record<string, unknown>): Promise<BatchAckResult | null> {
    return this.batchAck([{ type: 'UPDATE', model: m.toLowerCase(), id, input: data }]);
  }
  async executeDelete(m: string, id: string): Promise<void> {
    await this.batchAck([{ type: 'DELETE', model: m.toLowerCase(), id }]);
  }
  async executeArchive(m: string, id: string): Promise<void> {
    await this.batchAck([{ type: 'ARCHIVE', model: m.toLowerCase(), id }]);
  }
  async executeUnarchive(m: string, id: string): Promise<void> {
    await this.batchAck([{ type: 'UNARCHIVE', model: m.toLowerCase(), id }]);
  }
}

// Helper: connect real WS and pipe deltas to TransactionQueue
function connectWS(queue: TransactionQueue): Promise<{ ws: InstanceType<typeof WebSocketClient>; close: () => void }> {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ userId: TEST_USER, organizationId: TEST_ORG });
    const ws = new WebSocketClient(`${WS_URL}?${params}`, {
      headers: { 'X-User-Id': TEST_USER, 'X-Organization-Id': TEST_ORG },
    });
    const timeout = setTimeout(() => { ws.close(); reject(new Error('WS timeout')); }, 5000);

    ws.on('open', () => {
      clearTimeout(timeout);
      ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'delta' && msg.payload?.id) {
            queue.onDeltaReceived(msg.payload.id);
          }
        } catch { /* ignore */ }
      });
      resolve({ ws, close: () => ws.close() });
    });
    ws.on('error', (err: Error) => { clearTimeout(timeout); reject(err); });
  });
}

describeE2E('Full-Stack E2E: SDK → Go Server → Delta Confirmation', () => {
  let queue: TransactionQueue;
  let registry: ModelRegistry;

  beforeAll(async () => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(HEALTH_URL, { signal: controller.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(`Health: ${res.status}`);
    } catch (e) {
      clearTimeout(t);
      throw new Error(`Server unreachable at ${HEALTH_URL}: ${e instanceof Error ? e.message : e}`);
    }
  }, 10000);

  beforeEach(() => {
    registry = new ModelRegistry();
    registerTestModels(registry);

    initSyncEngine({
      logger: noopLogger,
      observability: noopObservability,
      sessionErrorDetector: defaultSessionErrorDetector,
      onlineStatus: { isOnline: () => true },
      mutationExecutor: new RealMutationExecutor(),
      mutationDispatcher: { dispatch: async () => {} },
      config: {
        ...emptyConfig,
        modelCreatePriority: new Map([['Task', 10], ['Project', 10]]),
        batchableModels: new Set(['task', 'project']),
        extractCreateInput: (_name, data, ctx) => ({
          ...data,
          organizationId: ctx.organizationId,
          createdBy: ctx.userId,
        }),
        buildUpdateInput: (_name, changes) => changes,
      },
    });

    queue = new TransactionQueue({ batchDelay: 0 });
  });

  afterEach(() => {
    queue.removeAllListeners();
    resetSyncEngine();
  });

  it('should complete full cycle: create → batchAck → delta → confirm', async () => {
    const { close } = await connectWS(queue);

    try {
      const taskId = uuid();
      const task = new TestTask({ id: taskId, title: 'Full-stack E2E', organizationId: TEST_ORG });

      const confirmed = new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Confirmation timeout (10s)')), 10000);
        queue.on('transaction:completed', (tx) => {
          if (tx.modelId === taskId) { clearTimeout(t); resolve(); }
        });
        queue.on('transaction:failed', ({ transaction, error }) => {
          if (transaction.modelId === taskId) { clearTimeout(t); reject(error); }
        });
      });

      const tx = await queue.create(task, { userId: TEST_USER, organizationId: TEST_ORG });
      expect(tx.type).toBe('create');

      await flushMicrotasks();
      await confirmed;

      console.log(`[Full-Stack E2E] Task ${taskId} confirmed via real delta pipeline`);
    } finally {
      close();
    }
  }, 20000);

  it('should handle update → delta → confirm', async () => {
    const { close } = await connectWS(queue);

    try {
      // Create first
      const taskId = uuid();
      const task = new TestTask({ id: taskId, title: 'Update me', organizationId: TEST_ORG });

      const createDone = new Promise<void>((resolve) => {
        queue.on('transaction:completed', function h(tx) {
          if (tx.modelId === taskId && tx.type === 'create') { queue.off('transaction:completed', h); resolve(); }
        });
      });

      await queue.create(task, { userId: TEST_USER, organizationId: TEST_ORG });
      await flushMicrotasks();
      await createDone;

      // Now update
      task.markAsPersisted();
      task.propertyChanged('title', 'Update me', 'Updated via E2E');

      const updateDone = new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Update confirmation timeout')), 10000);
        queue.on('transaction:completed', function h(tx) {
          if (tx.modelId === taskId && tx.type === 'update') { clearTimeout(t); queue.off('transaction:completed', h); resolve(); }
        });
      });

      await queue.update(task, { userId: TEST_USER, organizationId: TEST_ORG }, { title: 'Updated via E2E' });
      await flushMicrotasks();
      await updateDone;

      console.log(`[Full-Stack E2E] Task ${taskId} update confirmed`);
    } finally {
      close();
    }
  }, 25000);

  it('should confirm batch of multiple operations', async () => {
    const { close } = await connectWS(queue);

    try {
      const taskId1 = uuid();
      const taskId2 = uuid();
      const task1 = new TestTask({ id: taskId1, title: 'Batch 1', organizationId: TEST_ORG });
      const task2 = new TestTask({ id: taskId2, title: 'Batch 2', organizationId: TEST_ORG });

      const confirmed = new Set<string>();
      const allDone = new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Batch confirmation timeout')), 15000);
        queue.on('transaction:completed', (tx) => {
          confirmed.add(tx.modelId);
          if (confirmed.has(taskId1) && confirmed.has(taskId2)) { clearTimeout(t); resolve(); }
        });
      });

      // Create both in same tick → batched
      await queue.create(task1, { userId: TEST_USER, organizationId: TEST_ORG });
      await queue.create(task2, { userId: TEST_USER, organizationId: TEST_ORG });
      await flushMicrotasks();

      await allDone;
      console.log(`[Full-Stack E2E] Batch confirmed: ${taskId1} + ${taskId2}`);
    } finally {
      close();
    }
  }, 20000);
});
