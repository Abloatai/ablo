import { ModelOperationRuntime } from '../operations/index.js';
import type { QueuedMutation } from '../mutations/commitPayload.js';
import type { AppliedChange } from '../../../plugin.js';
import { fieldIntentSchema } from '../operations/intent.js';

const textBase = { epoch: 'text', version: 0, value: 'ab' };
const counterBase = { epoch: 'counter', version: 0, value: 0 };
const textEdit = { id: 'remote-text', epoch: 'text', version: 1, operation: ['X'] };
const counterEdit = { id: 'remote-counter', epoch: 'counter', version: 1, operation: 3 };
const textRow = { action: 'update', modelName: 'Document', modelId: 'text-row', data: { body: 'Xab' },
  operation: { id: textEdit.id, epoch: 'text', version: 1, kind: 'text', field: 'body' } } satisfies AppliedChange;
const counterRow = { action: 'update', modelName: 'Counter', modelId: 'counter-row', data: { count: 3 },
  operation: { id: counterEdit.id, epoch: 'counter', version: 1, kind: 'counter', field: 'count' } } satisfies AppliedChange;
const metadata = (model: string) => ({ loadStrategy: 'instant' as const, fields: model === 'Document'
  ? { body: { type: 'string' as const, merge: 'text' as const } } : { count: { type: 'number' as const, merge: 'counter' as const } } });
function pending(id: string, model: string, row: string, data: Record<string, unknown>): QueuedMutation {
  return { id, type: 'update', modelName: model, modelId: row, modelKey: model.toLowerCase(), data,
    context: { userId: 'human', organizationId: 'org' }, status: 'pending', createdAt: 1,
    attempts: 0, priority: 'normal', priorityScore: 0 };
}

test('a history read ahead of the frame cannot publish or cache its future edit', async () => {
  const publish = jest.fn();
  const runtime = new ModelOperationRuntime({ metadata, pending: () => [], publish,
    read: async () => ({ base: textBase, edits: [textEdit, { ...textEdit, id: 'future', version: 2, operation: ['Y'] }] }) });
  runtime.retain({ model: 'Document', id: 'text-row', field: 'body' });
  const apply = jest.fn();
  await runtime.withAcceptedBatch([textRow, { action: 'verify', modelName: 'Document', modelId: 'text-row' }], apply);
  expect(apply.mock.calls[0]?.[0].get(JSON.stringify(['Document', 'text-row']))).toEqual({ body: 'Xab' });
  expect(publish).not.toHaveBeenCalled();
  await runtime.stageLocal('text', { model: 'Document', id: 'text-row', field: 'body' }, [1, 'L'], 'Xab', async (value, input, intent) => {
    expect(value).toBe('XLab');
    expect(intent.context.snapshot.version).toBe(1);
    return pending('local', 'Document', 'text-row', input);
  });
});

test('a received frame waits for all histories and projects the latest primary pending records once', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const transactions = [pending('local-text', 'Document', 'text-row', { body: { $text: { id: 'local-text', epoch: 'text', baseVersion: 0, operation: ['L'] } } }),
    pending('local-counter', 'Counter', 'counter-row', { count: { $increment: { id: 'local-counter', epoch: 'counter', baseVersion: 0, operation: 2 } } })];
  const events: string[] = [];
  const runtime = new ModelOperationRuntime({ metadata, pending: () => transactions, publish: () => { events.push('row'); },
    read: async (kind) => {
      if (kind === 'text') return { base: textBase, edits: [textEdit] };
      await gate; return { base: counterBase, edits: [counterEdit] };
    } });
  const apply = jest.fn((_patches: ReadonlyMap<string, Record<string, unknown>>) => { events.push('batch'); });
  const applying = runtime.withAcceptedBatch([textRow, counterRow], apply);
  const reconciling = runtime.reconcile('Document', 'text-row');
  await Promise.resolve();
  expect(events).toEqual([]);
  transactions.push(pending('later', 'Counter', 'counter-row', { count: { $increment: { id: 'later', epoch: 'counter', baseVersion: 0, operation: 4 } } }));
  release();
  await applying;
  await reconciling;
  const patches = apply.mock.calls[0]?.[0];
  expect(patches?.get(JSON.stringify(['Document', 'text-row']))).toEqual({ body: 'XLab' });
  expect(patches?.get(JSON.stringify(['Counter', 'counter-row']))).toEqual({ count: 9 });
  expect(events).toEqual(['batch', 'row']);
});

test('clearing the operation session prevents a delayed frame from revealing revoked rows', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const runtime = new ModelOperationRuntime({ metadata, pending: () => [],
    read: async () => { await gate; return { base: textBase, edits: [textEdit] }; } });
  runtime.retain({ model: 'Document', id: 'text-row', field: 'body' });
  const apply = jest.fn();
  const applying = runtime.withAcceptedBatch([textRow], apply);
  const reconciling = runtime.reconcile('Document', 'text-row');
  runtime.clear();
  release();
  await expect(applying).resolves.toBe(true);
  await expect(reconciling).resolves.toBeNull();
  expect(apply).not.toHaveBeenCalled();
});

test('an unproved accepted reference holds the entire frame and keeps primary intent unchanged', async () => {
  const transactions = [pending('local', 'Document', 'text-row', { body: { $text: { id: 'local', epoch: 'text', baseVersion: 0, operation: ['L'] } } })];
  const before = structuredClone(transactions);
  const publish = jest.fn();
  const runtime = new ModelOperationRuntime({ metadata, pending: () => transactions, publish,
    read: async () => ({ base: textBase, edits: [textEdit] }) });
  const apply = jest.fn();
  const applying = runtime.withAcceptedBatch([{ ...textRow, operation: { ...textRow.operation, id: 'fork' } }], apply);
  const reconciling = runtime.reconcile('Document', 'text-row');
  void reconciling.catch(() => undefined);
  await expect(applying).rejects.toMatchObject({ code: 'stale_context' });
  await expect(reconciling).rejects.toMatchObject({ code: 'stale_context' });
  expect(apply).not.toHaveBeenCalled();
  expect(transactions).toEqual(before);
  expect(publish).not.toHaveBeenCalled();
  await runtime.withAcceptedBatch([textRow], apply);
  expect(apply).toHaveBeenCalledTimes(1);
});

test('an accepted own ancestor after the frame remains a proved optimistic dependency', async () => {
  const child = pending('child', 'Document', 'text-row', { body: { $text: { id: 'child', epoch: 'text', baseVersion: 0, operation: [1, 'B'] } } });
  child.fieldIntent = fieldIntentSchema.parse({ kind: 'text', field: 'body', editId: 'child', context: {
    snapshot: textBase, pending: [{ id: 'parent', operation: ['A'] }, { id: 'child', operation: [1, 'B'] }],
  } });
  const runtime = new ModelOperationRuntime({ metadata, pending: () => [child], read: async () => ({ base: textBase,
    edits: [textEdit, { id: 'parent', epoch: 'text', version: 2, operation: [1, 'A'] }] }) });
  runtime.retain({ model: 'Document', id: 'text-row', field: 'body' });
  const apply = jest.fn();
  await runtime.withAcceptedBatch([textRow], apply);
  expect(apply.mock.calls[0]?.[0].get(JSON.stringify(['Document', 'text-row']))).toEqual({ body: 'XABab' });
  await runtime.stageLocal('text', { model: 'Document', id: 'text-row', field: 'body' }, [3, 'C'], 'XABab', async (value, input) => {
    expect(value).toBe('XABCab');
    return pending('next', 'Document', 'text-row', input);
  });
});
