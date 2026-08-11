/**
 * kyselyDataSource flow test — exercises the adapter's builder-call
 * generation + transaction/idempotency/outbox sequencing against a recording
 * fake `KyselyLike`, and PROVES the schema-driven field→column casing: the
 * adapter writes snake_case columns (matching `ablo migrate` /
 * `generateProvisionPlan`) and maps DB rows back to camelCase fields. The
 * fake records every builder chain as a normalized call descriptor — the
 * exact table/column strings that would hit Postgres. Full conformance
 * against a live DB (or pglite) is the deferred integration step, same as
 * the Prisma/Drizzle adapters.
 */

import { defineSchema } from '@abloatai/transaction/schema/schema';
import { model } from '@abloatai/transaction/schema/model';
import { field } from '@abloatai/transaction/schema/field';
import {
  createKyselyMutationCore,
  kyselyDataSource,
  kyselyDirectMutation,
  type KyselyLike,
  type KyselySelectBuilder,
  type KyselyInsertBuilder,
  type KyselyInsertValuesBuilder,
  type KyselyUpdateBuilder,
  type KyselyUpdateSetBuilder,
  type KyselyDeleteBuilder,
  type KyselyReturningExecutable,
} from '../adapters/kysely.js';
import { SOURCE_IDEMPOTENCY_RETENTION } from '../idempotency.js';
import type { Row } from '../adapter.js';

// A schema where field names DIVERGE from columns three ways:
//   - operatorId      → operator_id      (default camelToSnake rule)
//   - legacyName      → display_label    (explicit `field.from()` override)
//   - organizationId  → organization_id  (base tenancy column)
const schema = defineSchema({
  task: model({
    title: field.string(),
    operatorId: field.string().optional(),
    legacyName: field.string().from('display_label').optional(),
  }),
});

interface RecordedCall {
  kind: 'select' | 'insert' | 'update' | 'delete' | 'raw';
  table: string;
  values?: Row;
  set?: Row;
  wheres: [string, string, unknown][];
  orderBy?: [string, 'asc' | 'desc'];
  limit?: number;
}

/** Records every builder chain; answers each `execute()` from a queue. */
class FakeKysely implements KyselyLike {
  readonly calls: RecordedCall[] = [];
  txCount = 0;
  private readonly queue: (readonly Row[])[];

  constructor(queue: (readonly Row[])[] = []) {
    this.queue = [...queue];
  }

  private answer(): Promise<readonly Row[]> {
    return Promise.resolve(this.queue.shift() ?? []);
  }

  private track(call: RecordedCall): RecordedCall {
    this.calls.push(call);
    return call;
  }

  selectFrom(table: string): KyselySelectBuilder {
    const call = this.track({ kind: 'select', table, wheres: [] });
    const builder: KyselySelectBuilder = {
      selectAll: () => builder,
      where: (column, operator, value) => {
        call.wheres.push([column, operator, value]);
        return builder;
      },
      orderBy: (column, direction) => {
        call.orderBy = [column, direction];
        return builder;
      },
      limit: (limit) => {
        call.limit = limit;
        return builder;
      },
      execute: () => this.answer(),
    };
    return builder;
  }

  insertInto(table: string): KyselyInsertBuilder {
    const call = this.track({ kind: 'insert', table, wheres: [] });
    const returning: KyselyReturningExecutable = { execute: () => this.answer() };
    const valuesBuilder: KyselyInsertValuesBuilder = {
      returningAll: () => returning,
      execute: () => this.answer(),
    };
    return {
      values: (row) => {
        call.values = row;
        return valuesBuilder;
      },
    };
  }

  updateTable(table: string): KyselyUpdateBuilder {
    const call = this.track({ kind: 'update', table, wheres: [] });
    const returning: KyselyReturningExecutable = { execute: () => this.answer() };
    const setBuilder: KyselyUpdateSetBuilder = {
      where: (column, operator, value) => {
        call.wheres.push([column, operator, value]);
        return setBuilder;
      },
      returningAll: () => returning,
    };
    return {
      set: (patch) => {
        call.set = patch;
        return setBuilder;
      },
    };
  }

