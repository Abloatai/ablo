/**
 * Prisma Data Source adapter. The first real ORM adapter (Auth.js pattern: one
 * package per ORM, all behind the `DataSourceAdapter` interface, all proven by the
 * same conformance suite the in-memory reference passes).
 *
 * It owns the transactional outbox + idempotency so the customer never writes
 * them: `commit` runs the app-row mutations, the `ablo_outbox` append, and the
 * `ablo_idempotency` record in ONE `prisma.$transaction`. `migrations()` ships
 * the table-creation SQL for those two tables.
 *
 * No `@prisma/client` dependency: the client is accepted structurally
 * (`PrismaLike`), so this compiles in the SDK package and is unit-testable with
 * a fake, while a real `PrismaClient` satisfies it at the call site.
 */

import type {
  AdapterCommitResult,
  AdapterReadRequest,
  DataSourceAdapter,
  Row,
} from '../adapter.js';
import type { ChangeSet, EventsPage, Migration, Operation, OutboxEvent } from '../contract.js';
import { outboxEventSchema } from '../contract.js';
import { adapterTableMigrations } from '../migrations.js';
import type { SchemaRecord, Schema } from '../../schema/schema.js';
import type { SourceListQuery, SourceWhere } from '../index.js';

/** A Prisma model delegate (the subset we call). */
export interface PrismaDelegate {
  findUnique(args: { where: { id: string } }): Promise<Row | null>;
  findMany(args: {
    where?: Record<string, unknown>;
    take?: number;
    orderBy?: Record<string, 'asc' | 'desc'>;
  }): Promise<Row[]>;
  create(args: { data: Row }): Promise<Row>;
  update(args: { where: { id: string }; data: Row }): Promise<Row>;
  delete(args: { where: { id: string } }): Promise<Row>;
}

/** The raw-SQL surface used for the adapter-owned tables. */
export interface PrismaRaw {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

/** A Prisma client (or interactive-transaction client) — structural, no SDK dependency. */
export interface PrismaLike extends PrismaRaw {
  $transaction<T>(fn: (tx: PrismaLike & PrismaRaw) => Promise<T>): Promise<T>;
}

export interface PrismaDataSourceOptions {
  /** Map a schema model name → its Prisma delegate name. Default: lower-first-letter. */
  readonly delegateName?: (model: string) => string;
}

const lowerFirst = (s: string): string => (s ? s[0].toLowerCase() + s.slice(1) : s);

/**
 * Resolve a model's Prisma delegate by name. This is the ONE irreducible cast in
 * the adapter layer, and it's a genuine type-system limit, not laziness:
 *
 *   - Inside `prisma.$transaction(tx => …)` the writes MUST go through the
 *     transactional client `tx`, and the model is only known as a runtime string.
 *   - Prisma's client (and transaction handle) is NOMINALLY keyed (`{ task: TaskDelegate; … }`), so a
 *     dynamic `tx[name]` is `unknown` to the compiler — there is no key to infer.
 *
 * Dynamic property access on a statically-keyed type cannot be typed without an
 * assertion; this is the reflection boundary, validated at runtime (`findMany` is
 * a function) right after. `ablo generate` removes even this by emitting a typed
 * `model → delegate` map, at which point this helper is replaced by a lookup.
 */
function delegateFor(client: PrismaLike, name: string): PrismaDelegate {
  const delegate = (client as unknown as Record<string, PrismaDelegate | undefined>)[name];
  if (!delegate || typeof delegate.findMany !== 'function') {
    throw new Error(`prismaDataSource: no Prisma delegate "${name}" on the client`);
  }
  return delegate;
}

/** Translate a Source `where` tuple set into a Prisma `where` object. */
function toPrismaWhere(where: readonly SourceWhere[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const clause of where ?? []) {
    const [field] = clause;
    if (clause.length === 2) {
      out[field] = clause[1];
      continue;
    }
    const [, op, value] = clause;
    switch (op) {
      case '=': out[field] = value; break;
      case '!=': out[field] = { not: value }; break;
      case '<': out[field] = { lt: value }; break;
      case '<=': out[field] = { lte: value }; break;
      case '>': out[field] = { gt: value }; break;
      case '>=': out[field] = { gte: value }; break;
      case 'IN': out[field] = { in: value }; break;
      case 'NOT IN': out[field] = { notIn: value }; break;
      case 'LIKE': case 'ILIKE': out[field] = { contains: value, mode: op === 'ILIKE' ? 'insensitive' : 'default' }; break;
      case 'NOT LIKE': case 'NOT ILIKE': out[field] = { not: { contains: value } }; break;
      case 'IS': case 'IS NOT': out[field] = op === 'IS' ? value : { not: value }; break;
    }
  }
  return out;
}

function findManyArgs(query: SourceListQuery | undefined): {
  where?: Record<string, unknown>;
  take?: number;
  orderBy?: Record<string, 'asc' | 'desc'>;
} {
  return {
    where: toPrismaWhere(query?.where),
    ...(typeof query?.limit === 'number' ? { take: query.limit } : {}),
    ...(query?.orderBy ? { orderBy: { [query.orderBy]: query.order ?? 'asc' } } : {}),
  };
}

function rowId(op: Operation): string {
  const id = op.id ?? (op.input?.id as string | undefined);
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`operation on "${op.model}" requires an id`);
  }
  return id;
}

