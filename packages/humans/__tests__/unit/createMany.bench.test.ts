/**
 * Performance benchmark — quantifies the microtask coalescer.
 *
 * Compares two ways of staging N creates:
 *
 *   sequential — `for (const m of models) await queue.create(m)`
 *     Every `await` is a microtask boundary, so the commit microtask
 *     fires between every call. This produces N wire commits.
 *
 *   parallel   — `await Promise.all(models.map((m) => queue.create(m)))`
 *     All creates push synchronously. The commit microtask sees N
 *     staged transactions and collapses them into ONE wire commit
 *     with one `batchIndex`.
 *
 * Reports throughput at N = 10, 100, 1000, 10000 and asserts the
 * coalescing invariants. Companion to the cleanup that routed the
 * SDK's `useMutate.create([rows])` overload through `Promise.all`.
 */

import { MutationQueue } from '../../src/local/transactions/mutations/MutationQueue';
import {
  createTestContext,
  createTaskFixture,
  resetFixtureCounter,
  flushMicrotasks,
} from '../../src/local/testing';

const TEST_USER_CONTEXT = {
  userId: 'user-bench',
  organizationId: 'org-bench',
};

interface BenchResult {
  pattern: 'sequential' | 'parallel';
  n: number;
  wallMs: number;
  perOpUs: number;
  microtaskCommits: number;
}

async function bench(
  pattern: 'sequential' | 'parallel',
  n: number,
): Promise<BenchResult> {
  resetFixtureCounter();
  const ctx = createTestContext({ config: {} });
  const queue = new MutationQueue({ batchDelay: 0, maxBatchSize: n + 10 });

  let microtaskCommits = 0;
  interface CommitInternals { commitCreatedTransactions: () => void; createdTransactions: unknown[] }
  const internals = queue as unknown as CommitInternals;
  const origCommit = internals.commitCreatedTransactions.bind(queue);
  internals.commitCreatedTransactions = () => {
    if (internals.createdTransactions.length > 0) microtaskCommits++;
    origCommit();
  };

  const tasks = Array.from({ length: n }, (_, i) =>
    createTaskFixture({ title: `task-${i}`, status: 'todo' }),
  );

  const start = performance.now();
  if (pattern === 'sequential') {
    for (const t of tasks) await queue.create(t, TEST_USER_CONTEXT);
  } else {
    await Promise.all(tasks.map((t) => queue.create(t, TEST_USER_CONTEXT)));
  }
  await flushMicrotasks();
  const wallMs = performance.now() - start;

  queue.removeAllListeners();
  ctx.cleanup();

  return {
    pattern,
    n,
    wallMs,
    perOpUs: (wallMs * 1000) / n,
    microtaskCommits,
  };
}

describe('createMany hot-path benchmark', () => {
  it('parallel pattern collapses N creates into 1 microtask commit', async () => {
    const ns = [10, 100, 1000, 10000];
    const rows: BenchResult[] = [];
    for (const pattern of ['sequential', 'parallel'] as const) {
      for (const n of ns) {
        rows.push(await bench(pattern, n));
      }
    }

     
    console.log('\n┌──────────────┬─────────┬──────────┬──────────┬────────────────────┐');
    console.log('│ pattern      │       N │  wallMs  │ perOp µs │ microtask commits  │');
    console.log('├──────────────┼─────────┼──────────┼──────────┼────────────────────┤');
    for (const r of rows) {
      console.log(
        `│ ${r.pattern.padEnd(12)} │ ${String(r.n).padStart(7)} │ ${r.wallMs.toFixed(2).padStart(8)} │ ${r.perOpUs.toFixed(2).padStart(8)} │ ${String(r.microtaskCommits).padStart(18)} │`,
      );
    }
    console.log('└──────────────┴─────────┴──────────┴──────────┴────────────────────┘');

    console.log('\nspeed-up (parallel vs sequential):');
    for (const n of ns) {
      const seq = rows.find((r) => r.pattern === 'sequential' && r.n === n)!;
      const par = rows.find((r) => r.pattern === 'parallel' && r.n === n)!;
      const speedup = seq.wallMs / par.wallMs;
      console.log(
        `  N=${String(n).padStart(5)}  ${speedup.toFixed(2)}× faster  (${seq.wallMs.toFixed(1)}ms → ${par.wallMs.toFixed(1)}ms,  ${seq.microtaskCommits} → ${par.microtaskCommits} wire commits)`,
      );
    }
    console.log('');
     

    for (const r of rows) {
      if (r.pattern === 'parallel') {
        // The whole point: N synchronous pushes → ONE microtask commit.
        expect(r.microtaskCommits).toBe(1);
      } else {
        // Sequential await re-arms the microtask between every call.
        expect(r.microtaskCommits).toBe(r.n);
      }
    }
  }, 60000);
});
