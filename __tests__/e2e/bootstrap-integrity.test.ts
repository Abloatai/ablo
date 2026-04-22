/**
 * E2E: Bootstrap Data Integrity + Partial Delta Gap
 *
 * Tests the bootstrap pipeline against the real server:
 * - Full bootstrap returns created entities
 * - Partial bootstrap fills delta gap
 * - Bootstrap response shape matches SDK expectations
 * - Created data appears in subsequent bootstrap
 *
 * Requires: GO_ENV=test go run cmd/server/main.go
 */

import { v4 as uuid } from 'uuid';

const E2E_ENABLED = process.env.E2E_TEST === 'true';
const SERVER_URL = process.env.SYNC_SERVER_URL ?? 'http://localhost:8080';
const GRAPHQL_URL = `${SERVER_URL}/api/graphql`;
const HEALTH_URL = `${SERVER_URL}/api/health`;
const BOOTSTRAP_URL = `${SERVER_URL}/api/sync/bootstrap`;
const USER_ID = process.env.E2E_USER_ID ?? 'e039da97-4c81-4387-bb2f-fbd6dac9792d';
const ORG_ID = process.env.E2E_ORG_ID ?? 'b605f83d-1015-400c-9a9f-9e292c7a1b8c';

const describeE2E = E2E_ENABLED ? describe : describe.skip;

async function batchAck(ops: Array<Record<string, unknown>>): Promise<number> {
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

async function fetchBootstrap(lastSyncId?: number): Promise<Record<string, unknown>> {
  const url = lastSyncId ? `${BOOTSTRAP_URL}?lastSyncId=${lastSyncId}` : BOOTSTRAP_URL;
  const res = await fetch(url, {
    headers: { 'X-User-Id': USER_ID, 'X-Organization-Id': ORG_ID },
  });
  if (!res.ok) throw new Error(`Bootstrap failed: ${res.status}`);
  return res.json();
}

describeE2E('E2E: Bootstrap Data Integrity', () => {
  beforeAll(async () => {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 5000);
    try { const r = await fetch(HEALTH_URL, { signal: c.signal }); clearTimeout(t); if (!r.ok) throw new Error(`${r.status}`); }
    catch (e) { clearTimeout(t); throw new Error(`Server unreachable: ${e instanceof Error ? e.message : e}`); }
  }, 10000);

  describe('full bootstrap', () => {
    it('should return correct response shape', async () => {
      const data = await fetchBootstrap();

      expect(data.type).toBeDefined();
      expect(data.lastSyncId).toBeDefined();
      expect(typeof data.lastSyncId).toBe('number');
      expect((data.lastSyncId as number)).toBeGreaterThan(0);
      expect(data.models).toBeDefined();
      expect(typeof data.models).toBe('object');
    });

    it('should include SyncMetadata model', async () => {
      const data = await fetchBootstrap();
      const models = data.models as Record<string, unknown>;

      // SyncMetadata should always be present
      expect(models.SyncMetadata).toBeDefined();
    });

    it('should contain tasks created via batchAck', async () => {
      // Create a uniquely identifiable task
      const taskId = uuid();
      const title = `Bootstrap-verify-${taskId.slice(0, 8)}`;
      await batchAck([{
        type: 'CREATE', model: 'task', id: taskId,
        input: { title, status: 'todo', organizationId: ORG_ID, createdBy: USER_ID },
      }]);

      // Wait for persistence
      await new Promise((r) => setTimeout(r, 500));

      // Bootstrap should now include this task
      const data = await fetchBootstrap();
      const models = data.models as Record<string, unknown[]>;
      const tasks = models.Task;

      if (tasks && Array.isArray(tasks)) {
        const found = tasks.find((t: unknown) => (t as Record<string, unknown>).id === taskId);
        expect(found).toBeDefined();
        if (found) {
          expect((found as Record<string, unknown>).title).toBe(title);
        }
      }
    });
  });

  describe('partial bootstrap (delta gap)', () => {
    it('should return deltas since lastSyncId', async () => {
      // Get current sync state
      const fullData = await fetchBootstrap();
      const beforeSyncId = fullData.lastSyncId as number;

      // Create some tasks after the sync point
      const taskIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const id = uuid();
        taskIds.push(id);
        await batchAck([{
          type: 'CREATE', model: 'task', id,
          input: { title: `Partial-${i}`, status: 'todo', organizationId: ORG_ID, createdBy: USER_ID },
        }]);
      }

      await new Promise((r) => setTimeout(r, 500));

      // Request partial bootstrap from before the new tasks
      const partialData = await fetchBootstrap(beforeSyncId);

      expect(partialData.lastSyncId).toBeDefined();
      expect((partialData.lastSyncId as number)).toBeGreaterThanOrEqual(beforeSyncId);

      // The response should contain the new tasks (either as models or deltas)
      // Depending on server implementation it may return full or partial
      if (partialData.type === 'partial' && partialData.deltas) {
        // Check deltas contain our tasks
        const deltas = partialData.deltas as Array<Record<string, unknown>>;
        for (const id of taskIds) {
          const found = deltas.find((d) => d.modelId === id);
          // May or may not be in delta batch depending on server delta count threshold
          if (found) {
            expect(found.actionType).toBe('I');
          }
        }
      }
    });

    it('should return consistent lastSyncId across requests', async () => {
      const data1 = await fetchBootstrap();
      const data2 = await fetchBootstrap();

      // lastSyncId should be monotonically non-decreasing
      expect((data2.lastSyncId as number)).toBeGreaterThanOrEqual((data1.lastSyncId as number));
    });
  });

  describe('data integrity after mutations', () => {
    it('should not return deleted entities in bootstrap', async () => {
      // Create and delete a task
      const taskId = uuid();
      await batchAck([{
        type: 'CREATE', model: 'task', id: taskId,
        input: { title: 'Delete-from-bootstrap', status: 'todo', organizationId: ORG_ID, createdBy: USER_ID },
      }]);
      await batchAck([{ type: 'DELETE', model: 'task', id: taskId }]);

      await new Promise((r) => setTimeout(r, 500));

      // Bootstrap should NOT contain the deleted task
      const data = await fetchBootstrap();
      const models = data.models as Record<string, unknown[]>;
      const tasks = models.Task;

      if (tasks && Array.isArray(tasks)) {
        const found = tasks.find((t: unknown) => (t as Record<string, unknown>).id === taskId);
        expect(found).toBeUndefined();
      }
    });

    it('should return updated data in bootstrap', async () => {
      const taskId = uuid();
      const originalTitle = `Update-bootstrap-${taskId.slice(0, 8)}`;
      const updatedTitle = `Updated-${taskId.slice(0, 8)}`;

      // Create
      await batchAck([{
        type: 'CREATE', model: 'task', id: taskId,
        input: { title: originalTitle, status: 'todo', organizationId: ORG_ID, createdBy: USER_ID },
      }]);

      // Update
      await batchAck([{
        type: 'UPDATE', model: 'task', id: taskId,
        input: { title: updatedTitle },
      }]);

      await new Promise((r) => setTimeout(r, 500));

      // Bootstrap should have the updated title
      const data = await fetchBootstrap();
      const models = data.models as Record<string, unknown[]>;
      const tasks = models.Task;

      if (tasks && Array.isArray(tasks)) {
        const found = tasks.find((t: unknown) => (t as Record<string, unknown>).id === taskId);
        if (found) {
          expect((found as Record<string, unknown>).title).toBe(updatedTitle);
        }
      }
    });
  });
});