  deleteFrom(table: string): KyselyDeleteBuilder {
    const call = this.track({ kind: 'delete', table, wheres: [] });
    const returning: KyselyReturningExecutable = { execute: () => this.answer() };
    const builder: KyselyDeleteBuilder = {
      where: (column, operator, value) => {
        call.wheres.push([column, operator, value]);
        return builder;
      },
      returningAll: () => returning,
    };
    return builder;
  }

  executeQuery(query: {
    readonly sql: string;
    readonly parameters: readonly unknown[];
  }): Promise<{ readonly rows: readonly Row[] }> {
    this.track({
      kind: 'raw',
      table: query.sql,
      values: { parameters: query.parameters },
      wheres: [],
    });
    return this.answer().then((rows) => ({ rows }));
  }

  transaction() {
    return {
      execute: <T>(fn: (trx: KyselyLike) => Promise<T>): Promise<T> => {
        this.txCount += 1;
        return fn(this);
      },
    };
  }
}

describe('kyselyDataSource', () => {
  it('exposes endpoint capabilities and ships ledger + outbox migrations', () => {
    const adapter = kyselyDataSource(new FakeKysely(), schema);
    expect(adapter.capabilities.transactions).toBe(true);
    expect(adapter.capabilities.outboxEvents).toBe(true);
    const names = adapter.migrations().map((m) => m.name);
    expect(names).toEqual([
      'ablo_idempotency',
      'ablo_idempotency_request_hash',
      'ablo_idempotency_permanent_retention',
      'ablo_outbox',
      'ablo_outbox_correlation',
    ]);
  });

  it('commits in one transaction: ledger reservation → insert → outbox → ledger completion', async () => {
    const db = new FakeKysely([
      [{ client_tx_id: 'corr1' }], // reservation acquired
      [{ id: 't1', title: 'A', operator_id: 'op1' }], // INSERT ... returningAll (snake_case from DB)
      [], // outbox insert
      [], // ledger response update
    ]);
    const adapter = kyselyDataSource(db, schema);

    const result = await adapter.commit({
      correlationId: 'corr1',
      operations: [
        {
          type: 'CREATE',
          model: 'task',
          id: 't1',
          input: { title: 'A', operatorId: 'op1' },
          transactionId: 'op1',
        },
      ],
    });

    // Rows handed back to Ablo are FIELD-keyed (camelCase), not raw DB columns.
    expect(result.rows).toEqual([{ id: 't1', title: 'A', operatorId: 'op1' }]);
    expect(db.txCount).toBe(1);
    expect(db.calls.map((c) => `${c.kind}:${c.table}`)).toEqual([
      'raw:INSERT INTO ablo_idempotency (client_tx_id, response, request_hash, expires_at)\n     VALUES ($1, $2::jsonb, $3, now() + $4::interval)\n     ON CONFLICT (client_tx_id) DO NOTHING\n     RETURNING client_tx_id',
      'insert:task',
      'insert:ablo_outbox',
      'raw:UPDATE ablo_idempotency\n        SET response = $2::jsonb\n      WHERE client_tx_id = $1',
    ]);
    expect(db.calls[0]?.table).toContain('ON CONFLICT (client_tx_id) DO NOTHING');
    // The ledger row is written with a bounded TTL, not 'infinity', so the
    // customer can prune it — the retention interval is the fourth bound param.
    const reserveParams = (db.calls[0]?.values as { parameters: readonly unknown[] }).parameters;
    expect(reserveParams).toHaveLength(4);
    expect(reserveParams[3]).toBe(SOURCE_IDEMPOTENCY_RETENTION);
    expect(db.calls.find((call) => call.table === 'ablo_outbox')?.values).toMatchObject({
      correlation_id: 'corr1',
      transaction_id: 'op1',
    });
    expect(db.calls.find((call) => call.table === 'ablo_outbox')?.values).not.toHaveProperty(
      'client_tx_id',
    );
  });

  it('emits the requested WAL echo inside the write transaction', async () => {
    const db = new FakeKysely([[{ client_tx_id: 'corr_echo_1' }], [{ id: 't1' }], [], [], []]);
    const adapter = kyselyDataSource(db, schema);

    await adapter.commit({
      correlationId: 'corr_echo_1',
      intentHash: 'a'.repeat(64),
      echo: { kind: 'postgres-wal', payload: 'echo-payload' },
      operations: [
        { type: 'CREATE', model: 'task', id: 't1', input: { title: 'A' } },
      ],
    });

    expect(db.txCount).toBe(1);
    expect(db.calls.at(-1)).toMatchObject({
      kind: 'raw',
      table: expect.stringContaining('pg_logical_emit_message') as unknown,
      values: { parameters: ['ablo', 'echo-payload'] },
    });
  });

  it('writes SNAKE_CASE columns so it composes with `ablo migrate`-provisioned tables', async () => {
    const db = new FakeKysely([[{ client_tx_id: 'corr1' }], [{ id: 't1' }], [], []]);
    const adapter = kyselyDataSource(db, schema);

    await adapter.commit({
      correlationId: 'corr1',
      operations: [
        {
          type: 'CREATE',
          model: 'task',
          id: 't1',
          input: { title: 'A', operatorId: 'op1', legacyName: 'L' },
        },
      ],
    });

    const insert = db.calls.find((c) => c.kind === 'insert' && c.table === 'task');
    expect(insert?.values).toBeDefined();
    const cols = Object.keys(insert!.values!);
    // Default rule: operatorId → operator_id. Explicit override: legacyName → display_label.
    expect(cols).toContain('operator_id');
    expect(cols).toContain('display_label');
    expect(cols).not.toContain('operatorId');
    expect(cols).not.toContain('legacyName');
  });

  it('ARCHIVE writes snake_case columns (incl. archived_at), mapped from camelCase input', async () => {
    const db = new FakeKysely([[{ client_tx_id: 'corr2' }], [{ id: 't1' }], [], []]);
    const adapter = kyselyDataSource(db, schema);

    await adapter.commit({
      correlationId: 'corr2',
      operations: [{ type: 'ARCHIVE', model: 'task', id: 't1', input: { operatorId: 'op2' } }],
    });

    const update = db.calls.find((c) => c.kind === 'update' && c.table === 'task');
    const cols = Object.keys(update?.set ?? {});
    expect(cols).toContain('operator_id');
    expect(cols).toContain('archived_at'); // lifecycle column, same casing as the provisioner
    expect(cols).not.toContain('archivedAt');
    expect(update?.wheres).toEqual([['id', '=', 't1']]);
  });

  it.each(['UPDATE', 'DELETE'] as const)(
    'rolls back a %s that matched no row before emitting correlation evidence',
    async (type) => {
      const db = new FakeKysely([[{ client_tx_id: `corr_missing_${type}` }], []]);
      const adapter = kyselyDataSource(db, schema);

      await expect(
        adapter.commit({
          correlationId: `corr_missing_${type}`,
          operations: [
            {
              type,
              model: 'task',
              id: 'missing',
              ...(type === 'UPDATE' ? { input: { title: 'never written' } } : {}),
            },
          ],
        }),
      ).rejects.toMatchObject({
        code: type === 'UPDATE' ? 'mutate_update_entity_not_found' : 'entity_not_found',
      });
      expect(
        db.calls.some(
          (call) =>
            call.kind === 'raw' &&
            String(call.table).includes('pg_logical_emit_message'),
        ),
      ).toBe(false);
    },
  );

  it('replays a cached response after losing the ledger reservation', async () => {
    const cachedRows = [{ id: 't1', title: 'A' }];
    const db = new FakeKysely([
      [], // ON CONFLICT: another identical transaction already committed
      [{ response: JSON.stringify(cachedRows), request_hash: 'b'.repeat(64) }],
    ]);
    const adapter = kyselyDataSource(db, schema);

    const result = await adapter.commit({
      correlationId: 'corr1',
      intentHash: 'b'.repeat(64),
      operations: [{ type: 'CREATE', model: 'task', id: 't1', input: { title: 'A' } }],
    });

    expect(result.rows).toEqual(cachedRows);
    expect(db.calls).toHaveLength(2); // reservation + cached response, no DML
  });

  it('fails closed when a source idempotency key is reused for changed intent', async () => {
    const db = new FakeKysely([
      [],
      [{ response: '[]', request_hash: 'a'.repeat(64) }],
    ]);
    const adapter = kyselyDataSource(db, schema);

    await expect(
      adapter.commit({
        correlationId: 'corr-reused',
        intentHash: 'b'.repeat(64),
        operations: [
          {
            type: 'UPDATE',
            model: 'task',
            id: 't1',
            input: { title: 'changed' },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(db.calls).toHaveLength(2);
  });

  it('reads map columns back to fields and scope the lookup by id', async () => {
    const db = new FakeKysely([[{ id: 't1', title: 'A', display_label: 'L' }]]);
    const adapter = kyselyDataSource(db, schema);

    const rows = await adapter.read({ kind: 'load', model: 'task', id: 't1' });
    expect(rows).toEqual([{ id: 't1', title: 'A', legacyName: 'L' }]);
    const call = db.calls[0];
    if (!call) throw new Error('expected a recorded select call');
    expect(call.wheres).toEqual([['id', '=', 't1']]);
    expect(call.limit).toBe(1);
  });

  it('pages the outbox by cursor with stable ordering', async () => {
    const db = new FakeKysely([
      [
        {
          cursor: '7',
          id: 'tx1:0',
          model: 'task',
          entity_id: 't1',
          type: 'CREATE',
          data: JSON.stringify({ id: 't1', title: 'A' }),
          organization_id: null,
          client_tx_id: 'tx1',
          correlation_id: 'corr1',
          transaction_id: 'op1',
          occurred_at: 1700000000000,
        },
      ],
    ]);
    const adapter = kyselyDataSource(db, schema);

    const page = await adapter.events('5', 100);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]?.entityId).toBe('t1');
    expect(page.events[0]?.correlationId).toBe('corr1');
    expect(page.events[0]?.transactionId).toBe('op1');
    expect(page.nextCursor).toBe('7');
    const call = db.calls[0];
    if (!call) throw new Error('expected a recorded select call');
    expect(call.wheres).toEqual([['cursor', '>', '5']]);
    expect(call.orderBy).toEqual(['cursor', 'asc']);
  });

  it('exports one reusable field/column core for both wrappers', async () => {
    const db = new FakeKysely([[{ id: 't1', operator_id: 'op1', display_label: 'L' }]]);
    const core = createKyselyMutationCore(db, schema);

    await expect(
      core.read({ kind: 'load', model: 'task', id: 't1' }),
    ).resolves.toEqual([{ id: 't1', operatorId: 'op1', legacyName: 'L' }]);
  });

  it('direct mutation requires a logical marker and never writes or migrates an outbox', async () => {
    const db = new FakeKysely([
      [{ client_tx_id: 'corr_direct' }],
      [{ id: 't1', operator_id: 'op1' }],
      [],
      [],
    ]);
    const direct = kyselyDirectMutation(db, schema);

    expect(direct.capabilities.outboxEvents).toBe(false);
    expect(direct.migrations().map((migration) => migration.name)).toEqual([
      'ablo_idempotency',
      'ablo_idempotency_request_hash',
      'ablo_idempotency_permanent_retention',
    ]);
    await expect(
      direct.commit({
        correlationId: 'corr_missing_marker',
        operations: [{ type: 'CREATE', model: 'task', id: 'missing', input: {} }],
      }),
    ).rejects.toMatchObject({ code: 'source_adapter_misconfigured' });

    const result = await direct.commit({
      correlationId: 'corr_direct',
      intentHash: 'c'.repeat(64),
      echo: {
        kind: 'postgres-wal',
        payload: JSON.stringify({
          version: 1,
          correlationId: 'corr_direct',
          operations: [
            {
              model: 'task',
              id: 't1',
              action: 'I',
              transactionId: 'op_direct',
            },
          ],
        }),
      },
      operations: [
        {
          type: 'CREATE',
          model: 'task',
          id: 't1',
          input: { operatorId: 'op1' },
          transactionId: 'op_direct',
        },
      ],
    });

    expect(result.rows).toEqual([{ id: 't1', operatorId: 'op1' }]);
    expect(db.calls.some((call) => call.table === 'ablo_outbox')).toBe(false);
    expect(db.calls.at(-1)).toMatchObject({
      kind: 'raw',
      table: expect.stringContaining('pg_logical_emit_message') as unknown,
      values: {
        parameters: [
          'ablo',
          expect.stringContaining('"correlationId":"corr_direct"') as unknown,
        ],
      },
    });
  });

  it('direct marker validation speaks the schema typename when it diverges from the wire key', async () => {
    // The conventional production shape: PascalCase typename over a
    // lowercase wire key. The marker (and the trusted intent it mirrors)
    // carry the typename; the mutation operations carry the wire key; the
    // adapter translates through the schema when comparing the two.
    const typedSchema = defineSchema({
      collaborationWorkItems: model(
        { title: field.string() },
        { typename: 'CollaborationWorkItem', tableName: 'collaboration_work_items' }),
    });

    const db = new FakeKysely([
      [{ client_tx_id: 'corr_typename' }],
      [{ id: 'd1', title: 'T' }],
      [],
      [],
    ]);
    const direct = kyselyDirectMutation(db, typedSchema);
    const result = await direct.commit({
      correlationId: 'corr_typename',
      intentHash: 'd'.repeat(64),
      echo: {
        kind: 'postgres-wal',
        payload: JSON.stringify({
          version: 1,
          correlationId: 'corr_typename',
          operations: [
            {
              model: 'CollaborationWorkItem',
              id: 'd1',
              action: 'I',
              transactionId: 'op_typename',
            },
          ],
        }),
      },
      operations: [
        {
          type: 'CREATE',
          // The client wire path lowercases camelCase schema resource keys.
          model: 'collaborationworkitems',
          id: 'd1',
          input: { title: 'T' },
          transactionId: 'op_typename',
        },
      ],
    });
    expect(result.rows).toEqual([{ id: 'd1', title: 'T' }]);

    // Once the vocabularies diverge, a marker keyed by the wire key is a
    // mismatch: it would never correlate on the WAL side.
    const rejecting = kyselyDirectMutation(new FakeKysely(), typedSchema);
    await expect(
      rejecting.commit({
        correlationId: 'corr_wirekey',
        intentHash: 'e'.repeat(64),
        echo: {
          kind: 'postgres-wal',
          payload: JSON.stringify({
            version: 1,
            correlationId: 'corr_wirekey',
            operations: [
              {
                model: 'collaborationworkitems',
                id: 'd1',
                action: 'I',
                transactionId: 'op_wirekey',
              },
            ],
          }),
        },
        operations: [
          {
            type: 'CREATE',
            model: 'collaborationworkitems',
            id: 'd1',
            input: { title: 'T' },
            transactionId: 'op_wirekey',
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'source_adapter_misconfigured' });
  });
});
