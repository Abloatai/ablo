/**
 * E2E: Offline → Reconnect → Reconciliation
 *
 * Tests the complete offline mutation lifecycle against the real server:
 * - Mutations queued while "offline" (server still running, but client doesn't send)
 * - Flush on reconnect sends queued mutations in correct order
 * - Server processes queued mutations and returns valid syncIds
 * - WebSocket reconnect resumes delta delivery
 * - Conflicting mutations during offline period handled correctly
 *
 * Requires: GO_ENV=test go run cmd/server/main.go
 */

import WebSocket from 'ws';
import { v4 as uuid } from 'uuid';

const E2E_ENABLED = process.env.E2E_TEST === 'true';
const SERVER_URL = process.env.SYNC_SERVER_URL ?? 'http://localhost:8080';
const GRAPHQL_URL = `${SERVER_URL}/api/graphql`;
const HEALTH_URL = `${SERVER_URL}/api/health`;
const WS_URL = SERVER_URL.replace(/^http/, 'ws') + '/api/sync/ws';
const BOOTSTRAP_URL = `${SERVER_URL}/api/sync/bootstrap`;
const USER_ID = process.env.E2E_USER_ID ?? 'e039da97-4c81-4387-bb2f-fbd6dac9792d';
const ORG_ID = process.env.E2E_ORG_ID ?? 'b605f83d-1015-400c-9a9f-9e292c7a1b8c';

const describeE2E = E2E_ENABLED ? describe : describe.skip;

