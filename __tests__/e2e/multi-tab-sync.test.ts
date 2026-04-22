/**
 * E2E: Multi-Tab Sync + Concurrent Mutations
 *
 * Tests that two WebSocket connections (simulating two browser tabs)
 * both receive each other's deltas via Redis pub/sub fan-out.
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
const USER_ID = process.env.E2E_USER_ID ?? 'e039da97-4c81-4387-bb2f-fbd6dac9792d';
const ORG_ID = process.env.E2E_ORG_ID ?? 'b605f83d-1015-400c-9a9f-9e292c7a1b8c';

const describeE2E = E2E_ENABLED ? describe : describe.skip;

function connectWS(userId: string, orgId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ userId, organizationId: orgId });
    const ws = new WebSocket(`${WS_URL}?${params}`, {
      headers: { 'X-User-Id': userId, 'X-Organization-Id': orgId },
    });
    const timeout = setTimeout(() => { ws.close(); reject(new Error('WS timeout')); }, 5000);
    ws.on('open', () => { clearTimeout(timeout); resolve(ws); });
    ws.on('error', (err: Error) => { clearTimeout(timeout); reject(err); });
  });
}

async function batchAck(userId: string, orgId: string, ops: Array<Record<string, unknown>>): Promise<number> {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Id': userId, 'X-Organization-Id': orgId },
    body: JSON.stringify({
      query: `mutation BatchAck($operations: [MutationOperation!]!) { batchAck(operations: $operations) { lastSyncId } }`,
      variables: { operations: ops },
    }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return Number(body.data.batchAck.lastSyncId);
}

function collectDeltas(ws: WebSocket): Set<string> {
  const ids = new Set<string>();
  ws.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'delta' && msg.payload?.modelId) {
        ids.add(msg.payload.modelId);
      }
    } catch { /* ignore */ }
  });
  return ids;
}

describeE2E('E2E: Multi-Tab Sync', () => {
  beforeAll(async () => {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 5000);
    try { const r = await fetch(HEALTH_URL, { signal: c.signal }); clearTimeout(t); if (!r.ok) throw new Error(`${r.status}`); }
    catch (e) { clearTimeout(t); throw new Error(`Server unreachable: ${e instanceof Error ? e.message : e}`); }
  }, 10000);

  it('Tab A mutation → Tab B receives delta (fan-out)', async () => {
    const wsA = await connectWS(USER_ID, ORG_ID);
    const wsB = await connectWS(USER_ID, ORG_ID);

    const deltasB = collectDeltas(wsB);

    const taskId = uuid();
    await batchAck(USER_ID, ORG_ID, [{
      type: 'CREATE', model: 'task', id: taskId,
      input: { title: 'Tab A created', status: 'todo', organizationId: ORG_ID, createdBy: USER_ID },
    }]);

    await new Promise((r) => setTimeout(r, 2000));

    expect(deltasB.has(taskId)).toBe(true);

    wsA.close();
    wsB.close();
  }, 10000);

  it('Both tabs receive deltas from interleaved mutations', async () => {
    const wsA = await connectWS(USER_ID, ORG_ID);
    const wsB = await connectWS(USER_ID, ORG_ID);

    const deltasA = collectDeltas(wsA);
    const deltasB = collectDeltas(wsB);

    const taskA = uuid();
    const taskB = uuid();

    // Tab A creates
    await batchAck(USER_ID, ORG_ID, [{
      type: 'CREATE', model: 'task', id: taskA,
      input: { title: 'From A', status: 'todo', organizationId: ORG_ID, createdBy: USER_ID },
    }]);

    // Tab B creates
    await batchAck(USER_ID, ORG_ID, [{
      type: 'CREATE', model: 'task', id: taskB,
      input: { title: 'From B', status: 'todo', organizationId: ORG_ID, createdBy: USER_ID },
    }]);

    await new Promise((r) => setTimeout(r, 3000));

    // Both tabs should see both tasks
    expect(deltasA.has(taskA)).toBe(true);
    expect(deltasA.has(taskB)).toBe(true);
    expect(deltasB.has(taskA)).toBe(true);
    expect(deltasB.has(taskB)).toBe(true);

    wsA.close();
    wsB.close();
  }, 15000);

  it('rapid concurrent mutations from multiple tabs produce unique syncIds', async () => {
    const wsA = await connectWS(USER_ID, ORG_ID);
    const wsB = await connectWS(USER_ID, ORG_ID);

    // Fire 5 mutations from each "tab" concurrently
    const promises: Promise<number>[] = [];
    for (let i = 0; i < 5; i++) {
      promises.push(batchAck(USER_ID, ORG_ID, [{
        type: 'CREATE', model: 'task', id: uuid(),
        input: { title: `TabA-${i}`, status: 'todo', organizationId: ORG_ID, createdBy: USER_ID },
      }]));
      promises.push(batchAck(USER_ID, ORG_ID, [{
        type: 'CREATE', model: 'task', id: uuid(),
        input: { title: `TabB-${i}`, status: 'todo', organizationId: ORG_ID, createdBy: USER_ID },
      }]));
    }

    const syncIds = await Promise.all(promises);

    // All 10 syncIds should be unique
    const unique = new Set(syncIds);
    expect(unique.size).toBe(10);

    // All should be positive
    for (const id of syncIds) {
      expect(id).toBeGreaterThan(0);
    }

    wsA.close();
    wsB.close();
  }, 15000);
});
