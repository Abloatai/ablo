/**
 * Drizzle Data Source adapter. Same adapter interface + conformance as `prismaDataSource`,
 * built against Drizzle's REAL API (read from drizzle-orm's own source/docs):
 *   - `db.transaction(async (tx) => …)` — interactive transaction (commit/rollback).
 *   - `db.execute(sql`…`)` — parametrized raw SQL; `sql.identifier()` safely quotes
 *     dynamic table/column names, `sql`${value}`` parametrizes values.
 *
 * SCHEMA-DRIVEN COLUMNS. Unlike Prisma — whose delegate applies the model's
 * `@map` for free — this adapter writes raw SQL, so it would otherwise bypass any
 * field→column translation. It therefore derives every table + column name from
 * the SAME rule the provisioner uses (`generateProvisionPlan`):
 *   table  = `model.tableName ?? key`
 *   column = `fieldMeta.column ?? camelToSnake(field)`   (+ the model's tenancy column)
 * so `ablo migrate` (which emits `operator_id`) and this adapter (which now writes
 * `operator_id`) COMPOSE. Define the schema once, point Ablo at your Postgres —
 * no hand-written parallel Drizzle table. The adapter is the translation boundary:
 * its public surface (rows in/out, outbox `data`) is field-keyed (the SDK shape);
 * the physical columns it reads/writes are snake_case.
 *
 * IMPORTANT GOTCHAS (from drizzle-orm docs):
 *   1. Interactive `db.transaction` requires a driver that supports it. Neon's
 *      `neon-http` driver does NOT (single-shot only) — use `neon-serverless`
 *      (WebSocket) or `pg`. With neon-http the commit path throws at runtime.
 *   2. `db.execute` result shape is driver-specific (postgres-js returns an
 *      array-like RowList; node-postgres returns `{ rows }`). `rowsOf()`
 *      normalizes both.
 *
 * We use `sql` + `db.execute` for ALL writes (not the fluent builder) so the
 * adapter is one small, fully-typed unit with no per-driver builder generics.
 */

import { sql, type SQL } from 'drizzle-orm';
import type {
  AdapterCommitResult,
  AdapterReadRequest,
  DataSourceAdapter,
  Row,
} from '../adapter.js';
import type { ChangeSet, EventsPage, Migration, Operation } from '../contract.js';
import { outboxEventSchema } from '../contract.js';
import { adapterTableMigrations } from '../migrations.js';
import type { Schema, SchemaRecord } from '../../schema/schema.js';
import { toSchemaJSON } from '../../schema/serialize.js';
import { camelToSnake, snakeToCamel } from '../../schema/ddl.js';
import { tenancyColumn } from '../../schema/tenancy.js';

/** The subset of a Drizzle database/transaction handle the adapter calls. */
export interface DrizzleLike {
  execute(query: SQL): Promise<DrizzleExecuteResult>;
  transaction<T>(fn: (tx: DrizzleLike) => Promise<T>): Promise<T>;
}

/** `db.execute` is array-like (postgres-js) or `{ rows }` (node-postgres). */
export type DrizzleExecuteResult = readonly Row[] | { readonly rows: readonly Row[] };

function rowsOf(result: DrizzleExecuteResult): readonly Row[] {
  return Array.isArray(result) ? result : (result as { readonly rows: readonly Row[] }).rows;
}

function rowId(op: Operation): string {
  const id = op.id ?? (op.input?.id as string | undefined);
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`operation on "${op.model}" requires an id`);
  }
  return id;
}

/** `col1, col2` as a safely-quoted identifier list. */
const identList = (cols: readonly string[]): SQL =>
  sql.join(cols.map((c) => sql.identifier(c)), sql`, `);

/**
 * Per-model name resolution, precomputed once from the schema. `table` is the
 * physical table; the override maps hold ONLY the cases where the column name
 * diverges from `camelToSnake(field)` (an explicit `field.from('…')` or a custom
 * tenancy column) — every other field falls back to the pure casing rule, so the
 * maps stay tiny and the reverse (`snakeToCamel`) inverts the common case.
 */
interface ModelColumns {
  readonly table: string;
  readonly fieldToColumn: ReadonlyMap<string, string>;
  readonly columnToField: ReadonlyMap<string, string>;
}

function buildColumnMaps(schema: Schema<SchemaRecord>): ReadonlyMap<string, ModelColumns> {
  const json = toSchemaJSON(schema);
  const out = new Map<string, ModelColumns>();
  for (const [key, model] of Object.entries(json.models)) {
    const fieldToColumn = new Map<string, string>();
    const columnToField = new Map<string, string>();
    const register = (field: string, column: string): void => {
      // The default rule already covers `camelToSnake(field)`; only record real
      // divergences so the reverse map never shadows a clean round-trip.
      if (column === camelToSnake(field)) return;
      fieldToColumn.set(field, column);
      columnToField.set(column, field);
    };
    for (const [field, meta] of Object.entries(model.fields)) {
      if (meta.column) register(field, meta.column);
    }
    const orgColumn = tenancyColumn(model.tenancy);
    if (orgColumn) register('organizationId', orgColumn);
    out.set(key, { table: model.tableName ?? key, fieldToColumn, columnToField });
  }
  return out;
}

