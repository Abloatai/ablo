import { createModelFieldEditor } from '../modelFieldEditor.js';
import type { QueuedMutation } from '../../transactions/mutations/commitPayload.js';

test('editing stages one primary mutation, while value reads the normal row', async () => {
  let value = 'before';
  let accepted!: () => void;
  const confirmation = new Promise<void>((resolve) => { accepted = resolve; });
  const mutation: QueuedMutation = { id: 'one', type: 'update', modelName: 'Document', modelId: 'row', modelKey: 'documents',
    status: 'pending', attempts: 0, createdAt: 1, priority: 'normal', priorityScore: 0, context: { userId: 'human', organizationId: 'org' }, confirmation };
  const editor = createModelFieldEditor({
    value: () => value, error: () => null,
    stage: async (operation: string) => { value = operation; return mutation; },
    refresh: async () => undefined, flush: () => confirmation,
  });
  await editor.edit('local');
  expect(editor.value).toBe('local');
  value = 'rebased primary row';
  expect(editor.value).toBe('rebased primary row');
  editor.dispose();
  accepted();
  await expect(editor.edit('after disposal')).rejects.toThrow('disposed');
  await expect(confirmation).resolves.toBeUndefined();
});

test('the helper exposes primary confirmation failures instead of retaining another optimistic ledger', async () => {
  let reject!: (error: Error) => void;
  const confirmation = new Promise<void>((_resolve, failure) => { reject = failure; });
  const mutation: QueuedMutation = { id: 'one', type: 'update', modelName: 'Document', modelId: 'row', modelKey: 'documents',
    status: 'pending', attempts: 0, createdAt: 1, priority: 'normal', priorityScore: 0, context: { userId: 'human', organizationId: 'org' }, confirmation };
  const editor = createModelFieldEditor({ value: () => 'primary row', error: () => null,
    stage: async (_operation: string) => mutation, refresh: async () => undefined, flush: async () => undefined });
  await editor.edit('intent');
  const error = new Error('The queued basis is unavailable');
  reject(error);
  await expect(editor.flush()).rejects.toBe(error);
  expect(editor.error).toBe(error);
  expect(editor.value).toBe('primary row');
  await expect(editor.flush()).rejects.toBe(error);
  await editor.refresh();
  await expect(editor.flush()).resolves.toBeUndefined();
  expect(editor.error).toBeNull();
});

test('a failed refresh during flush can recover without a rejected primary write', async () => {
  let offline = true;
  const editor = createModelFieldEditor({ value: () => 'primary row', error: () => null,
    stage: async (_operation: string): Promise<QueuedMutation> => { throw new Error('unused'); },
    refresh: async () => { if (offline) throw new TypeError('fetch failed'); }, flush: async () => undefined });
  await expect(editor.flush()).rejects.toThrow('fetch failed');
  offline = false;
  await expect(editor.flush()).resolves.toBeUndefined();
  expect(editor.error).toBeNull();
});