export function prismaDataSource<S extends SchemaRecord>(
  prisma: PrismaLike,
  schema: Schema<S>,
  options: PrismaDataSourceOptions = {},
): DataSourceAdapter {
  const delegateName = options.delegateName ?? lowerFirst;
  void schema; // reserved for codegen-typed reads / model validation

  const applyOperation = async (tx: PrismaLike, op: Operation): Promise<Row> => {
    const delegate = delegateFor(tx, delegateName(op.model));
    const id = rowId(op);
    switch (op.type) {
      case 'CREATE':
        return delegate.create({ data: { id, ...(op.input ?? {}) } });
      case 'UPDATE':
        return delegate.update({ where: { id }, data: { ...(op.input ?? {}) } });
      case 'ARCHIVE':
        return delegate.update({ where: { id }, data: { ...(op.input ?? {}), archivedAt: new Date() } });
      case 'UNARCHIVE':
        return delegate.update({ where: { id }, data: { ...(op.input ?? {}), archivedAt: null } });
      case 'DELETE':
        return delegate.delete({ where: { id } });
    }
  };

  return {
    capabilities: { transactions: true, propose: false, schemaIntrospection: true },

    migrations(): readonly Migration[] {
      return adapterTableMigrations();
    },

    async read(req: AdapterReadRequest): Promise<readonly Row[]> {
      const delegate = delegateFor(prisma, delegateName(req.model));
      if (req.kind === 'load') {
        const row = await delegate.findUnique({ where: { id: req.id } });
        return row ? [row] : [];
      }
      return delegate.findMany(findManyArgs(req.query));
    },

    async commit(change: ChangeSet): Promise<AdapterCommitResult> {
      return prisma.$transaction(async (tx) => {
        // Idempotency: a duplicate clientTxId returns the original rows, no re-apply.
        const cached = await tx.$queryRawUnsafe<{ response: Row[] }[]>(
          `SELECT response FROM ablo_idempotency WHERE client_tx_id = $1 LIMIT 1`,
          change.clientTxId,
        );
        if (cached.length > 0) return { rows: cached[0].response };

        const rows: Row[] = [];
        for (const [index, op] of change.operations.entries()) {
          const row = await applyOperation(tx, op);
          rows.push(row);
          const entityId = String(row.id ?? rowId(op));
          // Transactional outbox: one event per op, written in THIS transaction.
          await tx.$executeRawUnsafe(
            `INSERT INTO ablo_outbox (id, model, entity_id, type, data, client_tx_id, occurred_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
            `${change.clientTxId}:${index}`,
            op.model,
            entityId,
            op.type,
            JSON.stringify(op.type === 'DELETE' ? null : row),
            change.clientTxId,
            Date.now(),
          );
        }

        await tx.$executeRawUnsafe(
          `INSERT INTO ablo_idempotency (client_tx_id, response) VALUES ($1, $2::jsonb)`,
          change.clientTxId,
          JSON.stringify(rows),
        );
        return { rows };
      });
    },

    async events(cursor: string | null, limit: number): Promise<EventsPage> {
      const after = cursor ? cursor : '0';
      const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT cursor, id, model, entity_id, type, data, organization_id, client_tx_id, occurred_at
         FROM ablo_outbox WHERE cursor > $1 ORDER BY cursor ASC LIMIT $2`,
        after,
        limit,
      );
      const events: OutboxEvent[] = rows.map((r) =>
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
      return {
        events,
        nextCursor: events.length > 0 ? events[events.length - 1].cursor : null,
      };
    },
  };
}
