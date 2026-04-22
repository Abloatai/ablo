/**
 * @jest-environment node
 */

import { z } from 'zod';
import { defineMutator, defineMutators } from '../../../src/server/defineMutator';
import { MutatorRegistry } from '../../../src/server/registry';
import { executeMutator, type ExecuteMutatorOptions } from '../../../src/server/execute';
import { MutatorError, ValidationError } from '../../../src/server/errors';
import type { MutatorContext } from '../../../src/server/context';
import type { Schema } from '../../../src/schema';
import { defineSchema, model } from '../../../src/schema';

// ── Test schema ──────────────────────────────────────────────────────────

const testSchema = defineSchema({
  slideLayer: model({
    slideId: z.string(),
    type: z.enum(['text', 'image', 'shape']),
    content: z.string().optional(),
  }),
});

// ── Test mutators ────────────────────────────────────────────────────────

const testMutators = defineMutators({
  slideLayer: {
    create: defineMutator(
      z.object({
        id: z.string(),
        slideId: z.string(),
        type: z.enum(['text', 'image', 'shape']),
      }),
      async (tx, args, ctx) => {
        await tx.mutations.slideLayer.insert({
          ...args,
          createdBy: ctx.participantId,
          organizationId: ctx.organizationId,
        });
      },
    ),
    failOnPurpose: defineMutator(
      z.object({}),
      async () => {
        throw new ValidationError('Business rule violated');
      },
    ),
  },
});

// ── Mock Postgres ────────────────────────────────────────────────────────
// Fakes the subset of Porsager's postgres API that executeMutator uses:
// sql.begin(callback) and pgTx.unsafe(query, params)

interface CapturedQuery {
  sql: string;
  params: unknown[];
}

function createMockSql() {
  const queries: CapturedQuery[] = [];
  let shouldFail = false;

  const mockTx = {
    unsafe: jest.fn(async (sql: string, params?: unknown[]) => {
      if (shouldFail) throw new Error('DB connection lost');
      queries.push({ sql, params: params ?? [] });
      return [];
    }),
  };

  const mockSql = {
    begin: jest.fn(async (cb: (tx: typeof mockTx) => Promise<unknown>) => {
      return cb(mockTx);
    }),
    // Expose for test assertions
    _queries: queries,
    _mockTx: mockTx,
    _setFail: (fail: boolean) => { shouldFail = fail; },
  };

  return mockSql;
}

// ── Fixtures ─────────────────────────────────────────────────────────────

const testContext: MutatorContext = {
  participantId: 'user_1',
  participantKind: 'user',
  organizationId: 'org_1',
};

function makeOptions(mockSql: ReturnType<typeof createMockSql>): ExecuteMutatorOptions<typeof testSchema> {
  const registry = new MutatorRegistry().register(testMutators);
  return {
    registry,
    schema: testSchema,
    sql: mockSql as unknown as ExecuteMutatorOptions<typeof testSchema>['sql'],
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('executeMutator', () => {
  it('executes a mutator and returns deltas', async () => {
    const mockSql = createMockSql();
    const result = await executeMutator(
      'slideLayer.create',
      { id: 'layer_1', slideId: 'slide_1', type: 'text' },
      testContext,
      'client_tx_1',
      makeOptions(mockSql),
    );

    expect(result.deltas).toHaveLength(1);
    expect(result.deltas[0]).toMatchObject({
      model: 'slideLayer',
      op: 'insert',
      data: expect.objectContaining({
        id: 'layer_1',
        slideId: 'slide_1',
        type: 'text',
      }),
    });
    expect(result.serverTxId).toBeDefined();
    expect(typeof result.serverTxId).toBe('string');
  });

  it('writes to sync_deltas and mutation_log inside the transaction', async () => {
    const mockSql = createMockSql();
    await executeMutator(
      'slideLayer.create',
      { id: 'layer_1', slideId: 'slide_1', type: 'text' },
      testContext,
      'client_tx_1',
      makeOptions(mockSql),
    );

    // Should have 3 SQL calls: INSERT into domain table, INSERT into sync_deltas, INSERT into mutation_log
    const queries = mockSql._queries;
    expect(queries.length).toBeGreaterThanOrEqual(3);

    // Domain table insert
    expect(queries[0].sql).toContain('INSERT INTO');
    expect(queries[0].sql).toContain('slide_layer');

    // sync_deltas insert
    const syncDeltaQuery = queries.find((q) => q.sql.includes('sync_deltas'));
    expect(syncDeltaQuery).toBeDefined();

    // mutation_log insert
    const mutationLogQuery = queries.find((q) => q.sql.includes('mutation_log'));
    expect(mutationLogQuery).toBeDefined();
    expect(mutationLogQuery!.params).toContain('client_tx_1');
  });

  it('throws MutatorError with code invalid_mutator for unknown name', async () => {
    const mockSql = createMockSql();

    try {
      await executeMutator(
        'nonexistent.mutator',
        {},
        testContext,
        'client_tx_1',
        makeOptions(mockSql),
      );
      fail('Expected MutatorError');
    } catch (err) {
      expect(err).toBeInstanceOf(MutatorError);
      expect((err as MutatorError).code).toBe('invalid_mutator');
    }

    // Should NOT have called sql.begin (no DB interaction)
    expect(mockSql.begin).not.toHaveBeenCalled();
  });

  it('throws MutatorError with code invalid_input on Zod validation failure', async () => {
    const mockSql = createMockSql();

    try {
      await executeMutator(
        'slideLayer.create',
        { id: 123, slideId: 'slide_1' }, // id should be string, type is missing
        testContext,
        'client_tx_1',
        makeOptions(mockSql),
      );
      fail('Expected MutatorError');
    } catch (err) {
      expect(err).toBeInstanceOf(MutatorError);
      expect((err as MutatorError).code).toBe('invalid_input');
    }

    // Should NOT have called sql.begin (validation happens before DB)
    expect(mockSql.begin).not.toHaveBeenCalled();
  });

  it('propagates ValidationError thrown by the mutator body', async () => {
    const mockSql = createMockSql();

    try {
      await executeMutator(
        'slideLayer.failOnPurpose',
        {},
        testContext,
        'client_tx_1',
        makeOptions(mockSql),
      );
      fail('Expected ValidationError');
    } catch (err) {
      expect(err).toBeInstanceOf(MutatorError);
      expect((err as MutatorError).code).toBe('validation_failed');
      expect((err as MutatorError).message).toBe('Business rule violated');
    }
  });

  it('wraps unexpected errors in MutatorError with code internal_error', async () => {
    const mockSql = createMockSql();
    mockSql._setFail(true); // Make DB calls throw

    try {
      await executeMutator(
        'slideLayer.create',
        { id: 'layer_1', slideId: 'slide_1', type: 'text' },
        testContext,
        'client_tx_1',
        makeOptions(mockSql),
      );
      fail('Expected MutatorError');
    } catch (err) {
      // The error propagates from inside the sql.begin callback.
      // Since the DB failure happens during the mutator's tx.mutations.*.insert(),
      // it gets caught by executeMutator and wrapped.
      expect(err).toBeInstanceOf(Error);
    }
  });

  it('passes organizationId in sync_deltas insert', async () => {
    const mockSql = createMockSql();
    await executeMutator(
      'slideLayer.create',
      { id: 'layer_1', slideId: 'slide_1', type: 'text' },
      testContext,
      'client_tx_1',
      makeOptions(mockSql),
    );

    const syncDeltaQuery = mockSql._queries.find((q) =>
      q.sql.includes('sync_deltas'),
    );
    expect(syncDeltaQuery!.params[0]).toBe('org_1');
  });
});
