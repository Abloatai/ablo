/**
 * The Prisma adapter for the data-source interface. It implements
 * {@link DataSourceAdapter} against a Prisma client and passes the same conformance
 * suite as the in-memory reference and the other adapters.
 *
 * The adapter owns the transactional outbox and idempotency bookkeeping, so you
 * never write them: `commit` runs the row mutations, the `ablo_outbox` append, and
 * the `ablo_idempotency` record inside a single `prisma.$transaction`, and
 * `migrations` returns the SQL that creates those two tables.
 *
 * It takes no dependency on `@prisma/client`. The client is accepted structurally
 * as {@link PrismaLike}, so this module compiles without Prisma installed and can
 * be tested with a fake, while a real `PrismaClient` satisfies the shape at the
 * call site.
 */

import { AbloValidationError } from '../../errors.js';
import type {
  AdapterCommitResult,
  AdapterReadRequest,
  DataSourceAdapter,
  Row,
} from '../adapter.js';
import type { ChangeSet, EventsPage, Migration, Operation, OutboxEvent } from '../contract.js';
import { outboxEventSchema } from '../contract.js';
import { adapterTableMigrations } from '../migrations.js';
import {
  assertSourceIdempotencyIntent,
  assertSourceIdempotencyRetention,
  SOURCE_IDEMPOTENCY_RETENTION,
  sourceChangeIntentHash,
} from '../idempotency.js';
import type { SchemaRecord, Schema } from '../../schema/schema.js';
import {
  ABLO_POSTGRES_COMMIT_ECHO_PREFIX,
  type SourceListQuery,
  type SourceWhere,
} from '../types.js';

/** A Prisma model delegate — the subset of its methods the adapter calls. */
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

/** A Prisma client, or its interactive-transaction client, as a structural shape that needs no `@prisma/client` import. */
export interface PrismaLike extends PrismaRaw {
  $transaction<T>(fn: (tx: PrismaLike & PrismaRaw) => Promise<T>): Promise<T>;
}

export interface PrismaDataSourceOptions {
  /** Map a schema model name → its Prisma delegate name. Default: lower-first-letter. */
  readonly delegateName?: (model: string) => string;
}

const lowerFirst = (s: string): string => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/**
 * Resolves a model's Prisma delegate by name. This is the one unavoidable cast in
 * the adapter, and it reflects a real limit of the type system rather than a
 * shortcut. Writes inside `prisma.$transaction(tx => …)` must go through the
 * transactional client `tx`, and the model is known only as a runtime string.
 * Prisma keys its client by fixed property names (`{ task: TaskDelegate; … }`), so
 * a dynamic `tx[name]` lookup is `unknown` to the compiler: there is no static key
 * to infer from a string. The cast is checked at runtime immediately afterward by
 * confirming that `findMany` is a function on the resolved delegate.
 */
function delegateFor(client: PrismaLike, name: string): PrismaDelegate {
  const delegate = (client as unknown as Record<string, PrismaDelegate | undefined>)[name];
  if (!delegate || typeof delegate.findMany !== 'function') {
    throw new AbloValidationError(`prismaDataSource: no Prisma delegate "${name}" on the client`, { code: 'source_adapter_misconfigured' });
  }
  return delegate;
}

/** Translates a source-query `where` tuple set into a Prisma `where` object. */
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
    throw new AbloValidationError(`operation on "${op.model}" requires an id`, { code: 'source_operation_id_required' });
  }
  return id;
}

export function prismaDataSource<S extends SchemaRecord>(
  prisma: PrismaLike,
  schema: Schema<S>,
  options: PrismaDataSourceOptions = {},
): DataSourceAdapter {
  const delegateName = options.delegateName ?? lowerFirst;
  void schema; // held for typed reads and model validation

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
      const delegate = delegateFor(prisma, delegateName(req.model));
      if (req.kind === 'load') {
        const row = await delegate.findUnique({ where: { id: req.id } });
        return row ? [row] : [];
      }
      return delegate.findMany(findManyArgs(req.query));
    },

    async commit(change: ChangeSet): Promise<AdapterCommitResult> {
      const requestHash = sourceChangeIntentHash(change);
      return prisma.$transaction(async (tx) => {
        // Idempotency: a duplicate scoped correlation returns the original rows.
        const cached = await tx.$queryRawUnsafe<
          { response: Row[]; requestHash: string | null; expiresAt?: unknown }[]
        >(
          `SELECT response, request_hash AS "requestHash", expires_at AS "expiresAt"
             FROM ablo_idempotency WHERE client_tx_id = $1 LIMIT 1`,
          change.correlationId,
        );
        const cachedRow = cached[0];
        if (cachedRow) {
          assertSourceIdempotencyIntent(cachedRow.requestHash, requestHash);
          assertSourceIdempotencyRetention(cachedRow.expiresAt);
          return { rows: cachedRow.response };
        }

        const rows: Row[] = [];
        for (const [index, op] of change.operations.entries()) {
          const row = await applyOperation(tx, op);
          rows.push(row);
          const entityId = String(row.id ?? rowId(op));
          // Transactional outbox: one event per operation, written in this same transaction.
          await tx.$executeRawUnsafe(
            `INSERT INTO ablo_outbox (
               id, model, entity_id, type, data,
               correlation_id, transaction_id, occurred_at
             ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
            `${change.correlationId}:${index}`,
            op.model,
            entityId,
            op.type,
            JSON.stringify(op.type === 'DELETE' ? null : row),
            change.correlationId,
            op.transactionId ?? null,
            Date.now(),
          );
        }

        await tx.$executeRawUnsafe(
          `INSERT INTO ablo_idempotency (client_tx_id, response, request_hash, expires_at)
           VALUES ($1, $2::jsonb, $3, now() + $4::interval)`,
          change.correlationId,
          JSON.stringify(rows),
          requestHash,
          SOURCE_IDEMPOTENCY_RETENTION,
        );
        if (change.echo?.kind === 'postgres-wal') {
          // Cast the returned LSN to text. `pg_logical_emit_message` yields a
          // `pg_lsn`, and Prisma's driver adapter can't deserialize that OID
          // ("Failed to deserialize column of type 'pg_lsn'"); the value is
          // discarded anyway, so text is the safe carrier. (postgres.js-backed
          // adapters read pg_lsn as a string and don't need this.)
          await tx.$queryRawUnsafe(
            `SELECT pg_logical_emit_message(true, $1::text, $2::text)::text`,
            ABLO_POSTGRES_COMMIT_ECHO_PREFIX,
            change.echo.payload,
          );
        }
        return { rows };
      });
    },

    async events(cursor: string | null, limit: number): Promise<EventsPage> {
      const after = cursor ? cursor : '0';
      const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT cursor, id, model, entity_id, type, data, organization_id,
                client_tx_id, correlation_id, transaction_id, occurred_at
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
          correlationId: r.correlation_id ?? null,
          transactionId: r.transaction_id ?? null,
          occurredAt: r.occurred_at != null ? Number(r.occurred_at) : null,
          cursor: String(r.cursor),
        }),
      );
      return {
        events,
        nextCursor: events.at(-1)?.cursor ?? null,
      };
    },
  };
}
