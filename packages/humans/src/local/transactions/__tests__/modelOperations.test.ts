import { ModelOperationRuntime } from '../operations/index.js';
import { takeNextExecutionBatch, enqueueTransaction } from '../mutations/executionQueue.js';
import type { QueuedMutation } from '../mutations/commitPayload.js';

const base = { epoch: 'epoch', version: 0, value: 'ab' };
const input = (id: string, operation: (string | number)[]) => ({ $text: { id, epoch: 'epoch', baseVersion: 0, operation } });
function transaction(id: string, data: Record<string, unknown>, modelId = 'row'): QueuedMutation {
  return { id, type: 'update', modelName: 'Document', modelId, modelKey: 'documents', data,
    context: { userId: 'human', organizationId: 'org' }, status: 'pending', createdAt: 1,
    attempts: 0, priority: 'normal', priorityScore: 0 };
}
function runtime(pending: QueuedMutation[] = [], read: (kind: 'text' | 'counter') => Promise<unknown> = async () => ({ base, edits: [] })) {
  return new ModelOperationRuntime({
    metadata: () => ({ loadStrategy: 'instant', fields: { body: { type: 'string', merge: 'text' }, count: { type: 'number', merge: 'counter' }, json: { type: 'json' } } }),
    pending: () => pending,
    read: (kind) => kind === 'counter' ? Promise.resolve({ base: { ...base, value: 0 }, edits: [] }) : read(kind),
  });
}

test('the primary pending queue projects over accepted history and keeps sealed input unchanged', async () => {
  const tx = transaction('local', { body: input('local', [1, 'L']) });
  const original = structuredClone(tx.data);
  const operations = runtime([tx], async () => ({ base, edits: [{ id: 'remote', epoch: 'epoch', version: 1, operation: ['R'] }] }));
  expect(await operations.reconcile('Document', 'row')).toEqual({ body: 'RaLb', count: 0 });
  expect(tx.data).toEqual(original);
});

test('ordinary JSON markers keep their value semantics', async () => {
  const operations = runtime();
  const patch = { json: input('ordinary-data', ['literal']) };
  expect(operations.hasOperations('Document', patch)).toBe(false);
  expect(await operations.materialize('Document', 'row', patch)).toEqual(patch);
});

test('staging preserves invocation order without waiting for earlier confirmation', async () => {
  let releaseRead!: () => void;
  const gate = new Promise<void>((resolve) => { releaseRead = resolve; });
  const pending: QueuedMutation[] = [];
  const operations = runtime(pending, async () => { await gate; return { base, edits: [] }; });
  const staged: string[] = [];
  let confirm!: () => void;
  const confirmation = new Promise<void>((resolve) => { confirm = resolve; });
  const first = operations.stage('Document', 'row', { body: input('local', ['L']) }, (patch) => {
    staged.push(String(patch.body));
    pending.push(transaction('local', { body: input('local', ['L']) }));
    return confirmation;
  });
  const second = operations.stage('Document', 'row', { title: 'later' }, () => { staged.push('later'); return Promise.resolve(); });
  releaseRead();
  await second;
  expect(staged).toEqual(['Lab', 'later']);
  confirm();
  await first;
});

test('a cleared session cannot apply a late read or a staged write', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const operations = runtime([], async () => { await gate; return { base, edits: [] }; });
  const apply = jest.fn(() => Promise.resolve());
  const writing = operations.stage('Document', 'row', { body: input('local', ['L']) }, apply);
  await Promise.resolve();
  operations.clear();
  release();
  await expect(writing).rejects.toThrow('session changed');
  expect(apply).not.toHaveBeenCalled();
});

test('relative operations stay distinct in primary queue and same-row batch selection', () => {
  const first = transaction('one', { body: input('one', ['A']) });
  const second = transaction('two', { body: input('two', ['B']) });
  const other = transaction('other', { title: 'ordinary' }, 'other-row');
  const executionQueue: QueuedMutation[] = [];
  const context = { executionQueue,
    ensureDerivedFields: () => undefined, scheduleProcessing: () => undefined };
  enqueueTransaction(context, first);
  enqueueTransaction(context, second);
  enqueueTransaction(context, other);
  expect(executionQueue).toEqual([first, second, other]);
  expect(takeNextExecutionBatch(executionQueue, 50)).toEqual({ batch: [first, other], remaining: [second] });
});

test('retry backoff cannot let a fresh same-row write overtake the sealed request', () => {
  const sealed = transaction('sealed', { title: 'earlier' });
  sealed.commitEnvelope = { idempotencyKey: 'request', operationIndex: 0, operationCount: 1 };
  const later = transaction('later', { title: 'later' });
  const other = transaction('other', { title: 'unrelated' }, 'other-row');
  expect(takeNextExecutionBatch([later, other], 50, [sealed, later, other])).toEqual({ batch: [other], remaining: [later] });
  expect(takeNextExecutionBatch([later, sealed], 50)).toEqual({ batch: [sealed], remaining: [later] });
});
