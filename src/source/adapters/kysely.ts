/**
 * Kysely Data Source adapter. Same adapter interface + conformance shape as
 * `prismaDataSource` / `drizzleDataSource`, built against Kysely's REAL
 * query-builder API:
 *   - `db.transaction().execute(async (trx) => …)` — interactive transaction.
 *   - `insertInto/updateTable/deleteFrom/selectFrom` + `returningAll()` —
 *     the fluent builder; table/column names are plain strings, so no raw
 *     SQL tag is needed and this module imports NOTHING from `kysely`
 *     (structural `KyselyLike`, mirroring the Prisma adapter's zero-dep
 *     `PrismaLike`).
 *
 * SCHEMA-DRIVEN COLUMNS. Kysely is SQL-near: it passes the column names you
 * give it through verbatim (no Prisma-style `@map`). Like the Drizzle
 * adapter, every table + column name is derived from the SAME rule the
 * provisioner uses (`generateProvisionPlan`):
 *   table  = `model.tableName ?? key`
 *   column = `fieldMeta.column ?? camelToSnake(field)`  (+ the tenancy column)
 * so `ablo migrate` (which emits `operator_id`) and this adapter COMPOSE.
 * The adapter is the translation boundary: rows in/out are field-keyed (the
 * SDK shape); the physical columns it reads/writes are snake_case.
 *
 * JSONB note: the outbox `data` / idempotency `response` values are passed
 * as JSON strings — Postgres infers the parameter type from the target
 * `jsonb` column, so the coercion is server-side and driver-agnostic (no
 * `::jsonb` cast available without raw SQL).
 */

import { AbloValidationError } from '../../errors.js';
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

/**
 * The subset of a Kysely instance (or transaction handle) the adapter calls.
 * Structural on purpose — declared with method shorthand so a real
 * `Kysely<DB>` (whose params are narrowed to `keyof DB`) stays assignable
 * under TypeScript's method bivariance, exactly like `PrismaLike`.
 */
export interface KyselyLike {
  selectFrom(table: string): KyselySelectBuilder;
  insertInto(table: string): KyselyInsertBuilder;
  updateTable(table: string): KyselyUpdateBuilder;
  deleteFrom(table: string): KyselyDeleteBuilder;
  transaction(): KyselyTransactionBuilder;
}

export interface KyselyTransactionBuilder {
  execute<T>(fn: (trx: KyselyLike) => Promise<T>): Promise<T>;
}

export interface KyselySelectBuilder {
  selectAll(): KyselySelectBuilder;
  where(column: string, operator: string, value: unknown): KyselySelectBuilder;
  orderBy(column: string, direction: 'asc' | 'desc'): KyselySelectBuilder;
  limit(limit: number): KyselySelectBuilder;
  execute(): Promise<readonly Row[]>;
}

export interface KyselyInsertBuilder {
  values(row: Row): KyselyInsertBuilder;
  returningAll(): KyselyInsertBuilder;
  execute(): Promise<readonly Row[]>;
}

export interface KyselyUpdateBuilder {
  set(patch: Row): KyselyUpdateBuilder;
  where(column: string, operator: string, value: unknown): KyselyUpdateBuilder;
  returningAll(): KyselyUpdateBuilder;
  execute(): Promise<readonly Row[]>;
}

export interface KyselyDeleteBuilder {
  where(column: string, operator: string, value: unknown): KyselyDeleteBuilder;
  returningAll(): KyselyDeleteBuilder;
  execute(): Promise<readonly Row[]>;
}

function rowId(op: Operation): string {
  const id = op.id ?? (op.input?.id as string | undefined);
  if (typeof id !== 'string' || id.length === 0) {
    throw new AbloValidationError(`operation on "${op.model}" requires an id`, {
      code: 'source_operation_id_required',
    });
  }
  return id;
}

/** Per-model name resolution, precomputed once from the schema (see drizzle.ts). */
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

