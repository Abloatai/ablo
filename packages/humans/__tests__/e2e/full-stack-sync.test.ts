/**
 * Full-Stack E2E: Real SDK MutationQueue → Real Go Server → Real Delta Confirmation
 *
 * The crown jewel: wires real MutationQueue to real batchAck to real Postgres,
 * and verifies delta arrives via real WebSocket and confirms the transaction.
 *
 * Requires: GO_ENV=test go run cmd/server/main.go
 * Run: E2E_TEST=true npx jest __tests__/e2e/full-stack-sync.test.ts
 *
 */

import WebSocketClient from 'ws';
import { v4 as uuid } from 'uuid';
import { MutationQueue } from '../../src/local/transactions/mutations/MutationQueue';
import { initRuntime, resetRuntime } from '../../src/local/context.js';
import {
  noopLogger,
  noopObservability,
  defaultSessionErrorDetector,
  emptyConfig,
} from '../../src/local/RuntimeContext.js';
import type { MutationExecutor, CommitResult, MutationOperation } from '../../src/local/interfaces/index.js';
import { flushMicrotasks, TestItem, TestWorkspace, registerTestModels } from '../../src/local/testing';
import { ModelRegistry } from '../../src/local/ModelRegistry';

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
  async commit(operations: MutationOperation[]): Promise<CommitResult> {
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
    await this.commit([{ type: 'CREATE', model: m.toLowerCase(), id, input }]);
  }
  async executeUpdate(m: string, id: string, data: Record<string, unknown>): Promise<CommitResult | null> {
    return this.commit([{ type: 'UPDATE', model: m.toLowerCase(), id, input: data }]);
  }
  async executeDelete(m: string, id: string): Promise<void> {
    await this.commit([{ type: 'DELETE', model: m.toLowerCase(), id }]);
  }
  async executeArchive(m: string, id: string): Promise<void> {
    await this.commit([{ type: 'ARCHIVE', model: m.toLowerCase(), id }]);
  }
  async executeUnarchive(m: string, id: string): Promise<void> {
    await this.commit([{ type: 'UNARCHIVE', model: m.toLowerCase(), id }]);
  }
}

// Helper: connect real WS and pipe deltas to MutationQueue
function connectWS(queue: MutationQueue): Promise<{ ws: InstanceType<typeof WebSocketClient>; close: () => void }> {
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
      resolve({ ws, close: () => { ws.close(); } });
    });
    ws.on('error', (err: Error) => { clearTimeout(timeout); reject(err); });
  });
}

describeE2E('Full-Stack E2E: SDK → Go Server → Delta Confirmation', () => {
  let queue: MutationQueue;
  let registry: ModelRegistry;

  beforeAll(async () => {
    const controller = new AbortController();
    const t = setTimeout(() => { controller.abort(); }, 5000);
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

    initRuntime({
      logger: noopLogger,
      observability: noopObservability,
      sessionErrorDetector: defaultSessionErrorDetector,
      onlineStatus: { isOnline: () => true },
      mutationExecutor: new RealMutationExecutor(),
      config: {
        ...emptyConfig,
        modelCreatePriority: new Map([['Item', 10], ['Workspace', 10]]),
      },
    });

    queue = new MutationQueue({ batchDelay: 0 });
  });

  afterEach(() => {
    queue.removeAllListeners();
    resetRuntime();
  });

  it('should complete full cycle: create → batchAck → delta → confirm', async () => {
    const { close } = await connectWS(queue);

    try {
      const itemId = uuid();
      const item = new TestItem({ id: itemId, title: 'Full-stack E2E', organizationId: TEST_ORG });

      const confirmed = new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => { reject(new Error('Confirmation timeout (10s)')); }, 10000);
        queue.on('transaction:completed', (tx) => {
          if (tx.modelId === itemId) { clearTimeout(t); resolve(); }
        });
        queue.on('transaction:failed', ({ transaction, error }) => {
          if (transaction.modelId === itemId) { clearTimeout(t); reject(error); }
        });
      });

      const tx = await queue.create(item, { userId: TEST_USER, organizationId: TEST_ORG });
      expect(tx.type).toBe('create');

      await flushMicrotasks();
      await confirmed;

      console.log(`[Full-Stack E2E] Item ${itemId} confirmed via real delta pipeline`);
    } finally {
      close();
    }
  }, 20000);

  it('should handle update → delta → confirm', async () => {
    const { close } = await connectWS(queue);

    try {
      // Create first
      const itemId = uuid();
      const item = new TestItem({ id: itemId, title: 'Update me', organizationId: TEST_ORG });

      const createDone = new Promise<void>((resolve) => {
        queue.on('transaction:completed', function h(tx) {
          if (tx.modelId === itemId && tx.type === 'create') { queue.off('transaction:completed', h); resolve(); }
        });
      });

      await queue.create(item, { userId: TEST_USER, organizationId: TEST_ORG });
      await flushMicrotasks();
      await createDone;

      // Now update
      item.markAsPersisted();
      item.propertyChanged('title', 'Update me', 'Updated via E2E');

      const updateDone = new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => { reject(new Error('Update confirmation timeout')); }, 10000);
        queue.on('transaction:completed', function h(tx) {
          if (tx.modelId === itemId && tx.type === 'update') { clearTimeout(t); queue.off('transaction:completed', h); resolve(); }
        });
      });

      await queue.update(item, { userId: TEST_USER, organizationId: TEST_ORG }, { title: 'Updated via E2E' });
      await flushMicrotasks();
      await updateDone;

      console.log(`[Full-Stack E2E] Item ${itemId} update confirmed`);
    } finally {
      close();
    }
  }, 25000);

  it('should confirm batch of multiple operations', async () => {
    const { close } = await connectWS(queue);

    try {
      const itemId1 = uuid();
      const itemId2 = uuid();
      const item1 = new TestItem({ id: itemId1, title: 'Batch 1', organizationId: TEST_ORG });
      const item2 = new TestItem({ id: itemId2, title: 'Batch 2', organizationId: TEST_ORG });

      const confirmed = new Set<string>();
      const allDone = new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => { reject(new Error('Batch confirmation timeout')); }, 15000);
        queue.on('transaction:completed', (tx) => {
          confirmed.add(tx.modelId);
          if (confirmed.has(itemId1) && confirmed.has(itemId2)) { clearTimeout(t); resolve(); }
        });
      });

      // Create both in same tick → batched
      await queue.create(item1, { userId: TEST_USER, organizationId: TEST_ORG });
      await queue.create(item2, { userId: TEST_USER, organizationId: TEST_ORG });
      await flushMicrotasks();

      await allDone;
      console.log(`[Full-Stack E2E] Batch confirmed: ${itemId1} + ${itemId2}`);
    } finally {
      close();
    }
  }, 20000);
});