export function drizzleDataSource<S extends SchemaRecord>(
  db: DrizzleLike,
  schema: Schema<S>,
): DataSourceAdapter {
  const maps = buildColumnMaps(schema);
  const modelColumns = (model: string): ModelColumns => {
    const mc = maps.get(model);
    if (!mc) throw new Error(`drizzleDataSource: no model "${model}" in schema`);
    return mc;
  };

  const columnFor = (mc: ModelColumns, field: string): string =>
    mc.fieldToColumn.get(field) ?? camelToSnake(field);
  const fieldFor = (mc: ModelColumns, column: string): string =>
    mc.columnToField.get(column) ?? snakeToCamel(column);

  /** Field-keyed (SDK shape) → column-keyed (physical), for INSERT/UPDATE. */
  const toColumns = (mc: ModelColumns, row: Row): Row => {
    const out: Row = {};
    for (const k of Object.keys(row)) out[columnFor(mc, k)] = row[k];
    return out;
  };
  /** Column-keyed (RETURNING * / SELECT *) → field-keyed (SDK shape), for reads + results. */
  const toFields = (mc: ModelColumns, row: Row): Row => {
    const out: Row = {};
    for (const k of Object.keys(row)) out[fieldFor(mc, k)] = row[k];
    return out;
  };

  const applyOperation = async (tx: DrizzleLike, op: Operation): Promise<Row> => {
    const mc = modelColumns(op.model);
    const table = sql.identifier(mc.table);
    const id = rowId(op);
    const input = op.input ?? {};

    if (op.type === 'DELETE') {
      const deleted = rowsOf(await tx.execute(sql`DELETE FROM ${table} WHERE id = ${id} RETURNING *`));
      return deleted[0] ? toFields(mc, deleted[0]) : { id };
    }

    if (op.type === 'CREATE') {
      const data = toColumns(mc, { id, ...input });
      const cols = Object.keys(data);
      const values = sql.join(cols.map((c) => sql`${data[c]}`), sql`, `);
      const inserted = rowsOf(
        await tx.execute(sql`INSERT INTO ${table} (${identList(cols)}) VALUES (${values}) RETURNING *`),
      );
      return inserted[0] ? toFields(mc, inserted[0]) : { id, ...input };
    }

    // UPDATE / ARCHIVE / UNARCHIVE — a SET clause + the lifecycle field. The
    // lifecycle field is `archivedAt` (camelCase) and goes through `toColumns`
    // like any other, so it lands in `archived_at` — same column the provisioner
    // emits and the Prisma adapter writes (no per-adapter casing divergence).
    const patch = toColumns(mc, {
      ...input,
      ...(op.type === 'ARCHIVE' ? { archivedAt: new Date() } : {}),
      ...(op.type === 'UNARCHIVE' ? { archivedAt: null } : {}),
    });
    const assignments = sql.join(
      Object.keys(patch).map((c) => sql`${sql.identifier(c)} = ${patch[c]}`),
      sql`, `,
    );
    const updated = rowsOf(
      await tx.execute(sql`UPDATE ${table} SET ${assignments} WHERE id = ${id} RETURNING *`),
    );
    return updated[0] ? toFields(mc, updated[0]) : { id, ...input };
  };

  return {
    capabilities: { transactions: true, propose: false, schemaIntrospection: true },

    migrations(): readonly Migration[] {
      return adapterTableMigrations();
    },

    async read(req: AdapterReadRequest): Promise<readonly Row[]> {
      const mc = modelColumns(req.model);
      const table = sql.identifier(mc.table);
      if (req.kind === 'load') {
        const rows = rowsOf(await db.execute(sql`SELECT * FROM ${table} WHERE id = ${req.id} LIMIT 1`));
        return rows.map((r) => toFields(mc, r));
      }
      const limit = req.query?.limit ?? 1000;
      const rows = rowsOf(await db.execute(sql`SELECT * FROM ${table} LIMIT ${limit}`));
      return rows.map((r) => toFields(mc, r));
    },

    async commit(change: ChangeSet): Promise<AdapterCommitResult> {
      return db.transaction(async (tx) => {
        const cached = rowsOf(
          await tx.execute(
            sql`SELECT response FROM ablo_idempotency WHERE client_tx_id = ${change.clientTxId} LIMIT 1`,
          ),
        );
        if (cached.length > 0) return { rows: cached[0].response as Row[] };

        const rows: Row[] = [];
        for (const [index, op] of change.operations.entries()) {
          const row = await applyOperation(tx, op);
          rows.push(row);
          const entityId = String(row.id ?? rowId(op));
          await tx.execute(sql`
            INSERT INTO ablo_outbox (id, model, entity_id, type, data, client_tx_id, occurred_at)
            VALUES (
              ${`${change.clientTxId}:${index}`}, ${op.model}, ${entityId}, ${op.type},
              ${op.type === 'DELETE' ? null : JSON.stringify(row)}::jsonb, ${change.clientTxId}, ${Date.now()}
            )`);
        }

        await tx.execute(sql`
          INSERT INTO ablo_idempotency (client_tx_id, response)
          VALUES (${change.clientTxId}, ${JSON.stringify(rows)}::jsonb)`);
        return { rows };
      });
    },

    async events(cursor: string | null, limit: number): Promise<EventsPage> {
      const after = cursor ?? '0';
      const rows = rowsOf(
        await db.execute(sql`
          SELECT cursor, id, model, entity_id, type, data, organization_id, client_tx_id, occurred_at
          FROM ablo_outbox WHERE cursor > ${after} ORDER BY cursor ASC LIMIT ${limit}`),
      );
      const events = rows.map((r) =>
        outboxEventSchema.parse({
          id: r.id,
          model: r.model,
          entityId: r.entity_id,
          type: r.type,
          data: r.data ?? null,
          organizationId: r.organization_id ?? null,
          clientTxId: r.client_tx_id ?? null,
          occurredAt: r.occurred_at != null ? Number(r.occurred_at) : null,
          cursor: String(r.cursor),
        }),
      );
      return { events, nextCursor: events.length > 0 ? events[events.length - 1].cursor : null };
    },
  };
}