export function kyselyDataSource<S extends SchemaRecord>(
  db: KyselyLike,
  schema: Schema<S>,
): DataSourceAdapter {
  const maps = buildColumnMaps(schema);
  const modelColumns = (model: string): ModelColumns => {
    const mc = maps.get(model);
    if (!mc) {
      throw new AbloValidationError(`kyselyDataSource: no model "${model}" in schema`, {
        code: 'source_adapter_misconfigured',
      });
    }
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
  /** Column-keyed (RETURNING * / SELECT *) → field-keyed (SDK shape). */
  const toFields = (mc: ModelColumns, row: Row): Row => {
    const out: Row = {};
    for (const k of Object.keys(row)) out[fieldFor(mc, k)] = row[k];
    return out;
  };

  const applyOperation = async (trx: KyselyLike, op: Operation): Promise<Row> => {
    const mc = modelColumns(op.model);
    const id = rowId(op);
    const input = op.input ?? {};

    if (op.type === 'DELETE') {
      const deleted = await trx
        .deleteFrom(mc.table)
        .where('id', '=', id)
        .returningAll()
        .execute();
      return deleted[0] ? toFields(mc, deleted[0]) : { id };
    }

    if (op.type === 'CREATE') {
      const inserted = await trx
        .insertInto(mc.table)
        .values(toColumns(mc, { id, ...input }))
        .returningAll()
        .execute();
      return inserted[0] ? toFields(mc, inserted[0]) : { id, ...input };
    }

    // UPDATE / ARCHIVE / UNARCHIVE — the lifecycle field is `archivedAt`
    // (camelCase) and goes through `toColumns` like any other, so it lands in
    // `archived_at` — the same column the provisioner emits.
    const patch = toColumns(mc, {
      ...input,
      ...(op.type === 'ARCHIVE' ? { archivedAt: new Date() } : {}),
      ...(op.type === 'UNARCHIVE' ? { archivedAt: null } : {}),
    });
    const updated = await trx
      .updateTable(mc.table)
      .set(patch)
      .where('id', '=', id)
      .returningAll()
      .execute();
    return updated[0] ? toFields(mc, updated[0]) : { id, ...input };
  };

  return {
    capabilities: { transactions: true, propose: false, schemaIntrospection: true },

    migrations(): readonly Migration[] {
      return adapterTableMigrations();
    },

    async read(req: AdapterReadRequest): Promise<readonly Row[]> {
      const mc = modelColumns(req.model);
      if (req.kind === 'load') {
        const rows = await db
          .selectFrom(mc.table)
          .selectAll()
          .where('id', '=', req.id)
          .limit(1)
          .execute();
        return rows.map((r) => toFields(mc, r));
      }
      const limit = req.query?.limit ?? 1000;
      const rows = await db.selectFrom(mc.table).selectAll().limit(limit).execute();
      return rows.map((r) => toFields(mc, r));
    },

    async commit(change: ChangeSet): Promise<AdapterCommitResult> {
      return db.transaction().execute(async (trx) => {
        const cached = await trx
          .selectFrom('ablo_idempotency')
          .selectAll()
          .where('client_tx_id', '=', change.clientTxId)
          .limit(1)
          .execute();
        if (cached.length > 0) {
          const response = cached[0].response;
          return {
            rows: (typeof response === 'string' ? JSON.parse(response) : response) as Row[],
          };
        }

        const rows: Row[] = [];
        for (const [index, op] of change.operations.entries()) {
          const row = await applyOperation(trx, op);
          rows.push(row);
          const entityId = String(row.id ?? rowId(op));
          await trx
            .insertInto('ablo_outbox')
            .values({
              id: `${change.clientTxId}:${index}`,
              model: op.model,
              entity_id: entityId,
              type: op.type,
              data: op.type === 'DELETE' ? null : JSON.stringify(row),
              client_tx_id: change.clientTxId,
              occurred_at: Date.now(),
            })
            .execute();
        }

        await trx
          .insertInto('ablo_idempotency')
          .values({ client_tx_id: change.clientTxId, response: JSON.stringify(rows) })
          .execute();
        return { rows };
      });
    },

    async events(cursor: string | null, limit: number): Promise<EventsPage> {
      const after = cursor ?? '0';
      const rows = await db
        .selectFrom('ablo_outbox')
        .selectAll()
        .where('cursor', '>', after)
        .orderBy('cursor', 'asc')
        .limit(limit)
        .execute();
      const events = rows.map((r) =>
        outboxEventSchema.parse({
          id: r.id,
          model: r.model,
          entityId: r.entity_id,
          type: r.type,
          data: typeof r.data === 'string' ? JSON.parse(r.data) : r.data ?? null,
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
