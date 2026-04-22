/**
 * Property-based tests for OfflineTransactionStore.
 *
 * Uses fast-check to verify:
 * - enqueue+listAll is lossless for any transaction data
 * - topological sort output respects all dependency edges
 * - flush processes exactly the set of enqueued transactions
 */

import fc from 'fast-check';
import { OfflineTransactionStore } from '../../src/sync/OfflineTransactionStore';
import { createTestContext, resetFixtureCounter } from '../../src/testing';

describe('Property: OfflineTransactionStore Invariants', () => {
  let cleanup: () => void;

  beforeEach(() => {
    resetFixtureCounter();
    const ctx = createTestContext();
    cleanup = ctx.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  it('enqueue + listAll is lossless: every enqueued tx appears in list', () => {
    fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            id: fc.uuid(),
            opName: fc.constantFrom('CreateTask', 'UpdateTask', 'DeleteTask'),
            priority: fc.constantFrom(0, 1, 2, 3) as fc.Arbitrary<0 | 1 | 2 | 3>,
          }),
          { minLength: 1, maxLength: 20 }
        ),
        async (txDefs) => {
          // Delete the DB entirely to guarantee a clean slate between iterations
          // (clear() races with shared fake-indexeddb state in-process)
          indexedDB.deleteDatabase('ablo-sync');
          const store = new OfflineTransactionStore();
          await store.init();

          const enqueuedIds = new Set<string>();
          for (const def of txDefs) {
            // Skip duplicate IDs (IndexedDB keyPath constraint)
            if (enqueuedIds.has(def.id)) continue;
            enqueuedIds.add(def.id);
            await store.enqueue({
              id: def.id,
              opName: def.opName,
              priority: def.priority,
              request: {},
            });
          }

          const all = await store.listAll();
          const listedIds = new Set(all.map((t) => t.id));

          // INVARIANT: every enqueued ID appears in listAll
          for (const id of enqueuedIds) {
            expect(listedIds.has(id)).toBe(true);
          }

          // INVARIANT: listAll contains no extra IDs
          expect(listedIds.size).toBe(enqueuedIds.size);

          await store.clear();
        }
      ),
      { numRuns: 20 }
    );
  });

  it('topological sort respects all dependency edges', () => {
    fc.assert(
      fc.asyncProperty(
        // Generate a DAG: N nodes, random edges (no cycles)
        fc.integer({ min: 3, max: 8 }).chain((n) => {
          const ids = Array.from({ length: n }, (_, i) => `tx-${i}`);
          // Generate edges that only point forward (guarantees no cycles)
          const edges = fc.array(
            fc.record({
              from: fc.integer({ min: 1, max: n - 1 }),
              to: fc.integer({ min: 0, max: n - 2 }),
            }).filter(({ from, to }) => to < from), // Only backward edges = forward deps
            { maxLength: n * 2 }
          );
          return edges.map((edgeList) => ({ ids, edges: edgeList }));
        }),
        async ({ ids, edges }) => {
          const store = new OfflineTransactionStore();
          await store.init();

          // Build dependency map
          const deps = new Map<string, string[]>();
          for (const { from, to } of edges) {
            const fromId = ids[from];
            const toId = ids[to];
            if (!deps.has(fromId)) deps.set(fromId, []);
            deps.get(fromId)!.push(toId);
          }

          // Enqueue in reverse order (worst case for topological sort)
          for (let i = ids.length - 1; i >= 0; i--) {
            await store.enqueue({
              id: ids[i],
              opName: 'Op',
              priority: 2,
              dependsOn: deps.get(ids[i]),
              request: {},
            });
          }

          const order = await store.getOptimizedSyncOrder();
          const orderMap = new Map(order.map((t, idx) => [t.id, idx]));

          // INVARIANT: for every edge (from depends on to), to appears before from
          for (const { from, to } of edges) {
            const fromIdx = orderMap.get(ids[from]);
            const toIdx = orderMap.get(ids[to]);
            if (fromIdx !== undefined && toIdx !== undefined) {
              expect(toIdx).toBeLessThan(fromIdx);
            }
          }

          await store.clear();
        }
      ),
      { numRuns: 20 }
    );
  });

  it('flush processes exactly the enqueued set (no loss, no extras)', () => {
    fc.assert(
      fc.asyncProperty(
        fc.array(fc.uuid(), { minLength: 1, maxLength: 15 }),
        async (ids) => {
          indexedDB.deleteDatabase('ablo-sync');
          const store = new OfflineTransactionStore();
          await store.init();

          const uniqueIds = [...new Set(ids)]; // Dedupe
          for (const id of uniqueIds) {
            await store.enqueue({ id, opName: 'Op', priority: 2, request: {} });
          }

          const processed: string[] = [];
          await store.flush(async (tx) => {
            processed.push(tx.id);
          });

          // INVARIANT: every enqueued ID was processed
          const processedSet = new Set(processed);
          for (const id of uniqueIds) {
            expect(processedSet.has(id)).toBe(true);
          }

          // INVARIANT: nothing extra was processed
          expect(processed.length).toBe(uniqueIds.length);

          // INVARIANT: store is empty after successful flush
          const remaining = await store.listAll();
          expect(remaining).toHaveLength(0);
        }
      ),
      { numRuns: 15 }
    );
  });

  it('priority ordering is consistent: lower number always comes first', () => {
    fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            id: fc.uuid(),
            priority: fc.constantFrom(0, 1, 2, 3) as fc.Arbitrary<0 | 1 | 2 | 3>,
          }),
          { minLength: 2, maxLength: 15 }
        ),
        async (txDefs) => {
          indexedDB.deleteDatabase('ablo-sync');
          const store = new OfflineTransactionStore();
          await store.init();

          const uniqueDefs = txDefs.filter(
            (def, i, arr) => arr.findIndex((d) => d.id === def.id) === i
          );

          for (const def of uniqueDefs) {
            await store.enqueue({
              id: def.id,
              opName: 'Op',
              priority: def.priority,
              request: {},
            });
          }

          const order = await store.getOptimizedSyncOrder();

          // INVARIANT: for any two adjacent transactions, the first has
          // priority ≤ the second (within same dependency level)
          // Since we have no dependencies here, pure priority ordering applies
          for (let i = 1; i < order.length; i++) {
            expect(order[i - 1].priority).toBeLessThanOrEqual(order[i].priority);
          }

          await store.clear();
        }
      ),
      { numRuns: 15 }
    );
  });
});
