import { field } from '@abloatai/transaction/schema/field';
import { model } from '@abloatai/transaction/schema/model';
import { defineSchema } from '@abloatai/transaction/schema/schema';
import {
  prismaDataSource,
  type PrismaDelegate,
  type PrismaLike,
} from '../adapters/prisma.js';

const schema = defineSchema({
  item: model({ title: field.string() }),
});

class FakePrisma implements PrismaLike {
  readonly executed: { query: string; values: readonly unknown[] }[] = [];
  transactionCount = 0;
  inTransaction = false;
  findManyArgs: Parameters<PrismaDelegate['findMany']>[0] | undefined;

  readonly item: PrismaDelegate = {
    findUnique: ({ where }) => Promise.resolve({ id: where.id, title: 'A' }),
    findMany: (args) => {
      this.findManyArgs = args;
      return Promise.resolve([]);
    },
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
  it('applies the subject predicate before the database limit', async () => {
    const subjectSchema = defineSchema({
      item: model(
        { title: field.string(), workspaceId: field.string().min(1) },
        { subject: { field: 'workspaceId', group: 'workspace' } },
      ),
    });
    const db = new FakePrisma();
    const adapter = prismaDataSource(db, subjectSchema);
    await adapter.read({
      kind: 'list', model: 'item', query: { limit: 1 },
      scope: { syncGroups: ['workspace:a'] },
    });
    expect(db.findManyArgs).toEqual({
      take: 1,
      where: { AND: [{}, { workspaceId: { in: ['a'] } }] },
    });
  });

  it('locks the subject preimage before mutating it', async () => {
    const subjectSchema = defineSchema({
      item: model(
        { title: field.string(), workspaceId: field.string().min(1) },
        { subject: { field: 'workspaceId', group: 'workspace' } },
      ),
    });
    const db = new FakePrisma();
    db.$queryRawUnsafe = <T>(query: string, ...values: unknown[]) => {
      db.executed.push({ query, values });
      return Promise.resolve((query.includes('FOR UPDATE')
        ? [{ id: 'own', workspaceId: 'a' }]
        : []) as T);
    };
    db.item.update = ({ where, data }) =>
      Promise.resolve({ id: where.id, workspaceId: 'a', ...data });
    const adapter = prismaDataSource(db, subjectSchema);
    await adapter.commit({
      correlationId: 'subject-lock',
      scope: { syncGroups: ['workspace:a'] },
      operations: [{ type: 'UPDATE', model: 'item', id: 'own', input: { title: 'after' } }],
    });
    expect(db.executed.find(({ query }) => query.includes('FOR UPDATE'))?.query)
      .toContain('"workspace_id" AS "workspaceId"');
  });

  it('takes an absent-key advisory lock before authorizing subject CREATE', async () => {
    const subjectSchema = defineSchema({
      item: model(
        { title: field.string(), workspaceId: field.string().min(1) },
        { subject: { field: 'workspaceId', group: 'workspace' } },
      ),
    });
    const db = new FakePrisma();
    await prismaDataSource(db, subjectSchema).commit({
      correlationId: 'subject-create-lock',
      scope: { syncGroups: ['workspace:a'] },
      operations: [{ type: 'CREATE', model: 'item', id: 'new', input: { title: 'created', workspaceId: 'a' } }],
    });
    const advisory = db.executed.findIndex(({ query }) => query.includes('pg_advisory_xact_lock'));
    const preimage = db.executed.findIndex(({ query }) => query.includes('FOR UPDATE'));
    expect(advisory).toBeGreaterThan(-1);
    expect(advisory).toBeLessThan(preimage);
  });

  it('emits the requested WAL echo inside the write transaction', async () => {
    const db = new FakePrisma();
    const adapter = prismaDataSource(db, schema);

    await adapter.commit({
      correlationId: 'corr_echo_1',
      intentHash: 'a'.repeat(64),
      echo: { kind: 'postgres-wal', payload: 'echo-payload' },
      operations: [
        { type: 'CREATE', model: 'item', id: 't1', input: { title: 'A' } },
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
        { type: 'CREATE', model: 'item', id: 't1', input: { title: 'A' } },
      ],
    });

    expect(
      db.executed.filter(({ query }) => query.includes('pg_logical_emit_message')),
    ).toHaveLength(0);
  });
});
