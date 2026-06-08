/**
 * Drizzle Data Source adapter. Same spine + conformance as `prismaDataSource`,
 * built against Drizzle's REAL API (read from drizzle-orm's own source/docs):
 *   - `db.transaction(async (tx) => …)` — interactive transaction (commit/rollback).
 *   - `db.execute(sql`…`)` — parametrized raw SQL; `sql.identifier()` safely quotes
 *     dynamic table/column names, `sql`${value}`` parametrizes values.
 *   - the customer passes their Drizzle `tables` map (`{ task: pgTable(…) }`); a
 *     table object is resolved by name with NO reflection cast — unlike Prisma's
 *     nominal client, a `Record<string, PgTable>` is genuinely indexable.
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

import { sql, getTableName, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type {
  AdapterCommitResult,
  AdapterReadRequest,
  DataSourceAdapter,
  Row,
} from '../adapter.js';
import type { ChangeSet, EventsPage, Migration, Operation } from '../contract.js';
import { outboxEventSchema } from '../contract.js';

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

export function drizzleDataSource(
  db: DrizzleLike,
  tables: Record<string, PgTable>,
): DataSourceAdapter {
  const tableNameFor = (model: string): string => {
    const table = tables[model];
    if (!table) throw new Error(`drizzleDataSource: no Drizzle table for model "${model}"`);
    return getTableName(table);
  };

  const applyOperation = async (tx: DrizzleLike, op: Operation): Promise<Row> => {
    const table = sql.identifier(tableNameFor(op.model));
    const id = rowId(op);
    const input = op.input ?? {};

    if (op.type === 'DELETE') {
      const deleted = rowsOf(await tx.execute(sql`DELETE FROM ${table} WHERE id = ${id} RETURNING *`));
      return deleted[0] ?? { id };
    }

    if (op.type === 'CREATE') {
      const data: Row = { id, ...input };
      const cols = Object.keys(data);
      const values = sql.join(cols.map((c) => sql`${data[c]}`), sql`, `);
      const inserted = rowsOf(
        await tx.execute(sql`INSERT INTO ${table} (${identList(cols)}) VALUES (${values}) RETURNING *`),
      );
      return inserted[0] ?? data;
    }

    // UPDATE / ARCHIVE / UNARCHIVE — a SET clause + the lifecycle column.
    const patch: Row = {
      ...input,
      ...(op.type === 'ARCHIVE' ? { archived_at: new Date() } : {}),
      ...(op.type === 'UNARCHIVE' ? { archived_at: null } : {}),
    };
    const assignments = sql.join(
      Object.keys(patch).map((c) => sql`${sql.identifier(c)} = ${patch[c]}`),
      sql`, `,
    );
    const updated = rowsOf(
      await tx.execute(sql`UPDATE ${table} SET ${assignments} WHERE id = ${id} RETURNING *`),
    );
    return updated[0] ?? { id, ...patch };
  };

  return {
    capabilities: { transactions: true, propose: false, schemaIntrospection: true },

    migrations(): readonly Migration[] {
      return [
        {
          name: 'ablo_idempotency',
          up: `CREATE TABLE IF NOT EXISTS ablo_idempotency (
  client_tx_id TEXT PRIMARY KEY,
  response     JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);`,
        },
        {
          name: 'ablo_outbox',
          up: `CREATE TABLE IF NOT EXISTS ablo_outbox (
  cursor          BIGSERIAL PRIMARY KEY,
  id              TEXT NOT NULL UNIQUE,
  model           TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  type            TEXT NOT NULL,
  data            JSONB,
  organization_id TEXT,
  client_tx_id    TEXT,
  occurred_at     BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);`,
        },
      ];
    },

    async read(req: AdapterReadRequest): Promise<readonly Row[]> {
      const table = sql.identifier(tableNameFor(req.model));
      if (req.kind === 'load') {
        return rowsOf(await db.execute(sql`SELECT * FROM ${table} WHERE id = ${req.id} LIMIT 1`));
      }
      const limit = req.query?.limit ?? 1000;
      return rowsOf(await db.execute(sql`SELECT * FROM ${table} LIMIT ${limit}`));
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
