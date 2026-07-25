/**
 * Stream-recorded undo baseline — successive updates to the same field before
 * a sync-ack.
 *
 * `Model.propertyChanged` is first-old-wins and `modifiedProperties` is only
 * cleared on sync-ack. Stream-based undo (`recordFromStream`) derives a move's
 * inverse from the `previousData` the queue freezes at commit time, which reads
 * `modifiedProperties[field].old`. So a SECOND update to the same field before
 * the first acks must NOT re-capture the original pre-session value — otherwise
 * the second op's "before" points all the way back to the start (the deck
 * "moving a layer twice then Cmd+Z jumps it home" bug).
 *
 * The queue re-baselines the consumed fields right after freezing `previousData`
 * (mirroring `RecordingMutation.consumeModifiedFields`); this pins that the
 * second transaction's `previousData` reflects the FIRST update's result.
 */

import {
  MutationQueue,
  type QueuedMutation,
  type UserContext,
} from '../mutations/MutationQueue.js';
import { createTestContext } from '../../testing/mocks/MockSyncContext.js';
import type { TestContextResult } from '../../testing/mocks/MockSyncContext.js';
import { createTaskFixture } from '../../testing/fixtures/models.js';
import { waitFor } from '../../testing/helpers/wait.js';

describe('MutationQueue update previousData re-baselining', () => {
  let ctx: TestContextResult;
  let queue: MutationQueue;
  let seen: QueuedMutation[];
  const userContext: UserContext = { userId: 'user_1', organizationId: 'org_1' };

  beforeEach(() => {
    ctx = createTestContext();
    queue = new MutationQueue({ enablePersistence: false });
    seen = [];
    queue.on('transaction:created', (tx) => seen.push(tx));
  });

  // Drain the staged commit so the next update can't COALESCE into the prior
  // still-pending transaction (mergeUpdateData mutates its `data` in place).
  // This drains the local commit lane only — it does NOT simulate a sync-ack,
  // so `modifiedProperties` stays dirty, which is exactly the window the fix
  // targets (two commits of the same field before the server acks the first).
  const flushCommit = (count: number) =>
    waitFor(
      () =>
        ctx.mocks.mutationExecutor.getCallsByMethod('commit').length >= count,
    );

  afterEach(() => {
    queue.dispose?.();
    ctx.cleanup();
  });

  it('captures the prior commit as the baseline for a second update before ack', async () => {
    const task = createTaskFixture({ title: 'A' });
    task.markAsPersisted();

    // First move A -> B (the direct write the editor performs routes to
    // propertyChanged exactly like this).
    task.propertyChanged('title', 'A', 'B');
    await queue.update(task, userContext);
    await flushCommit(1);

    // No sync-ack yet — `modifiedProperties` is intentionally NOT cleared.
    // Second move B -> C.
    task.propertyChanged('title', 'B', 'C');
    await queue.update(task, userContext);
    await flushCommit(2);

    const updates = seen.filter((t) => t.type === 'update');
    expect(updates).toHaveLength(2);
    const [firstUpdate, secondUpdate] = updates;
    if (!firstUpdate || !secondUpdate) throw new Error('expected two update transactions');

    expect(firstUpdate.data).toMatchObject({ title: 'B' });
    expect(firstUpdate.previousData).toMatchObject({ title: 'A' });

    expect(secondUpdate.data).toMatchObject({ title: 'C' });
    // The fix: 'B', not the stale pre-session 'A'.
    expect(secondUpdate.previousData).toMatchObject({ title: 'B' });
  });

  it('leaves untouched fields out of a partial update and keeps their baseline', async () => {
    const task = createTaskFixture({ title: 'A', status: 'todo' });
    task.markAsPersisted();

    // Update only `title`; `status` is also dirty from an earlier in-place edit.
    task.propertyChanged('status', 'todo', 'doing');
    task.propertyChanged('title', 'A', 'B');
    await queue.update(task, userContext, { title: 'B' });

    const first = seen.filter((t) => t.type === 'update').at(-1)!;
    // Only the patched key is inverted — `status` must not leak in.
    expect(first.previousData).toMatchObject({ title: 'A' });
    expect((first.previousData as Record<string, unknown>).status).toBeUndefined();

    // `status` baseline survived: committing it now still inverts to 'todo'.
    await queue.update(task, userContext, { status: 'doing' });
    const second = seen.filter((t) => t.type === 'update').at(-1)!;
    expect(second.previousData).toMatchObject({ status: 'todo' });
  });

  it('captures a revertible previousData from the original snapshot when a key was not pre-mutated', async () => {
    const task = createTaskFixture({ title: 'Loaded', status: 'todo' });
    // The loaded/acked baseline — no in-place mutation precedes this write.
    task.markAsPersisted();

    // Precomputed-changes write (no propertyChanged first) — modifiedProperties
    // is empty, so the OLD path would emit an empty previousData and
    // buildUndoOps would null the inverse (un-undoable). The originalSnapshot
    // fallback must supply the before-image instead.
    await queue.update(task, userContext, { title: 'Renamed' });

    const tx = seen.filter((t) => t.type === 'update').at(-1)!;
    expect(tx.data).toMatchObject({ title: 'Renamed' });
    expect(tx.previousData).toMatchObject({ title: 'Loaded' });
    // Only the written key — the inverse must not reach into untouched fields.
    expect((tx.previousData as Record<string, unknown>).status).toBeUndefined();
  });
});
