/**
 * Teardown timer hygiene (T1.19-SDK) — `MutationQueue.dispose()` must
 * leave NO armed timers behind.
 *
 * Before this fix, dispose() cleared only `processTimer`: every in-flight
 * transaction's delta-confirmation timeout (30–120s) and the offline-grace
 * timer stayed armed, keeping Node processes alive and firing callbacks
 * against the already-cleared store.
 */
import { MutationQueue } from '../mutations/MutationQueue.js';
import type { QueuedMutation } from '../mutations/commitPayload.js';
import { DeltaConfirmationTracker } from '../mutations/deltaConfirmation.js';
import { LogPosition } from '../../logPosition.js';
import { createTestContext } from '../../testing/mocks/MockSyncContext.js';
import type { TestContextResult } from '../../testing/mocks/MockSyncContext.js';

function makeTx(id: string): QueuedMutation {
  return {
    id,
    type: 'update',
    modelName: 'Item',
    modelId: `model_${id}`,
    modelKey: 'item',
    context: { userId: 'user_1', organizationId: 'org_1' },
    status: 'awaiting_delta',
    createdAt: Date.now(),
    attempts: 0,
    priority: 'normal',
    priorityScore: 0,
    syncIdNeededForCompletion: 999,
  };
}

describe('timer teardown on dispose', () => {
  let ctx: TestContextResult;

  beforeEach(() => {
    jest.useFakeTimers();
    ctx = createTestContext();
  });

  afterEach(() => {
    ctx.cleanup();
    jest.useRealTimers();
  });

  it('DeltaConfirmationTracker.dispose clears every armed confirmation timer', () => {
    const emit = jest.fn();
    const txs = new Map<string, QueuedMutation>([
      ['tx_1', makeTx('tx_1')],
      ['tx_2', makeTx('tx_2')],
    ]);
    const tracker = new DeltaConfirmationTracker({
      store: {
        get: (id) => txs.get(id),
        getByStatus: (status) => [...txs.values()].filter((t) => t.status === status),
        updateStatus: (id, status) => {
          const tx = txs.get(id);
          if (tx) tx.status = status;
        },
      },
      optimisticUpdates: new Map(),
      emit,
      isConnected: () => true,
      position: new LogPosition(),
    });

    const base = jest.getTimerCount();
    tracker.scheduleDeltaConfirmationTimeout(txs.get('tx_1')!, 30_000);
    tracker.scheduleDeltaConfirmationTimeout(txs.get('tx_2')!, 30_000);
    expect(jest.getTimerCount()).toBe(base + 2);

    tracker.dispose();
    expect(jest.getTimerCount()).toBe(base);

    // Nothing fires against the (would-be cleared) store after dispose.
    jest.advanceTimersByTime(10 * 60_000);
    expect(emit).not.toHaveBeenCalled();
  });

  it('MutationQueue.dispose clears the commit offline-grace timer', () => {
    const queue = new MutationQueue({ enablePersistence: false });
    const base = jest.getTimerCount();

    queue.setConnectionState('disconnected');
    expect(jest.getTimerCount()).toBe(base + 1);

    queue.dispose();
    expect(jest.getTimerCount()).toBe(base);

    // The grace callback must not fire post-dispose.
    expect(() => { jest.advanceTimersByTime(10 * 60_000); }).not.toThrow();
  });
});
