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
  item: model({
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
  forUpdate?: boolean;
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
      forUpdate: () => {
        call.forUpdate = true;
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

/**
 * The prefix + payload of the WAL echo marker, read off the commit's closing
 * statement. The ledger completion and the marker are sent as ONE statement
 * (`completeLedgerWithMarkerQuery`) so a cross-region write does not pay two
 * round trips, so the marker's arguments are the statement's LAST two — reading
 * them by position from the front would pin the test to that packing.
 */
function emittedMarker(call: { values?: { parameters?: unknown } } | undefined): unknown[] {
  const parameters = (call?.values as { parameters?: unknown[] } | undefined)?.parameters ?? [];
  return parameters.slice(-2);
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
      'ablo_outbox_sync_groups',
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
          model: 'item',
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
      'insert:item',
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
        { type: 'CREATE', model: 'item', id: 't1', input: { title: 'A' } },
      ],
    });

    expect(db.txCount).toBe(1);
    expect(db.calls.at(-1)).toMatchObject({
      kind: 'raw',
      table: expect.stringContaining('pg_logical_emit_message') as unknown,
    });
    expect(emittedMarker(db.calls.at(-1))).toEqual(['ablo', 'echo-payload']);
  });

  it('keeps the marker operation id authoritative when CREATE input repeats id', async () => {
    const db = new FakeKysely([[{ client_tx_id: 'corr_id' }], [{ id: 'trusted-id' }], [], []]);
    const adapter = kyselyDataSource(db, schema);

    await adapter.commit({
      correlationId: 'corr_id',
      operations: [
        {
          type: 'CREATE',
          model: 'item',
          id: 'trusted-id',
          input: { id: 'different-input-id', title: 'A' },
        },
      ],
    });

    expect(db.calls.find((call) => call.kind === 'insert' && call.table === 'item')?.values)
      .toMatchObject({ id: 'trusted-id', title: 'A' });
  });

  it('writes SNAKE_CASE columns so it composes with `ablo migrate`-provisioned tables', async () => {
    const db = new FakeKysely([[{ client_tx_id: 'corr1' }], [{ id: 't1' }], [], []]);
    const adapter = kyselyDataSource(db, schema);

    await adapter.commit({
      correlationId: 'corr1',
      operations: [
        {
          type: 'CREATE',
          model: 'item',
          id: 't1',
          input: { title: 'A', operatorId: 'op1', legacyName: 'L' },
        },
      ],
    });

    const insert = db.calls.find((c) => c.kind === 'insert' && c.table === 'item');
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
      operations: [{ type: 'ARCHIVE', model: 'item', id: 't1', input: { operatorId: 'op2' } }],
    });

    const update = db.calls.find((c) => c.kind === 'update' && c.table === 'item');
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
              model: 'item',
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
      operations: [{ type: 'CREATE', model: 'item', id: 't1', input: { title: 'A' } }],
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
            model: 'item',
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

    const rows = await adapter.read({ kind: 'load', model: 'item', id: 't1' });
    expect(rows).toEqual([{ id: 't1', title: 'A', legacyName: 'L' }]);
    const call = db.calls[0];
    if (!call) throw new Error('expected a recorded select call');
    expect(call.wheres).toEqual([['id', '=', 't1']]);
    expect(call.limit).toBe(1);
  });

  it('applies the subject predicate before the database limit', async () => {
    const subjectSchema = defineSchema({
      item: model(
        { title: field.string(), workspaceId: field.string().min(1) },
        { subject: { field: 'workspaceId', group: 'workspace' } },
      ),
    });
    const db = new FakeKysely([[{ id: 'own', title: 'A', workspace_id: 'a' }]]);
    const adapter = kyselyDataSource(db, subjectSchema);
    await adapter.read({
      kind: 'list', model: 'item', query: { limit: 1 },
      scope: { syncGroups: ['workspace:a'] },
    });
    expect(db.calls[0]?.wheres).toContainEqual(['workspace_id', 'in', ['a']]);
    expect(db.calls[0]?.limit).toBe(1);
  });

  it('locks the subject preimage before mutating it', async () => {
    const subjectSchema = defineSchema({
      item: model(
        { title: field.string(), workspaceId: field.string().min(1) },
        { subject: { field: 'workspaceId', group: 'workspace' } },
      ),
    });
    const db = new FakeKysely([
      [{ client_tx_id: 'subject-lock' }],
      [{ id: 'own', title: 'before', workspace_id: 'a' }],
      [{ id: 'own', title: 'after', workspace_id: 'a' }],
      [],
      [],
    ]);
    const adapter = kyselyDataSource(db, subjectSchema);
    await adapter.commit({
      correlationId: 'subject-lock',
      scope: { syncGroups: ['workspace:a'] },
      operations: [{ type: 'UPDATE', model: 'item', id: 'own', input: { title: 'after' } }],
    });
    expect(db.calls.find((call) => call.kind === 'select' && call.table === 'item'))
      .toMatchObject({ forUpdate: true });
  });

  it('takes an absent-key advisory lock before authorizing subject CREATE', async () => {
    const subjectSchema = defineSchema({
      item: model(
        { title: field.string(), workspaceId: field.string().min(1) },
        { subject: { field: 'workspaceId', group: 'workspace' } },
      ),
    });
    const db = new FakeKysely([
      [{ client_tx_id: 'subject-create-lock' }],
      [], [],
      [{ id: 'new', title: 'created', workspace_id: 'a' }],
      [], [],
    ]);
    await kyselyDataSource(db, subjectSchema).commit({
      correlationId: 'subject-create-lock',
      scope: { syncGroups: ['workspace:a'] },
      operations: [{ type: 'CREATE', model: 'item', id: 'new', input: { title: 'created', workspaceId: 'a' } }],
    });
    const advisory = db.calls.findIndex((call) =>
      call.kind === 'raw' && call.table.includes('pg_advisory_xact_lock'));
    const preimage = db.calls.findIndex((call) => call.kind === 'select' && call.table === 'item');
    expect(advisory).toBeGreaterThan(-1);
    expect(advisory).toBeLessThan(preimage);
  });

  it('pages the outbox by cursor with stable ordering', async () => {
    const db = new FakeKysely([
      [
        {
          cursor: '7',
          id: 'tx1:0',
          model: 'item',
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
      core.read({ kind: 'load', model: 'item', id: 't1' }),
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
        operations: [{ type: 'CREATE', model: 'item', id: 'missing', input: {} }],
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
              model: 'item',
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
          model: 'item',
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
    });
    expect(emittedMarker(db.calls.at(-1))).toEqual([
      'ablo',
      expect.stringContaining('"correlationId":"corr_direct"') as unknown,
    ]);
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

  it('resolves a database-generated id from the returned row before emitting the marker', async () => {
    const eventSchema = defineSchema({
      recordEvents: model(
        { recordId: field.string() },
        {
          typename: 'RecordEvent',
          tableName: 'record_events',
        },
      ),
    });
    const db = new FakeKysely([
      [{ client_tx_id: 'corr_generated' }],
      [{ id: 42n, record_id: 'record-1' }],
      [],
      [],
    ]);
    const direct = kyselyDirectMutation(db, eventSchema);

    const result = await direct.commit({
      correlationId: 'corr_generated',
      intentHash: 'f'.repeat(64),
      echo: {
        kind: 'postgres-wal',
        payload: JSON.stringify({
          version: 1,
          correlationId: 'corr_generated',
          operations: [
            {
              model: 'RecordEvent',
              action: 'I',
              transactionId: 'record-event',
            },
          ],
        }),
      },
      operations: [
        {
          type: 'CREATE',
          model: 'recordevents',
          input: { id: '999', recordId: 'record-1' },
          transactionId: 'record-event',
        },
      ],
    });

    expect(result.rows).toEqual([{ id: '42', recordId: 'record-1' }]);
    const insert = db.calls.find((call) => call.table === 'record_events');
    expect(insert?.values).toEqual({ record_id: 'record-1' });
    expect(emittedMarker(db.calls.at(-1))).toEqual([
      'ablo',
      expect.stringContaining('"id":"42"'),
    ]);
  });

  it('rejects an atomic commit when a database condition does not match', async () => {
    const db = new FakeKysely([
      [{ client_tx_id: 'corr_condition' }],
      [],
    ]);
    const adapter = kyselyDataSource(db, schema);

    await expect(
      adapter.commit({
        correlationId: 'corr_condition',
        operations: [
          {
            type: 'UPDATE',
            model: 'item',
            id: 't1',
            input: { title: 'Next' },
            where: { legacyName: 'Current' },
            transactionId: 'item-transition',
          },
          {
            type: 'CREATE',
            model: 'item',
            id: 'event-1',
            input: { title: 'must not run' },
            transactionId: 'item-event',
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'precondition_failed' });

    const update = db.calls.find((call) => call.kind === 'update');
    expect(update?.wheres).toEqual([
      ['id', '=', 't1'],
      ['display_label', '=', 'Current'],
    ]);
    expect(db.calls.some((call) => call.table === 'ablo_outbox')).toBe(false);
    expect(db.calls.some((call) => call.values?.title === 'must not run')).toBe(false);
  });

  it('preserves the QM transition and event contract in one database transaction', async () => {
    const qmSchema = defineSchema({
      tasks: model(
        {
          status: field.string(),
          createdAt: field.number().from('created_at'),
          updatedAt: field.number().from('updated_at'),
        },
        { tableName: 'tasks' },
      ),
      taskEvents: model(
        {
          taskId: field.string().from('task_id'),
          type: field.string(),
          createdAt: field.number().from('created_at'),
        },
        { tableName: 'task_events' },
      ),
    });
    const at = new Date('2026-08-14T12:34:56.789Z');
    const epoch = at.getTime();
    const db = new FakeKysely([
      [{ client_tx_id: 'qm-transition' }],
      [{ id: 'task-1', status: 'running', created_at: epoch, updated_at: epoch }],
      [],
      [{ id: '42', task_id: 'task-1', type: 'status_changed', created_at: epoch }],
      [],
      [],
    ]);
    const adapter = kyselyDataSource(db, qmSchema);

    const result = await adapter.commit({
      correlationId: 'qm-transition',
      operations: [
        {
          type: 'UPDATE',
          model: 'tasks',
          id: 'task-1',
          input: { status: 'running', updatedAt: epoch },
          where: { status: 'pending' },
          transactionId: 'task-transition',
        },
        {
          type: 'CREATE',
          model: 'taskevents',
          input: { taskId: 'task-1', type: 'status_changed', createdAt: epoch },
          transactionId: 'status-event',
        },
      ],
    });

    expect(db.txCount).toBe(1);
    expect(result.rows).toEqual([
      { id: 'task-1', status: 'running', createdAt: epoch, updatedAt: epoch },
      { id: '42', taskId: 'task-1', type: 'status_changed', createdAt: epoch },
    ]);
    expect(db.calls.find((call) => call.kind === 'update')).toMatchObject({
      table: 'tasks',
      set: { status: 'running', updated_at: epoch },
      wheres: [['id', '=', 'task-1'], ['status', '=', 'pending']],
    });
    expect(db.calls.find((call) => call.kind === 'insert' && call.table === 'task_events')?.values)
      .toEqual({ task_id: 'task-1', type: 'status_changed', created_at: epoch });
    expect(db.calls.filter((call) => call.table === 'ablo_outbox')).toHaveLength(2);
  });
});
