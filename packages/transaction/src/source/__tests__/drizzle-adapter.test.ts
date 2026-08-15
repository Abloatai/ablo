/**
 * drizzleDataSource flow test — exercises the adapter's real SQL-generation +
 * transaction/idempotency/outbox sequencing against a recording fake
 * `DrizzleLike`, and PROVES the schema-driven field→column casing: the adapter
 * writes snake_case columns (matching `ablo migrate` / `generateProvisionPlan`)
 * and maps DB rows back to camelCase fields. Generated SQL is rendered with the
 * real `PgDialect` so the column names asserted here are the ones that actually
 * hit Postgres. Full conformance against a live DB (or pglite) is the deferred
 * integration step.
 */

import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { defineSchema } from '@abloatai/transaction/schema/schema';
import { model } from '@abloatai/transaction/schema/model';
import { field } from '@abloatai/transaction/schema/field';
import { drizzleDataSource, type DrizzleLike, type DrizzleExecuteResult } from '../adapters/drizzle.js';

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

/** Render an `sql`` object to its final parametrized SQL text (real dialect). */
const dialect = new PgDialect();
const renderSql = (query: SQL): string => dialect.sqlToQuery(query).sql;

class FakeDrizzle implements DrizzleLike {
  executeCalls = 0;
  txCount = 0;
  readonly sqls: string[] = [];
  private readonly queue: DrizzleExecuteResult[];
  constructor(queue: DrizzleExecuteResult[] = []) {
    this.queue = [...queue];
  }
  async execute(query: SQL): Promise<DrizzleExecuteResult> {
    this.executeCalls += 1;
    this.sqls.push(renderSql(query));
    return this.queue.shift() ?? [];
  }
  async transaction<T>(fn: (tx: DrizzleLike) => Promise<T>): Promise<T> {
    this.txCount += 1;
    return fn(this);
  }
}

