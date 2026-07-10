/**
 * The conformance suite for data-source adapters: a shared set of tests that checks
 * whether an adapter is correct. Every adapter in this package (Prisma, Drizzle,
 * Kysely) and any adapter you write yourself runs this suite to confirm it upholds
 * the guarantees {@link DataSourceAdapter} promises. An adapter is complete when it
 * passes, not merely when it compiles.
 *
 * The suite is runner-agnostic: each check is a plain async function that throws,
 * via `node:assert`, on failure. {@link runDataSourceTests} registers the checks
 * with whichever `it` or `test` function you pass, so it runs under vitest, jest,
 * or `node:test`:
 *
 *   import { it } from 'vitest';
 *   runDataSourceTests(memoryDataSource, it);
 *
 * The checks cover the adapter contract: commit idempotency, read-after-write, and
 * the transactional outbox with its cursor. They do not cover request-signature or
 * scope rejection, which the HTTP handler enforces before the adapter is ever
 * called and which is tested separately.
 */

import assert from 'node:assert/strict';
import type { DataSourceAdapter, Row } from './adapter.js';
import type { ChangeSet } from './contract.js';

/** A factory that returns a fresh adapter. Each check calls it to start from clean state. */
export type MakeAdapter = () => DataSourceAdapter | Promise<DataSourceAdapter>;

/** A single conformance check. `run` throws on failure. */
export interface ConformanceCheck {
  readonly name: string;
  run(): Promise<void>;
}

const change = (clientTxId: string, ops: ChangeSet['operations']): ChangeSet => ({
  clientTxId,
  operations: ops,
});

/**
 * Builds the list of conformance checks for an adapter. Call this to run the checks
 * yourself, or use {@link runDataSourceTests} to register them with a test runner.
 */
export function dataSourceConformanceChecks(make: MakeAdapter): ConformanceCheck[] {
  return [
    {
      name: 'commit applies a CREATE and returns the canonical row',
      run: async () => {
        const adapter = await make();
        const result = await adapter.commit(
          change('tx_create', [{ type: 'CREATE', model: 'task', id: 't1', input: { title: 'A' } }]),
        );
        assert.equal(result.rows.length, 1, 'one row returned');
        const created = result.rows[0];
        assert.ok(created, 'one row returned');
        assert.equal(created.id, 't1');
        assert.equal(created.title, 'A');
      },
    },
    {
      name: 'read load returns a committed row, and null-equivalent for an unknown id',
      run: async () => {
        const adapter = await make();
        await adapter.commit(change('tx1', [{ type: 'CREATE', model: 'task', id: 't1', input: { title: 'A' } }]));
        const found = await adapter.read({ kind: 'load', model: 'task', id: 't1' });
        assert.equal(found.length, 1);
        assert.equal(found[0]?.title, 'A');
        const missing = await adapter.read({ kind: 'load', model: 'task', id: 'nope' });
        assert.equal(missing.length, 0, 'unknown id reads empty');
      },
    },
    {
      name: 'read list returns committed rows',
      run: async () => {
        const adapter = await make();
        await adapter.commit(
          change('tx_list', [
            { type: 'CREATE', model: 'task', id: 't1', input: { title: 'A' } },
            { type: 'CREATE', model: 'task', id: 't2', input: { title: 'B' } },
          ]),
        );
        const rows = await adapter.read({ kind: 'list', model: 'task' });
        const ids = rows.map((r) => (r).id).sort();
        assert.deepEqual(ids, ['t1', 't2']);
      },
    },
    {
      name: 'duplicate clientTxId is idempotent — same rows, applied once',
      run: async () => {
        const adapter = await make();
        const cs = change('tx_dup', [{ type: 'CREATE', model: 'task', id: 't1', input: { title: 'A', n: 1 } }]);
        const first = await adapter.commit(cs);
        const second = await adapter.commit(cs);
        assert.deepEqual(second.rows, first.rows, 'replay returns the original rows');
        // Applied once: still exactly one row, and the outbox did not double up.
        const rows = await adapter.read({ kind: 'list', model: 'task' });
        assert.equal(rows.length, 1, 'no duplicate row');
        const page = await adapter.events(null, 100);
        const forTx = page.events.filter((e) => e.clientTxId === 'tx_dup');
        assert.equal(forTx.length, 1, 'outbox not double-appended on replay');
      },
    },
    {
      name: 'commit appends outbox events with the originating clientTxId',
      run: async () => {
        const adapter = await make();
        await adapter.commit(change('tx_evt', [{ type: 'CREATE', model: 'task', id: 't1', input: { title: 'A' } }]));
        const page = await adapter.events(null, 100);
        assert.ok(page.events.length >= 1, 'at least one event');
        const evt = page.events.find((e) => e.entityId === 't1');
        assert.ok(evt, 'event for the committed row');
        assert.equal(evt.model, 'task');
        assert.equal(evt.type, 'CREATE');
        assert.equal(evt.clientTxId, 'tx_evt');
      },
    },
    {
      name: 'events cursor advances and never re-delivers a page',
      run: async () => {
        const adapter = await make();
        await adapter.commit(change('tx_a', [{ type: 'CREATE', model: 'task', id: 't1', input: {} }]));
        await adapter.commit(change('tx_b', [{ type: 'CREATE', model: 'task', id: 't2', input: {} }]));

        const first = await adapter.events(null, 1);
        assert.equal(first.events.length, 1, 'respects limit');
        assert.ok(first.nextCursor, 'returns a cursor');

        const second = await adapter.events(first.nextCursor, 100);
        // No overlap: the second page starts strictly after the first cursor.
        const firstIds = new Set(first.events.map((e) => e.id));
        for (const e of second.events) {
          assert.ok(!firstIds.has(e.id), `event ${e.id} re-delivered across cursor`);
        }

        // Draining to the end yields a stable terminal cursor.
        const drained = await adapter.events(second.nextCursor ?? first.nextCursor, 100);
        assert.equal(drained.events.length, 0, 'fully drained');
      },
    },
    {
      name: 'a later UPDATE under a new clientTxId is applied (idempotency is per-transaction)',
      run: async () => {
        const adapter = await make();
        await adapter.commit(change('tx_c1', [{ type: 'CREATE', model: 'task', id: 't1', input: { title: 'A' } }]));
        await adapter.commit(change('tx_u1', [{ type: 'UPDATE', model: 'task', id: 't1', input: { title: 'B' } }]));
        const found = await adapter.read({ kind: 'load', model: 'task', id: 't1' });
        assert.equal(found[0]?.title, 'B', 'update applied');
      },
    },
  ];
}

/**
 * Register the conformance checks with a test runner's `it`/`test` function.
 * `register(name, fn)` — pass vitest/jest `it` or `node:test` `test`.
 */
export function runDataSourceTests(
  make: MakeAdapter,
  register: (name: string, fn: () => Promise<void>) => void,
): void {
  for (const check of dataSourceConformanceChecks(make)) {
    register(check.name, check.run);
  }
}

// Re-export the reference adapter so `@abloatai/ablo/source/conformance`
// exposes both the suite and the in-memory double in one import.
export { memoryDataSource } from './adapters/memory.js';
