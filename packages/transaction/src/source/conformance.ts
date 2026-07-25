/**
 * Canonical capability-split conformance for customer-database mutation wrappers.
 *
 * `mutationConformanceChecks` covers only guarantees shared by direct and
 * endpoint: schema-mapped DML, reads, permanent scoped idempotency, canonical
 * request-hash conflicts, and concurrent replay. `endpointConformanceChecks`
 * covers the endpoint-only transactional outbox and events cursor. Direct
 * wrappers must not run (or claim) those outbox guarantees because WAL is their
 * sole source feed.
 */

import assert from 'node:assert/strict';
import type {
  DataSourceAdapter,
  MutationAdapter,
} from './adapter.js';
import type { ChangeSet } from './contract.js';

export type MakeMutationAdapter =
  () => MutationAdapter | Promise<MutationAdapter>;
export type MakeAdapter =
  () => DataSourceAdapter | Promise<DataSourceAdapter>;

export interface ConformanceCheck {
  readonly name: string;
  run(): Promise<void>;
}

export interface MutationConformanceOptions {
  /**
   * Add transport-required evidence without changing the shared checks. Direct
   * wrappers use this to attach their logical marker; endpoint wrappers need no
   * decoration.
   */
  readonly prepareChange?: (change: ChangeSet) => ChangeSet;
}

const change = (
  correlationId: string,
  operations: ChangeSet['operations'],
  intentHash?: string,
): ChangeSet => ({
  correlationId,
  operations,
  ...(intentHash ? { intentHash } : {}),
});

