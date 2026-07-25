import { field } from '@ablo/transaction/schema/field';
import { model } from '@ablo/transaction/schema/model';
import { defineSchema } from '@ablo/transaction/schema/schema';
import {
  prismaDataSource,
  type PrismaDelegate,
  type PrismaLike,
} from '../adapters/prisma.js';

const schema = defineSchema({
  task: model({ title: field.string() }),
});

class FakePrisma implements PrismaLike {
  readonly executed: { query: string; values: readonly unknown[] }[] = [];
  transactionCount = 0;
  inTransaction = false;

  readonly task: PrismaDelegate = {
    findUnique: ({ where }) => Promise.resolve({ id: where.id, title: 'A' }),
    findMany: () => Promise.resolve([]),
    create: ({ data }) => Promise.resolve(data),
    update: ({ where, data }) => Promise.resolve({ id: where.id, ...data }),
    delete: ({ where }) => Promise.resolve({ id: where.id }),
  };

  async $transaction<T>(fn: (tx: PrismaLike) => Promise<T>): Promise<T> {
    this.transactionCount += 1;
    this.inTransaction = true;
    try {
      return await fn(this);
    } finally {
      this.inTransaction = false;
    }
  }

  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T> {
    expect(this.inTransaction).toBe(true);
    this.executed.push({ query, values });
    return Promise.resolve([] as T);
  }

  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number> {
    expect(this.inTransaction).toBe(true);
    this.executed.push({ query, values });
    return Promise.resolve(1);
  }
}

describe('prismaDataSource', () => {
  it('emits the requested WAL echo inside the write transaction', async () => {
    const db = new FakePrisma();
    const adapter = prismaDataSource(db, schema);

    await adapter.commit({
      correlationId: 'corr_echo_1',
      intentHash: 'a'.repeat(64),
      echo: { kind: 'postgres-wal', payload: 'echo-payload' },
      operations: [
        { type: 'CREATE', model: 'task', id: 't1', input: { title: 'A' } },
      ],
    });

    expect(db.transactionCount).toBe(1);
    expect(db.executed.at(-1)?.query).toContain('pg_logical_emit_message');
    expect(db.executed.at(-1)?.values).toEqual(['ablo', 'echo-payload']);
  });

  it('does not emit a second marker when idempotency replays a cached commit', async () => {
    const db = new FakePrisma();
    db.$queryRawUnsafe = <T>() =>
      Promise.resolve([
        {
          response: [{ id: 't1', title: 'A' }],
          requestHash: 'a'.repeat(64),
        },
      ] as T);
    const adapter = prismaDataSource(db, schema);

    await adapter.commit({
      correlationId: 'corr_echo_1',
      intentHash: 'a'.repeat(64),
      echo: { kind: 'postgres-wal', payload: 'echo-payload' },
      operations: [
        { type: 'CREATE', model: 'task', id: 't1', input: { title: 'A' } },
      ],
    });

    expect(
      db.executed.filter(({ query }) => query.includes('pg_logical_emit_message')),
    ).toHaveLength(0);
  });
});