describe('drizzleDataSource', () => {
  it('exposes endpoint capabilities and ships ledger + outbox migrations', () => {
    const adapter = drizzleDataSource(new FakeDrizzle(), schema);
    expect(adapter.capabilities.transactions).toBe(true);
    const names = adapter.migrations().map((m) => m.name);
    expect(names).toEqual([
      'ablo_idempotency',
      'ablo_idempotency_request_hash',
      'ablo_idempotency_permanent_retention',
      'ablo_outbox',
      'ablo_outbox_correlation',
    ]);
  });

  it('commits in one transaction: idempotency check → insert → outbox → idempotency record', async () => {
    const db = new FakeDrizzle([
      [], // idempotency check → miss
      [{ id: 't1', title: 'A', operator_id: 'op1' }], // INSERT ... RETURNING * (snake_case from DB)
      [], // outbox insert
      [], // idempotency insert
    ]);
    const adapter = drizzleDataSource(db, schema);

    const result = await adapter.commit({
      correlationId: 'corr1',
      operations: [{ type: 'CREATE', model: 'item', id: 't1', input: { title: 'A', operatorId: 'op1' } }],
    });

    // Rows handed back to Ablo are FIELD-keyed (camelCase), not the raw DB columns.
    expect(result.rows).toEqual([{ id: 't1', title: 'A', operatorId: 'op1' }]);
    expect(db.txCount).toBe(1); // ran inside ONE transaction
    expect(db.executeCalls).toBe(4); // check + insert + outbox + idempotency
  });

  it('emits the requested WAL echo inside the write transaction', async () => {
    const db = new FakeDrizzle([[], [{ id: 't1' }], [], [], []]);
    const adapter = drizzleDataSource(db, schema);

    await adapter.commit({
      correlationId: 'corr_echo_1',
      intentHash: 'a'.repeat(64),
      echo: { kind: 'postgres-wal', payload: 'echo-payload' },
      operations: [
        { type: 'CREATE', model: 'item', id: 't1', input: { title: 'A' } },
      ],
    });

    expect(db.txCount).toBe(1);
    expect(db.sqls.at(-1)).toContain('pg_logical_emit_message');
    expect(db.executeCalls).toBe(5);
  });

  it('writes SNAKE_CASE columns so it composes with `ablo migrate`-provisioned tables', async () => {
    const db = new FakeDrizzle([[], [{ id: 't1' }], [], []]);
    const adapter = drizzleDataSource(db, schema);

    await adapter.commit({
      correlationId: 'corr1',
      operations: [
        { type: 'CREATE', model: 'item', id: 't1', input: { title: 'A', operatorId: 'op1', legacyName: 'L' } },
      ],
    });

    const insert = db.sqls.find((s) => s.startsWith('INSERT INTO "item"'));
    expect(insert).toBeDefined();
    // Default rule: operatorId → operator_id. Explicit override: legacyName → display_label.
    expect(insert).toContain('"operator_id"');
    expect(insert).toContain('"display_label"');
    expect(insert).not.toContain('"operatorId"');
    expect(insert).not.toContain('"legacyName"');
  });

  it('UPDATE/ARCHIVE write snake_case columns (incl. archived_at), mapped from camelCase input', async () => {
    const db = new FakeDrizzle([[], [{ id: 't1' }], [], []]);
    const adapter = drizzleDataSource(db, schema);

    await adapter.commit({
      correlationId: 'corr2',
      operations: [{ type: 'ARCHIVE', model: 'item', id: 't1', input: { operatorId: 'op2' } }],
    });

    const update = db.sqls.find((s) => s.startsWith('UPDATE "item"'));
    expect(update).toBeDefined();
    expect(update).toContain('"operator_id"');
    expect(update).toContain('"archived_at"'); // lifecycle column, same casing as the provisioner
    expect(update).not.toContain('"archivedAt"');
  });

  it('replays the cached response on a duplicate scoped correlation', async () => {
    const cachedRows = [{ id: 't1', title: 'A' }];
    const db = new FakeDrizzle([
      { rows: [{ response: cachedRows, requestHash: 'b'.repeat(64) }] },
    ]); // {rows} driver shape
    const adapter = drizzleDataSource(db, schema);

    const result = await adapter.commit({
      correlationId: 'corr1',
      intentHash: 'b'.repeat(64),
      operations: [{ type: 'CREATE', model: 'item', id: 't1', input: { title: 'A' } }],
    });

    expect(result.rows).toEqual(cachedRows);
    expect(db.executeCalls).toBe(1); // ONLY the idempotency check — no re-apply
  });

  it('reads a row via load and maps snake_case columns back to camelCase fields', async () => {
    const db = new FakeDrizzle([[{ id: 't1', title: 'A', operator_id: 'op1', display_label: 'L' }]]);
    const adapter = drizzleDataSource(db, schema);
    const rows = await adapter.read({ kind: 'load', model: 'item', id: 't1' });
    // operator_id → operatorId (default), display_label → legacyName (override).
    expect(rows[0]).toEqual({ id: 't1', title: 'A', operatorId: 'op1', legacyName: 'L' });
  });

  it('maps outbox rows (snake_case columns + driver {rows}) to events with a cursor', async () => {
    const db = new FakeDrizzle([
      {
        rows: [
          {
            cursor: 1,
            id: 'tx1:0',
            model: 'item',
            entity_id: 't1',
            type: 'CREATE',
            data: { id: 't1', title: 'A' },
            organization_id: null,
            client_tx_id: null,
            correlation_id: 'corr1',
            transaction_id: 'op1',
            occurred_at: 1717000000000,
          },
        ],
      },
    ]);
    const adapter = drizzleDataSource(db, schema);
    const page = await adapter.events(null, 100);
    expect(page.events[0]).toMatchObject({
      id: 'tx1:0',
      entityId: 't1',
      model: 'item',
      type: 'CREATE',
      correlationId: 'corr1',
      transactionId: 'op1',
      cursor: '1',
    });
    expect(page.nextCursor).toBe('1');
  });

  it('throws for a model not in the schema (no silent wrong-table write)', async () => {
    const adapter = drizzleDataSource(new FakeDrizzle(), schema);
    await expect(
      adapter.commit({ correlationId: 'corr1', operations: [{ type: 'CREATE', model: 'ghost', id: 'g1', input: {} }] }),
    ).rejects.toThrow(/no model "ghost" in schema/);
  });
});