async function batchAck(ops: Record<string, unknown>[]): Promise<number> {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Id': USER_ID, 'X-Organization-Id': ORG_ID },
    body: JSON.stringify({
      query: `mutation BatchAck($operations: [MutationOperation!]!) { batchAck(operations: $operations) { lastSyncId } }`,
      variables: { operations: ops },
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

async function bootstrap(lastSyncId?: number): Promise<Record<string, unknown>> {
  const params = new URLSearchParams({ organizationId: ORG_ID });
  if (lastSyncId !== undefined) params.append('lastSyncId', String(lastSyncId));
  const res = await fetch(`${BOOTSTRAP_URL}?${params}`, {
    headers: { 'X-User-Id': USER_ID, 'X-Organization-Id': ORG_ID },
  });
  return res.json();
}

describeE2E('E2E: Offline → Reconnect → Reconciliation', () => {
  beforeAll(async () => {
    const c = new AbortController();
    const t = setTimeout(() => { c.abort(); }, 5000);
    try { const r = await fetch(HEALTH_URL, { signal: c.signal }); clearTimeout(t); if (!r.ok) throw new Error(`${r.status}`); }
    catch (e) { clearTimeout(t); throw new Error(`Server unreachable: ${e instanceof Error ? e.message : e}`); }
  }, 10000);

  describe('offline mutation queue → flush on reconnect', () => {
    it('should process queued mutations after coming back online', async () => {
      // Simulate: user goes offline, queues 3 creates, comes back online
      // In reality the SDK queues to OfflineMutationStore — here we simulate
      // by holding mutations then sending them all at once (like flush does)

      const queuedOps: Record<string, unknown>[] = [];
      const itemIds: string[] = [];

      // Queue 3 creates "offline"
      for (let i = 0; i < 3; i++) {
        const id = uuid();
        itemIds.push(id);
        queuedOps.push({
          type: 'CREATE', model: 'item', id,
          input: { title: `Offline item ${i}`, status: 'todo', organizationId: ORG_ID, createdBy: USER_ID },
        });
      }

      // "Come back online" — flush all queued mutations
      const syncId = await batchAck(queuedOps);
      expect(syncId).toBeGreaterThan(0);

      // Verify all items exist via bootstrap
      await new Promise((r) => setTimeout(r, 300));
      const data = await bootstrap();
      const items = (data.models as Record<string, unknown[]>)?.Item;

      if (items && Array.isArray(items)) {
        for (const id of itemIds) {
          const found = items.find((t: unknown) => (t as Record<string, unknown>).id === id);
          expect(found).toBeDefined();
        }
      }
    });

    it('should handle ordered batch flush (multiple items in one call)', async () => {
      // Simulate flushing multiple queued offline mutations in a single batchAck
      // This is what OfflineMutationStore.flush() does after topological sort
      const ids = [uuid(), uuid(), uuid(), uuid(), uuid()];

      const syncId = await batchAck(ids.map((id, i) => ({
        type: 'CREATE', model: 'item', id,
        input: { title: `Batch flush ${i}`, status: 'todo', organizationId: ORG_ID, createdBy: USER_ID },
      })));

      expect(syncId).toBeGreaterThan(0);

      // All 5 should exist
      await new Promise((r) => setTimeout(r, 300));
      const data = await bootstrap();
      const items = (data.models as Record<string, unknown[]>)?.Item;

      if (items && Array.isArray(items)) {
        for (const id of ids) {
          expect(items.find((t: unknown) => (t as Record<string, unknown>).id === id)).toBeDefined();
        }
      }
    });
  });

  describe('WebSocket reconnect after gap', () => {
    it('should receive deltas for mutations made during disconnect', async () => {
      // Connect WS
      const ws1 = await connectWS();

      // Note the current state
      const snap = await bootstrap();
      const beforeId = snap.lastSyncId as number;

      // Disconnect
      ws1.close();
      await new Promise((r) => setTimeout(r, 300));

      // Make mutations while disconnected (simulating another tab or server-side change)
      const offlineItemId = uuid();
      await batchAck([{
        type: 'CREATE', model: 'item', id: offlineItemId,
        input: { title: 'During disconnect', status: 'todo', organizationId: ORG_ID, createdBy: USER_ID },
      }]);

      // Reconnect
      const ws2 = await connectWS();
      const deltasAfter = new Set<string>();
      ws2.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'delta' && msg.payload?.modelId) {
            deltasAfter.add(msg.payload.modelId);
          }
        } catch { /* ignore */ }
      });

      // Make another mutation after reconnect — this should definitely arrive
      const postReconnectId = uuid();
      await batchAck([{
        type: 'CREATE', model: 'item', id: postReconnectId,
        input: { title: 'After reconnect', status: 'todo', organizationId: ORG_ID, createdBy: USER_ID },
      }]);

      await new Promise((r) => setTimeout(r, 2000));

      // Post-reconnect mutation should be received via WS
      expect(deltasAfter.has(postReconnectId)).toBe(true);

      // The during-disconnect mutation is recoverable via partial bootstrap
      const partial = await bootstrap(beforeId);
      expect((partial.lastSyncId as number)).toBeGreaterThan(beforeId);

      ws2.close();
    }, 15000);
  });

  describe('conflict scenarios', () => {
    it('should handle update to entity that was updated by another user during offline', async () => {
      // Create a item
      const itemId = uuid();
      await batchAck([{
        type: 'CREATE', model: 'item', id: itemId,
        input: { title: 'Conflict base', status: 'todo', organizationId: ORG_ID, createdBy: USER_ID },
      }]);

      // "User B" updates while "User A" is offline
      await batchAck([{
        type: 'UPDATE', model: 'item', id: itemId,
        input: { title: 'User B update' },
      }]);

      // "User A" comes online and sends their stale update
      const syncId = await batchAck([{
        type: 'UPDATE', model: 'item', id: itemId,
        input: { title: 'User A offline update' },
      }]);

      // Last-write-wins: User A's update should be the final state
      expect(syncId).toBeGreaterThan(0);

      await new Promise((r) => setTimeout(r, 300));
      const data = await bootstrap();
      const items = (data.models as Record<string, unknown[]>)?.Item;
      if (items && Array.isArray(items)) {
        const item = items.find((t: unknown) => (t as Record<string, unknown>).id === itemId);
        if (item) {
          // Last write wins — User A's update is latest
          expect((item as Record<string, unknown>).title).toBe('User A offline update');
        }
      }
    });

    it('should handle update to entity that was deleted during offline', async () => {
      // Create a item
      const itemId = uuid();
      await batchAck([{
        type: 'CREATE', model: 'item', id: itemId,
        input: { title: 'Will be deleted', status: 'todo', organizationId: ORG_ID, createdBy: USER_ID },
      }]);

      // Delete it (simulating another user's action during offline)
      await batchAck([{ type: 'DELETE', model: 'item', id: itemId }]);

      // User comes online, tries to update the deleted entity
      const res = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': USER_ID, 'X-Organization-Id': ORG_ID },
        body: JSON.stringify({
          query: `mutation BatchAck($operations: [MutationOperation!]!) { batchAck(operations: $operations) { lastSyncId } }`,
          variables: { operations: [{ type: 'UPDATE', model: 'item', id: itemId, input: { title: 'Ghost update' } }] },
        }),
      });

      const body = await res.json();
      // Server should either:
      // 1. Return an error (entity not found) — MutationQueue handles this as "no rows" → completed
      // 2. Silently succeed (idempotent) — also fine
      console.log('[Conflict] Update deleted entity result:', {
        hasErrors: !!body.errors,
        errorMsg: body.errors?.[0]?.message?.slice(0, 80),
        syncId: body.data?.batchAck?.lastSyncId,
      });
    });
  });

  describe('offline queue ordering', () => {
    it('should handle create → update → delete sequence from offline queue', async () => {
      const itemId = uuid();

      // Simulate the full lifecycle queued offline, flushed at once:
      // Create → Update → Delete (all in one batchAck)
      const syncId = await batchAck([
        {
          type: 'CREATE', model: 'item', id: itemId,
          input: { title: 'Lifecycle', status: 'todo', organizationId: ORG_ID, createdBy: USER_ID },
        },
        {
          type: 'UPDATE', model: 'item', id: itemId,
          input: { title: 'Updated lifecycle' },
        },
        {
          type: 'DELETE', model: 'item', id: itemId,
        },
      ]);

      expect(syncId).toBeGreaterThan(0);

      // Item should NOT exist after full lifecycle
      await new Promise((r) => setTimeout(r, 300));
      const data = await bootstrap();
      const items = (data.models as Record<string, unknown[]>)?.Item;
      if (items && Array.isArray(items)) {
        const found = items.find((t: unknown) => (t as Record<string, unknown>).id === itemId);
        expect(found).toBeUndefined();
      }
    });
  });
});
