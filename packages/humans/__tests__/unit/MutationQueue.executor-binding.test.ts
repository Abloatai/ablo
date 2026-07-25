/**
 * MutationQueue per-instance executor binding — regression coverage
 * for the multi-Ablo singleton corruption bug.
 *
 * Before the fix: `mutationExecutor` was resolved via `getContext()`
 * on every commit. Since `initRuntime()` writes a module-level
 * `_context`, constructing a second Ablo (e.g. agent-worker's per-job
 * peer) overwrote the first Ablo's executor — and when the second Ablo
 * disposed, the first's commits routed through the second's dead
 * executor closure and threw `ws_not_ready` forever.
 *
 * See `feedback_initRuntime_singleton_executor.md` for full history.
 */

import { MutationQueue } from '../../src/local/transactions/mutations/MutationQueue';
import { initRuntime, resetRuntime } from '../../src/local/context.js';
import type { MutationExecutor } from '../../src/local/interfaces/index.js';

function makeExecutor(label: string): MutationExecutor {
  return {
    commit: jest.fn(async () => ({ lastSyncId: 0, label })) as MutationExecutor['commit'],
    executeCreate: jest.fn(async () => undefined) as MutationExecutor['executeCreate'],
    executeUpdate: jest.fn(async () => null) as MutationExecutor['executeUpdate'],
    executeDelete: jest.fn(async () => undefined) as MutationExecutor['executeDelete'],
    executeArchive: jest.fn(async () => undefined) as MutationExecutor['executeArchive'],
    executeUnarchive: jest.fn(async () => undefined) as MutationExecutor['executeUnarchive'],
  };
}

describe('MutationQueue — per-instance executor binding', () => {
  afterEach(() => {
    resetRuntime();
  });

  it('uses the executor bound via setMutationExecutor over the module-level singleton', () => {
    const singletonExecutor = makeExecutor('singleton');
    const instanceExecutor = makeExecutor('instance');

    initRuntime({
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      observability: { captureException: jest.fn(), breadcrumb: jest.fn(), startSpanAsync: jest.fn(), captureCommitZeroSyncId: jest.fn(), captureWebSocketError: jest.fn() },
      onlineStatus: { isOnline: () => true, subscribe: () => () => {} },
      sessionErrorDetector: { isSessionError: () => false },
      config: {} as never,
      mutationExecutor: singletonExecutor,
    } as never);

    const queue = new MutationQueue();
    queue.setMutationExecutor(instanceExecutor);

    const resolved = (queue as unknown as { mutationExecutor: MutationExecutor })
      .mutationExecutor;

    expect(resolved).toBe(instanceExecutor);
    expect(resolved).not.toBe(singletonExecutor);
  });

  it('falls back to the module-level executor when no per-instance binding is set', () => {
    const singletonExecutor = makeExecutor('singleton');

    initRuntime({
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      observability: { captureException: jest.fn(), breadcrumb: jest.fn(), startSpanAsync: jest.fn(), captureCommitZeroSyncId: jest.fn(), captureWebSocketError: jest.fn() },
      onlineStatus: { isOnline: () => true, subscribe: () => () => {} },
      sessionErrorDetector: { isSessionError: () => false },
      config: {} as never,
      mutationExecutor: singletonExecutor,
    } as never);

    const queue = new MutationQueue();
    const resolved = (queue as unknown as { mutationExecutor: MutationExecutor })
      .mutationExecutor;

    expect(resolved).toBe(singletonExecutor);
  });

  it('isolates two queues from each other across initRuntime() overwrites', () => {
    const executorA = makeExecutor('A');
    const executorB = makeExecutor('B');

    initRuntime({
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      observability: { captureException: jest.fn(), breadcrumb: jest.fn(), startSpanAsync: jest.fn(), captureCommitZeroSyncId: jest.fn(), captureWebSocketError: jest.fn() },
      onlineStatus: { isOnline: () => true, subscribe: () => () => {} },
      sessionErrorDetector: { isSessionError: () => false },
      config: {} as never,
      mutationExecutor: executorA,
    } as never);

    const queueA = new MutationQueue();
    queueA.setMutationExecutor(executorA);

    // Simulate the agent-worker pattern: a second Ablo constructs and
    // calls initRuntime, overwriting the singleton. Queue A should
    // be unaffected because it holds its own binding.
    initRuntime({
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      observability: { captureException: jest.fn(), breadcrumb: jest.fn(), startSpanAsync: jest.fn(), captureCommitZeroSyncId: jest.fn(), captureWebSocketError: jest.fn() },
      onlineStatus: { isOnline: () => true, subscribe: () => () => {} },
      sessionErrorDetector: { isSessionError: () => false },
      config: {} as never,
      mutationExecutor: executorB,
    } as never);

    const queueB = new MutationQueue();
    queueB.setMutationExecutor(executorB);

    const resolvedA = (queueA as unknown as { mutationExecutor: MutationExecutor })
      .mutationExecutor;
    const resolvedB = (queueB as unknown as { mutationExecutor: MutationExecutor })
      .mutationExecutor;

    expect(resolvedA).toBe(executorA);
    expect(resolvedB).toBe(executorB);
    expect(resolvedA).not.toBe(resolvedB);
  });
});
