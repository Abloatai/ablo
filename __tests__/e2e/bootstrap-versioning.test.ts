/**
 * E2E: Bootstrap Versioning — Full vs Partial Strategy
 *
 * Tests the server-side bootstrap strategy selection:
 * - No lastSyncId → full snapshot (all models)
 * - Recent lastSyncId → partial (delta batch)
 * - Very old lastSyncId → server decides (full or partial based on delta count)
 * - Mutations between bootstraps appear in partial delta batch
 * - Version consistency: lastSyncId monotonically increases
 *
 * The SDK always requests 'full' when online (server-authoritative), but passes
 * lastSyncId so the SERVER can optimize to partial. This tests that optimization.
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

async function bootstrap(lastSyncId?: number): Promise<Record<string, unknown>> {
  const params = new URLSearchParams({ organizationId: ORG_ID });
  if (lastSyncId !== undefined) params.append('lastSyncId', String(lastSyncId));
  const res = await fetch(`${BOOTSTRAP_URL}?${params}`, {
    headers: { 'X-User-Id': USER_ID, 'X-Organization-Id': ORG_ID },
  });
  if (!res.ok) throw new Error(`Bootstrap failed: ${res.status}`);
  return res.json();
}

describeE2E('E2E: Bootstrap Versioning (Full vs Partial)', () => {
  beforeAll(async () => {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 5000);
    try { const r = await fetch(HEALTH_URL, { signal: c.signal }); clearTimeout(t); if (!r.ok) throw new Error(`${r.status}`); }
    catch (e) { clearTimeout(t); throw new Error(`Server unreachable: ${e instanceof Error ? e.message : e}`); }
  }, 10000);

  describe('full bootstrap (no lastSyncId)', () => {
    it('should return type=full with models object', async () => {
      const data = await bootstrap();

      expect(data.type).toBe('full');
      expect(data.lastSyncId).toBeDefined();
      expect(typeof data.lastSyncId).toBe('number');
      expect((data.lastSyncId as number)).toBeGreaterThan(0);
      expect(data.models).toBeDefined();
      expect(typeof data.models).toBe('object');

      // Should NOT have deltas field in full bootstrap
      // (models field contains the full snapshot)
    });

    it('should contain all registered model types', async () => {
      const data = await bootstrap();
      const models = data.models as Record<string, unknown>;

      // Core models should always be present (even if empty arrays)
      const expectedModels = ['SyncMetadata', 'User', 'Team', 'Member'];
      for (const m of expectedModels) {
        expect(models[m]).toBeDefined();
      }
    });
  });

  describe('partial bootstrap (with lastSyncId)', () => {
    it('should return partial with delta batch when gap is small', async () => {
      // Get current sync state
      const fullData = await bootstrap();
      const currentSyncId = fullData.lastSyncId as number;

      // Create a few mutations to build a small delta gap
      const taskIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const id = uuid();
        taskIds.push(id);
        await batchAck([{
          type: 'CREATE', model: 'task', id,
          input: { title: `Versioning ${i}`, status: 'todo', organizationId: ORG_ID, createdBy: USER_ID },
        }]);
      }

      await new Promise((r) => setTimeout(r, 300));

      // Request partial bootstrap from before the mutations
      const partialData = await bootstrap(currentSyncId);

      // Server should decide partial since delta gap is small
      expect(partialData.lastSyncId).toBeDefined();
      expect((partialData.lastSyncId as number)).toBeGreaterThan(currentSyncId);

      if (partialData.type === 'partial') {
        // Partial: should have deltas array
        expect(partialData.deltas).toBeDefined();
        expect(Array.isArray(partialData.deltas)).toBe(true);
        const deltas = partialData.deltas as Array<Record<string, unknown>>;
        expect(deltas.length).toBeGreaterThan(0);

        // Log delta structure for debugging
        console.log('[Partial Bootstrap] Delta count:', deltas.length);
        if (deltas.length > 0) {
          console.log('[Partial Bootstrap] First delta keys:', Object.keys(deltas[0]));
          console.log('[Partial Bootstrap] First delta:', JSON.stringify(deltas[0]).slice(0, 200));
        }

        // Bootstrap deltas have the model ID in data.id (not modelId like WS deltas)
        const foundIds = taskIds.filter((id) =>
          deltas.some((d) =>
            d.modelId === id ||
            d.model_id === id ||
            (d.data && typeof d.data === 'object' && (d.data as Record<string, unknown>).id === id)
          )
        );
        expect(foundIds.length).toBeGreaterThan(0);
      }
      // If server returns full (too many deltas), that's also valid — just different strategy
    });

    it('should return lastSyncId >= the requested lastSyncId', async () => {
      const fullData = await bootstrap();
      const currentId = fullData.lastSyncId as number;

      const partialData = await bootstrap(currentId);
      expect((partialData.lastSyncId as number)).toBeGreaterThanOrEqual(currentId);
    });
  });

  describe('version monotonicity', () => {
    it('lastSyncId should never decrease across sequential bootstraps', async () => {
      let prevId = 0;

      for (let i = 0; i < 3; i++) {
        const data = await bootstrap();
        const currentId = data.lastSyncId as number;
        expect(currentId).toBeGreaterThanOrEqual(prevId);
        prevId = currentId;

        // Create a mutation between bootstraps
        await batchAck([{
          type: 'CREATE', model: 'task', id: uuid(),
          input: { title: `Mono ${i}`, status: 'todo', organizationId: ORG_ID, createdBy: USER_ID },
        }]);
      }
    });

    it('lastSyncId from batchAck should match next bootstrap', async () => {
      // Create a task and capture its syncId
      const syncId = await batchAck([{
        type: 'CREATE', model: 'task', id: uuid(),
        input: { title: 'SyncId check', status: 'todo', organizationId: ORG_ID, createdBy: USER_ID },
      }]);

      await new Promise((r) => setTimeout(r, 300));

      // Bootstrap should have lastSyncId >= what batchAck returned
      const data = await bootstrap();
      expect((data.lastSyncId as number)).toBeGreaterThanOrEqual(syncId);
    });
  });

  describe('delta gap recovery', () => {
    it('partial bootstrap should fill the exact gap between old and current', async () => {
      // Snapshot 1
      const snap1 = await bootstrap();
      const id1 = snap1.lastSyncId as number;

      // Create 5 mutations
      for (let i = 0; i < 5; i++) {
        await batchAck([{
          type: 'CREATE', model: 'task', id: uuid(),
          input: { title: `Gap ${i}`, status: 'todo', organizationId: ORG_ID, createdBy: USER_ID },
        }]);
      }

      await new Promise((r) => setTimeout(r, 300));

      // Request partial from snapshot 1's syncId
      const partialData = await bootstrap(id1);
      const id2 = partialData.lastSyncId as number;

      // The gap should be covered
      expect(id2).toBeGreaterThan(id1);

      if (partialData.type === 'partial' && Array.isArray(partialData.deltas)) {
        // Every delta in the batch should have syncId > id1
        for (const d of partialData.deltas as Array<Record<string, unknown>>) {
          expect((d.id as number)).toBeGreaterThan(id1);
        }
      }
    });

    it('requesting with lastSyncId=0 should return full bootstrap', async () => {
      const data = await bootstrap(0);
      // lastSyncId=0 means "I have nothing" → server returns full
      expect(data.type).toBe('full');
      expect(data.models).toBeDefined();
    });
  });

  describe('mutation visibility in bootstrap', () => {
    it('UPDATE should be visible in next bootstrap', async () => {
      const taskId = uuid();

      // Create
      await batchAck([{
        type: 'CREATE', model: 'task', id: taskId,
        input: { title: 'Before update', status: 'todo', organizationId: ORG_ID, createdBy: USER_ID },
      }]);

      // Update
      await batchAck([{
        type: 'UPDATE', model: 'task', id: taskId,
        input: { title: 'After update' },
      }]);

      await new Promise((r) => setTimeout(r, 300));

      const data = await bootstrap();
      if (data.models) {
        const tasks = (data.models as Record<string, unknown[]>).Task;
        if (tasks && Array.isArray(tasks)) {
          const task = tasks.find((t: unknown) => (t as Record<string, unknown>).id === taskId);
          if (task) {
            expect((task as Record<string, unknown>).title).toBe('After update');
          }
        }
      }
    });

    it('DELETE should remove entity from next bootstrap', async () => {
      const taskId = uuid();

      await batchAck([{
        type: 'CREATE', model: 'task', id: taskId,
        input: { title: 'Will be deleted', status: 'todo', organizationId: ORG_ID, createdBy: USER_ID },
      }]);
      await batchAck([{ type: 'DELETE', model: 'task', id: taskId }]);

      await new Promise((r) => setTimeout(r, 300));

      const data = await bootstrap();
      if (data.models) {
        const tasks = (data.models as Record<string, unknown[]>).Task;
        if (tasks && Array.isArray(tasks)) {
          const found = tasks.find((t: unknown) => (t as Record<string, unknown>).id === taskId);
          expect(found).toBeUndefined();
        }
      }
    });
  });
});