/** Guarantees shared by direct and endpoint mutation wrappers. */
export function mutationConformanceChecks(
  make: MakeMutationAdapter,
  options: MutationConformanceOptions = {},
): ConformanceCheck[] {
  const request = (
    correlationId: string,
    operations: ChangeSet['operations'],
    intentHash?: string,
  ): ChangeSet => {
    const value = change(correlationId, operations, intentHash);
    return options.prepareChange?.(value) ?? value;
  };
  return [
    {
      name: 'commit applies a CREATE and returns the canonical row',
      run: async () => {
        const adapter = await make();
        const result = await adapter.commit(
          request('corr_create', [
            { type: 'CREATE', model: 'task', id: 't1', input: { title: 'A' } },
          ]),
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
        await adapter.commit(request('corr_load', [
          { type: 'CREATE', model: 'task', id: 't1', input: { title: 'A' } },
        ]));
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
        await adapter.commit(request('corr_list', [
          { type: 'CREATE', model: 'task', id: 't1', input: { title: 'A' } },
          { type: 'CREATE', model: 'task', id: 't2', input: { title: 'B' } },
        ]));
        const rows = await adapter.read({ kind: 'list', model: 'task' });
        assert.deepEqual(rows.map((row) => row.id).sort(), ['t1', 't2']);
      },
    },
    {
      name: 'same scoped correlation and intent replays the original response without DML',
      run: async () => {
        const adapter = await make();
        const commitRequest = request('corr_replay', [
          { type: 'CREATE', model: 'task', id: 't1', input: { title: 'A', n: 1 } },
        ]);
        const first = await adapter.commit(commitRequest);
        const second = await adapter.commit(commitRequest);
        assert.deepEqual(second.rows, first.rows, 'replay returns the original rows');
        const rows = await adapter.read({ kind: 'list', model: 'task' });
        assert.equal(rows.length, 1, 'no duplicate row');
      },
    },
    {
      name: 'same scoped correlation with a different canonical intent rejects',
      run: async () => {
        const adapter = await make();
        await adapter.commit(request(
          'corr_conflict',
          [{ type: 'CREATE', model: 'task', id: 't1', input: { title: 'A' } }],
          'a'.repeat(64),
        ));
        await assert.rejects(
          adapter.commit(request(
            'corr_conflict',
            [{ type: 'UPDATE', model: 'task', id: 't1', input: { title: 'B' } }],
            'b'.repeat(64),
          )),
          (error: unknown) =>
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'idempotency_conflict',
        );
      },
    },
    {
      name: 'concurrent identical requests apply once and replay one response',
      run: async () => {
        const adapter = await make();
        const commitRequest = request('corr_concurrent', [
          { type: 'CREATE', model: 'task', id: 't1', input: { title: 'A' } },
        ]);
        const [first, second] = await Promise.all([
          adapter.commit(commitRequest),
          adapter.commit(commitRequest),
        ]);
        assert.deepEqual(second.rows, first.rows);
        const rows = await adapter.read({ kind: 'list', model: 'task' });
        assert.equal(rows.length, 1, 'concurrent retries produced one row');
      },
    },
    {
      name: 'a later mutation under a new scoped correlation is applied',
      run: async () => {
        const adapter = await make();
        await adapter.commit(request('corr_create_2', [
          { type: 'CREATE', model: 'task', id: 't1', input: { title: 'A' } },
        ]));
        await adapter.commit(request('corr_update_2', [
          { type: 'UPDATE', model: 'task', id: 't1', input: { title: 'B' } },
        ]));
        const found = await adapter.read({ kind: 'load', model: 'task', id: 't1' });
        assert.equal(found[0]?.title, 'B', 'update applied');
      },
    },
  ];
}

/** Guarantees that apply only to endpoint wrappers with an outbox/events feed. */
export function endpointConformanceChecks(make: MakeAdapter): ConformanceCheck[] {
  return [
    {
      name: 'endpoint replay does not append its correlated outbox event twice',
      run: async () => {
        const adapter = await make();
        assert.equal(adapter.capabilities.outboxEvents, true);
        const request = change('corr_outbox_replay', [
          {
            type: 'CREATE',
            model: 'task',
            id: 't1',
            input: { title: 'A' },
            transactionId: 'op_outbox_replay',
          },
        ]);
        await adapter.commit(request);
        await adapter.commit(request);
        const page = await adapter.events(null, 100);
        assert.equal(
          page.events.filter((event) => event.correlationId === 'corr_outbox_replay').length,
          1,
        );
      },
    },
    {
      name: 'endpoint outbox exposes explicit correlation and operation identity',
      run: async () => {
        const adapter = await make();
        assert.equal(adapter.capabilities.outboxEvents, true);
        await adapter.commit(change('corr_event', [
          {
            type: 'CREATE',
            model: 'task',
            id: 't1',
            input: { title: 'A' },
            transactionId: 'op_event',
          },
        ]));
        const page = await adapter.events(null, 100);
        const event = page.events.find((candidate) => candidate.entityId === 't1');
        assert.ok(event, 'event for the committed row');
        assert.equal(event.model, 'task');
        assert.equal(event.type, 'CREATE');
        assert.equal(event.correlationId, 'corr_event');
        assert.equal(event.transactionId, 'op_event');
        assert.equal(event.clientTxId ?? null, null, 'legacy echo identity stays empty');
      },
    },
    {
      name: 'endpoint events cursor advances and never re-delivers a page',
      run: async () => {
        const adapter = await make();
        await adapter.commit(change('corr_page_a', [
          { type: 'CREATE', model: 'task', id: 't1', input: {} },
        ]));
        await adapter.commit(change('corr_page_b', [
          { type: 'CREATE', model: 'task', id: 't2', input: {} },
        ]));

        const first = await adapter.events(null, 1);
        assert.equal(first.events.length, 1, 'respects limit');
        assert.ok(first.nextCursor, 'returns a cursor');
        const second = await adapter.events(first.nextCursor, 100);
        const firstIds = new Set(first.events.map((event) => event.id));
        for (const event of second.events) {
          assert.ok(!firstIds.has(event.id), `event ${event.id} re-delivered across cursor`);
        }
        const drained = await adapter.events(second.nextCursor ?? first.nextCursor, 100);
        assert.equal(drained.events.length, 0, 'fully drained');
      },
    },
  ];
}

/** Compatibility name for the complete endpoint adapter suite. */
export function dataSourceConformanceChecks(make: MakeAdapter): ConformanceCheck[] {
  return [
    ...mutationConformanceChecks(make),
    ...endpointConformanceChecks(make),
  ];
}

export function runMutationTests(
  make: MakeMutationAdapter,
  register: (name: string, fn: () => Promise<void>) => void,
  options: MutationConformanceOptions = {},
): void {
  for (const check of mutationConformanceChecks(make, options)) {
    register(check.name, check.run);
  }
}

export function runEndpointDataSourceTests(
  make: MakeAdapter,
  register: (name: string, fn: () => Promise<void>) => void,
): void {
  for (const check of endpointConformanceChecks(make)) {
    register(check.name, check.run);
  }
}

/** Backward-compatible complete endpoint suite. */
export function runDataSourceTests(
  make: MakeAdapter,
  register: (name: string, fn: () => Promise<void>) => void,
): void {
  for (const check of dataSourceConformanceChecks(make)) {
    register(check.name, check.run);
  }
}

export { memoryDataSource } from './adapters/memory.js';
