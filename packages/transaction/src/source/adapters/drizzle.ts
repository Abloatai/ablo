/**
 * The Drizzle adapter for the data-source interface. It implements the same
 * {@link DataSourceAdapter} contract as {@link prismaDataSource} and passes the
 * same conformance suite, built against Drizzle's query API:
 *   - `db.transaction(async (tx) => …)` runs an interactive transaction that
 *     commits or rolls back as a unit.
 *   - `db.execute(sql`…`)` runs parameterized raw SQL; `sql.identifier()` safely
 *     quotes dynamic table and column names, and `sql`${value}`` parameterizes
 *     values.
 *
 * Table and column names come from your schema, not from a hand-written Drizzle
 * table. Because this adapter issues raw SQL, it would otherwise bypass any
 * field-to-column translation, so it derives every name from the same rule the
 * table provisioner uses:
 *   table  = `model.tableName ?? key`
 *   column = `fieldMeta.column ?? camelToSnake(field)`   (plus the tenancy column)
 * This keeps the tables `ablo migrate` creates (for example `operator_id`) and the
 * columns this adapter reads and writes in agreement. You define the schema once
 * and point the engine at your Postgres database. The adapter is the translation
 * boundary: the rows it accepts and returns, and the outbox `data` it writes, are
 * keyed by field name, while the physical columns it touches are snake_case.
 *
 * Two things to know about drivers:
 *   1. Interactive `db.transaction` needs a driver that supports it. Neon's
 *      `neon-http` driver is single-shot and does not, so use `neon-serverless`
 *      (over WebSocket) or `pg`; under `neon-http` the commit path throws at
 *      runtime.
 *   2. The `db.execute` result shape is driver-specific — `postgres-js` returns an
 *      array-like row list, while `node-postgres` returns `{ rows }`. `rowsOf`
 *      normalizes both.
 *
 * Every write goes through `sql` and `db.execute` rather than the fluent builder,
 * which keeps the adapter one small, fully typed unit with no per-driver builder
 * generics.
 */

import { AbloValidationError } from '../../errors.js';
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
import {
  assertSourceIdempotencyIntent,
  assertSourceIdempotencyRetention,
  SOURCE_IDEMPOTENCY_RETENTION,
  sourceChangeIntentHash,
} from '../idempotency.js';
import type { Schema, SchemaRecord } from '../../schema/schema.js';
import { toSchemaJSON } from '../../schema/serialize.js';
import { camelToSnake, snakeToCamel } from '../../schema/ddl.js';
import { tenancyColumn } from '../../schema/tenancy.js';
import { ABLO_POSTGRES_COMMIT_ECHO_PREFIX } from '../types.js';

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
    throw new AbloValidationError(`operation on "${op.model}" requires an id`, { code: 'source_operation_id_required' });
  }
  return id;
}

/** `col1, col2` as a safely-quoted identifier list. */
const identList = (cols: readonly string[]): SQL =>
  sql.join(cols.map((c) => sql.identifier(c)), sql`, `);

/**
 * Per-model name resolution, computed once from the schema. `table` is the physical
 * table name. The override maps record only the fields whose column name diverges
 * from `camelToSnake(field)` — an explicit `field.from('…')` or a custom tenancy
 * column — while every other field falls back to the plain casing rule. Keeping
 * only the exceptions makes the maps small and lets the reverse direction
 * (`snakeToCamel`) invert the common case without a lookup.
 */
interface ModelColumns {
  readonly table: string;
  readonly fieldToColumn: ReadonlyMap<string, string>;
  readonly columnToField: ReadonlyMap<string, string>;
}

function buildColumnMaps(schema: Schema): ReadonlyMap<string, ModelColumns> {
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
    if (!mc) throw new AbloValidationError(`drizzleDataSource: no model "${model}" in schema`, { code: 'source_adapter_misconfigured' });
    return mc;
  };

  const columnFor = (mc: ModelColumns, field: string): string =>
    mc.fieldToColumn.get(field) ?? camelToSnake(field);
  const fieldFor = (mc: ModelColumns, column: string): string =>
    mc.columnToField.get(column) ?? snakeToCamel(column);

  /** Field-keyed row to column-keyed row, for INSERT and UPDATE values. */
  const toColumns = (mc: ModelColumns, row: Row): Row => {
    const out: Row = {};
    for (const k of Object.keys(row)) out[columnFor(mc, k)] = row[k];
    return out;
  };
  /** Column-keyed row (from `RETURNING *` or `SELECT *`) back to a field-keyed row, for reads and results. */
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
    capabilities: {
      transactions: true,
      propose: false,
      schemaIntrospection: true,
      postgresWalEcho: true,
      outboxEvents: true,
    },

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
      const requestHash = sourceChangeIntentHash(change);
      return db.transaction(async (tx) => {
        const cached = rowsOf(
          await tx.execute(
            sql`SELECT response, request_hash AS "requestHash", expires_at AS "expiresAt"
                FROM ablo_idempotency
                WHERE client_tx_id = ${change.correlationId} LIMIT 1`,
          ),
        );
        const cachedRow = cached[0];
        if (cachedRow) {
          assertSourceIdempotencyIntent(cachedRow.requestHash, requestHash);
          assertSourceIdempotencyRetention(cachedRow.expiresAt);
          return { rows: cachedRow.response as Row[] };
        }

        const rows: Row[] = [];
        for (const [index, op] of change.operations.entries()) {
          const row = await applyOperation(tx, op);
          rows.push(row);
          const entityId = String(row.id ?? rowId(op));
          await tx.execute(sql`
            INSERT INTO ablo_outbox (
              id, model, entity_id, type, data,
              correlation_id, transaction_id, occurred_at
            )
            VALUES (
              ${`${change.correlationId}:${index}`}, ${op.model}, ${entityId}, ${op.type},
              ${op.type === 'DELETE' ? null : JSON.stringify(row)}::jsonb,
              ${change.correlationId}, ${op.transactionId ?? null}, ${Date.now()}
            )`);
        }

        await tx.execute(sql`
          INSERT INTO ablo_idempotency (client_tx_id, response, request_hash, expires_at)
          VALUES (
            ${change.correlationId}, ${JSON.stringify(rows)}::jsonb, ${requestHash},
            now() + ${SOURCE_IDEMPOTENCY_RETENTION}::interval
          )`);
        if (change.echo?.kind === 'postgres-wal') {
          await tx.execute(
            sql`SELECT pg_logical_emit_message(true, ${ABLO_POSTGRES_COMMIT_ECHO_PREFIX}, ${change.echo.payload})`,
          );
        }
        return { rows };
      });
    },

    async events(cursor: string | null, limit: number): Promise<EventsPage> {
      const after = cursor ?? '0';
      const rows = rowsOf(
        await db.execute(sql`
          SELECT cursor, id, model, entity_id, type, data, organization_id,
                 client_tx_id, correlation_id, transaction_id, occurred_at
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
          correlationId: r.correlation_id ?? null,
          transactionId: r.transaction_id ?? null,
          occurredAt: r.occurred_at != null ? Number(r.occurred_at) : null,
          cursor: String(r.cursor),
        }),
      );
      return { events, nextCursor: events.at(-1)?.cursor ?? null };
    },
  };
}
