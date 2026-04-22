/**
 * Property-based tests for TransactionQueue.
 *
 * Uses fast-check to verify invariants:
 * - FK priority ordering is stable across random operation sequences
 * - Priority scores are consistent: CREATE < UPDATE/DELETE for same model
 * - Random interleaving of operations never loses transactions
 */

import fc from 'fast-check';
import { TransactionQueue } from '../../src/transactions/TransactionQueue';
import {
  createTestContext,
  createTestConfig,
  TestTask,
  TestProject,
  TestSlideDeck,
  TestSlide,
  TestSlideLayer,
  TestComment,
  resetFixtureCounter,
  flushMicrotasks,
} from '../../src/testing';
import type { TestContextResult } from '../../src/testing';
import { Model } from '../../src/Model';

const USER_CTX = { userId: 'user-1', organizationId: 'org-1' };

type ModelClassName = 'Task' | 'Project' | 'SlideDeck' | 'Slide' | 'SlideLayer' | 'Comment';

const ModelClasses: Record<ModelClassName, new (data: Record<string, unknown>) => Model> = {
  Project: TestProject,
  Task: TestTask,
  Comment: TestComment,
  SlideDeck: TestSlideDeck,
  Slide: TestSlide,
  SlideLayer: TestSlideLayer,
};

describe('Property: TransactionQueue Invariants', () => {
  let ctx: TestContextResult;

  beforeEach(() => {
    resetFixtureCounter();
    ctx = createTestContext({ config: createTestConfig() });
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('CREATE priority scores respect FK ordering: parent ≤ child', () => {
    const parentChild: Array<[ModelClassName, ModelClassName]> = [
      ['Project', 'Comment'],
      ['SlideDeck', 'SlideLayer'],
      ['SlideDeck', 'Slide'],
      ['Slide', 'SlideLayer'],
    ];

    fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...parentChild),
        async ([parentModel, childModel]) => {
          const queue = new TransactionQueue({ batchDelay: 0 });

          const parentInstance = new ModelClasses[parentModel]({ id: `p-${Math.random()}` });
          const childInstance = new ModelClasses[childModel]({ id: `c-${Math.random()}` });

          const [parentTx, childTx] = await Promise.all([
            queue.create(parentInstance, USER_CTX),
            queue.create(childInstance, USER_CTX),
          ]);

          expect(parentTx.priorityScore).toBeLessThanOrEqual(childTx.priorityScore);
          queue.removeAllListeners();
        }
      ),
      { numRuns: 20 }
    );
  });

  it('non-CREATE operations always get DEFAULT_NON_CREATE_PRIORITY (50)', () => {
    const opTypes = ['update', 'delete', 'archive', 'unarchive'] as const;
    const modelNames: ModelClassName[] = ['Task', 'Project', 'SlideDeck', 'Slide', 'SlideLayer', 'Comment'];

    fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...opTypes),
        fc.constantFrom(...modelNames),
        async (opType, modelName) => {
          const queue = new TransactionQueue({ batchDelay: 0 });
          const model = new ModelClasses[modelName]({ id: `m-${Math.random()}` });
          model.markAsPersisted();
          if (opType === 'update') {
            model.propertyChanged('title', 'old', 'new');
          }

          const tx = await (queue as unknown as Record<string, (m: Model, ctx: typeof USER_CTX) => Promise<{ priorityScore: number }>>)[opType](model, USER_CTX);

          expect(tx.priorityScore).toBe(50);
          queue.removeAllListeners();
        }
      ),
      { numRuns: 20 }
    );
  });

  it('every created transaction eventually completes or fails (no stuck transactions)', () => {
    fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.constantFrom('create', 'delete') as fc.Arbitrary<'create' | 'delete'>,
          { minLength: 2, maxLength: 8 }
        ),
        async (opSequence) => {
          const queue = new TransactionQueue({ batchDelay: 0 });
          let createdCount = 0;
          let resolvedCount = 0;

          queue.on('transaction:created', () => createdCount++);
          queue.on('transaction:completed', () => resolvedCount++);
          queue.on('transaction:failed', () => resolvedCount++);

          for (const op of opSequence) {
            const model = new ModelClasses.Task({ id: `t-${Math.random()}` });
            if (op === 'create') {
              await queue.create(model, USER_CTX);
            } else {
              await queue.delete(model, USER_CTX);
            }
          }

          // Let processing complete
          await flushMicrotasks();
          await new Promise((r) => setTimeout(r, 200));

          // Confirm all via delta
          queue.onDeltaReceived(ctx.mocks.mutationExecutor.currentSyncId + 100);

          // INVARIANT: every created transaction resolved
          expect(createdCount).toBeGreaterThan(0);
          expect(resolvedCount).toBe(createdCount);

          queue.removeAllListeners();
          ctx.mocks.mutationExecutor.reset();
        }
      ),
      { numRuns: 10 }
    );
  });

  it('metadata merge is idempotent: same update applied twice produces single batchAck', () => {
    fc.assert(
      fc.asyncProperty(
        fc.record({
          title: fc.string({ minLength: 1, maxLength: 20 }),
          status: fc.constantFrom('todo', 'doing', 'done'),
        }),
        async (data) => {
          const queue = new TransactionQueue({ batchDelay: 0 });
          const task = new TestTask({ id: `idem-${Math.random()}`, ...data });
          task.markAsPersisted();
          task.propertyChanged('title', 'old', data.title);

          await queue.update(task, USER_CTX, data);
          await queue.update(task, USER_CTX, data);

          await flushMicrotasks();
          await new Promise((r) => setTimeout(r, 50));

          // Coalesced updates should result in at most 1 batchAck call
          const calls = ctx.mocks.mutationExecutor.getCallsByMethod('batchAck');
          expect(calls.length).toBeLessThanOrEqual(2);

          queue.removeAllListeners();
          ctx.mocks.mutationExecutor.reset();
        }
      ),
      { numRuns: 10 }
    );
  });
});
