import { MutationQueue } from '../../src/local/transactions/mutations/MutationQueue';
import { createTestContext, createItemFixture, type TestContextResult } from '../../src/local/testing';
import { waitFor } from '../../src/local/testing/helpers/wait';
import type { MutationExecutor, MutationOperation } from '../../src/local/interfaces/index';
import { confirmedCommitAck } from '@abloatai/transaction/testing/fixtures/httpResponses';

const user = { userId: 'user-1', organizationId: 'org-1' };

describe('primary model batch aggregation', () => {
  let queue: MutationQueue;
  let context: TestContextResult;
  const useCommit = (commit: MutationExecutor['commit']) => queue.setMutationExecutor({
    commit, executeCreate: async () => undefined, executeUpdate: async () => null,
    executeDelete: async () => undefined, executeArchive: async () => undefined, executeUnarchive: async () => undefined,
  });
  beforeEach(() => {
    context = createTestContext();
    queue = new MutationQueue({ batchDelay: 60_000, enablePersistence: false });
  });
  afterEach(() => { queue.dispose(); context.cleanup(); });

  it('keeps each source and before-image while dispatching one compatible row patch', async () => {
    const item = createItemFixture({ title: 'original', status: 'todo' });
    item.markAsPersisted();
    item.applyChanges({ title: 'first' });
    const first = await queue.update(item, user, { title: 'first' });
    item.applyChanges({ status: 'doing' });
    const second = await queue.update(item, user, { status: 'doing' });
    expect(queue.getOutstandingTransactions()).toEqual([first, second]);
    expect(first.data).toEqual({ title: 'first' });
    expect(first.previousData).toMatchObject({ title: 'original' });
    expect(second.previousData).toMatchObject({ status: 'todo' });
    await queue.drainPending();
    await Promise.all([first.confirmation, second.confirmation]);
    const calls = context.mocks.mutationExecutor.getCallsByMethod('commit');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.operations).toHaveLength(1);
    expect(calls[0]?.operations?.[0]?.input).toEqual({ title: 'first', status: 'doing' });
    expect(first.data).toEqual({ title: 'first' });
    expect(second.data).toEqual({ status: 'doing' });
    expect(first.status).toBe('completed');
    expect(second.status).toBe('completed');
  });

  it('retains and confirms ordinary edits staged while an earlier request is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: MutationOperation[][] = [];
    useCommit(async (operations) => {
      calls.push(structuredClone(operations));
      if (calls.length === 1) await gate;
      return confirmedCommitAck(calls.length);
    });
    const item = createItemFixture({ title: 'original', status: 'todo' });
    item.markAsPersisted();
    const first = await queue.update(item, user, { title: 'first' });
    const draining = queue.drainPending();
    await waitFor(() => calls.length === 1);
    const second = await queue.update(item, user, { title: 'second' });
    const third = await queue.update(item, user, { status: 'done' });
    expect(queue.getOutstandingTransactions()).toEqual([first, second, third]);
    expect(calls[0]?.[0]?.input).toEqual({ title: 'first' });
    release();
    await draining;
    await Promise.all([first.confirmation, second.confirmation, third.confirmation]);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toHaveLength(1);
    expect(calls[1]?.[0]?.input).toEqual({ title: 'second', status: 'done' });
    expect(queue.getOutstandingTransactions()).toHaveLength(0);
  });

  it('preserves whole-field JSON replacement instead of merging a specially named field', async () => {
    const item = createItemFixture();
    const first = await queue.update(item, user, { metadata: { left: 1 } });
    const second = await queue.update(item, user, { metadata: { right: 2 } });
    await queue.drainPending();
    await Promise.all([first.confirmation, second.confirmation]);
    const call = context.mocks.mutationExecutor.getCallsByMethod('commit')[0];
    expect(call?.operations?.[0]?.input?.metadata).toEqual({ right: 2 });
    expect(first.data?.metadata).toEqual({ left: 1 });
  });

  it('keeps same-row decision premises in separate requests', async () => {
    const item = createItemFixture();
    const first = await queue.update(item, user, { title: 'first' }, { readAt: 11 });
    const second = await queue.update(item, user, { title: 'second' }, { readAt: 12 });
    await queue.drainPending();
    await Promise.all([first.confirmation, second.confirmation]);
    const calls = context.mocks.mutationExecutor.getCallsByMethod('commit');
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.operations?.[0]?.readAt)).toEqual([11, 12]);
  });
});
