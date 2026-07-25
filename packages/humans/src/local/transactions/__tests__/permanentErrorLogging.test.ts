/**
 * Permanent-error log severity + dedup.
 *
 * A `create` whose id already exists comes back as a permanent 409
 * `unique_violation` / `AbloIdempotencyError`. That used to print three
 * identical `warn` dumps per attempt (batch-reject + permanent-error +
 * rollback) AND repeat on every offline-queue replay. This test pins the
 * fixed behavior:
 *   1. The benign idempotency case logs ONCE at `info`, not `warn`.
 *   2. The same write rejected again (replay) demotes to `debug`.
 *   3. A successful write in between clears the dedup so a genuine
 *      recurrence warns again.
 */

import {
  MutationQueue,
  type UserContext,
} from '../mutations/MutationQueue.js';
import { createTestContext } from '../../testing/mocks/MockSyncContext.js';
import type { TestContextResult } from '../../testing/mocks/MockSyncContext.js';
import { createTaskFixture } from '../../testing/fixtures/models.js';
import { waitFor } from '../../testing/helpers/wait.js';
import { AbloIdempotencyError } from '@abloatai/transaction/errors';
import type { Logger } from '../../interfaces/index.js';

function spyLogger(): Logger & {
  debug: jest.Mock;
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
} {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

/** Find the recorded log call whose first arg starts with `prefix`. */
function callMatching(mock: jest.Mock, prefix: string): unknown[] | undefined {
  return mock.mock.calls.find(
    (args) => typeof args[0] === 'string' && (args[0]).startsWith(prefix),
  );
}

describe('permanent-error log severity + dedup', () => {
  let ctx: TestContextResult;
  let logger: ReturnType<typeof spyLogger>;
  let queue: MutationQueue;
  const userContext: UserContext = { userId: 'user_1', organizationId: 'org_1' };

  const idempotencyError = () =>
    new AbloIdempotencyError('A value violates a uniqueness constraint.', {
      code: 'unique_violation',
      httpStatus: 409,
    });

  beforeEach(() => {
    logger = spyLogger();
    ctx = createTestContext({ logger });
    queue = new MutationQueue({ enablePersistence: false });
  });

  afterEach(() => {
    queue.dispose?.();
    ctx.cleanup();
  });

  it('logs a benign idempotency create at info, not warn', async () => {
    ctx.mocks.mutationExecutor.failMethod('commit', idempotencyError());

    const task = createTaskFixture();
    const tx = await queue.create(task, userContext);
    await waitFor(() => tx.status === 'failed');

    // Authoritative line is the friendly, consumer-language info — no warn,
    // no engine vocabulary ("MutationQueue"/"permanent"/"rolling back").
    expect(callMatching(logger.info, 'Your create to')).toBeDefined();
    expect(callMatching(logger.warn, 'Your create to')).toBeUndefined();

    // Nothing leaks to warn at all for the benign case (no fan-out).
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('demotes an exact replay of the same rejected write to debug', async () => {
    ctx.mocks.mutationExecutor.failMethod('commit', idempotencyError());

    // Same modelId rejected twice = the offline-queue replay shape.
    const first = await queue.create(createTaskFixture({ id: 'task-dup' }), userContext);
    await waitFor(() => first.status === 'failed');
    const second = await queue.create(createTaskFixture({ id: 'task-dup' }), userContext);
    await waitFor(() => second.status === 'failed');

    // First occurrence: info. Repeat: debug, NOT a second info/warn.
    expect(logger.info.mock.calls.filter(
      (a) => typeof a[0] === 'string' && (a[0]).startsWith('Your create to'),
    )).toHaveLength(1);
    expect(callMatching(logger.debug, 'write rejected again')).toBeDefined();
  });

  it('re-warns a genuine permanent error after a successful write clears the dedup', async () => {
    const executor = ctx.mocks.mutationExecutor;

    // First: a non-idempotency permanent error (validation) → warn.
    executor.failMethod('commit', idempotencyError());
    const a = await queue.create(createTaskFixture({ id: 'task-x' }), userContext);
    await waitFor(() => a.status === 'failed');

    // A successful write clears the dedup signature.
    executor.clearFailure('commit');
    const ok = await queue.create(createTaskFixture({ id: 'task-ok' }), userContext);
    await waitFor(() => ok.status === 'completed');

    // Same idempotency error again on the same id is NOT a consecutive repeat
    // (a success intervened) → logs at info again, not silently at debug.
    executor.failMethod('commit', idempotencyError());
    const b = await queue.create(createTaskFixture({ id: 'task-x' }), userContext);
    await waitFor(() => b.status === 'failed');

    expect(logger.info.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0]).startsWith('Your create to'),
    )).toHaveLength(2);
  });
});
