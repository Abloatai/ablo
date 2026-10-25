import { describe, expect, it } from '@jest/globals';
import { createTextResource, foldTextHistory, reconcileTextEdit, type TextHistory, type TextSessionState } from '../index.js';
import { AbloError } from '../../../errors.js';

const target = { model: 'docs', id: 'doc-1', field: 'body' };

function setup() {
  const history: TextHistory = { base: { epoch: 'base', version: 0, value: 'hello' }, edits: [] };
  const sent: string[] = [];
  let dropResponse = false;
  const resource = createTextResource({
    read: async () => structuredClone(history),
    async commit(_target, edit) {
      sent.push(edit.id);
      history.edits.push(reconcileTextEdit(history, edit, foldTextHistory(history).value));
      if (dropResponse) throw new Error('response lost');
    },
  });
  return { resource, history, sent, loseResponse: () => { dropResponse = true; } };
}

describe('text field resource over the existing commit transport', () => {
  it('retries history-read contention and disposes observation if initial persistence fails', async () => {
    let reads = 0;
    let subscriptions = 0;
    let notify = () => {};
    const { history } = setup();
    const resource = createTextResource({
      read: async () => {
        if (++reads === 1) throw new AbloError('busy', { code: 'decision_contended' });
        return structuredClone(history);
      },
      commit: async () => undefined,
      subscribe: (_target, invalidate) => { notify = invalidate; subscriptions++; return () => { subscriptions--; }; },
    });
    await expect(resource.open(target, { persist: async () => { throw new Error('disk unavailable'); } })).rejects.toThrow('disk unavailable');
    expect(reads).toBe(2);
    expect(subscriptions).toBe(0);
    expect(() => notify()).not.toThrow();
  });

  it('retries decision contention with the identical sealed operation', async () => {
    const history: TextHistory = { base: { epoch: 'base', version: 0, value: 'hello' }, edits: [] };
    const requests: unknown[] = [];
    const resource = createTextResource({
      read: async () => structuredClone(history),
      async commit(_target, edit) {
        requests.push(structuredClone(edit));
        if (requests.length === 1) throw new AbloError('busy', { code: 'decision_contended' });
        history.edits.push(reconcileTextEdit(history, edit, foldTextHistory(history).value));
      },
    });
    const field = await resource.open(target);
    await field.edit(['X']);
    await field.flush();
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(foldTextHistory(history).value).toBe('Xhello');
  });
  it('restores a saved in-flight request after a lost response without submitting its edit twice', async () => {
    const { resource, history, sent, loseResponse } = setup();
    let saved: TextSessionState | undefined;
    const field = await resource.open(target, { persist: async (state) => { saved = state; } });
    await field.edit(['X']);
    loseResponse();
    await expect(field.flush()).rejects.toThrow('response lost');
    expect(saved?.inFlight?.id).toBe(sent[0]);
    const restored = await resource.open(target, { state: saved });
    expect(restored.value).toBe('Xhello');
    await restored.flush();
    expect(sent).toHaveLength(1);
    expect(history.edits).toHaveLength(1);
    expect(restored.exportState().pending).toHaveLength(0);
  });

  it('never sends an edit whose local state could not be saved', async () => {
    const { resource, sent } = setup();
    let fail = false;
    const field = await resource.open(target, {
      persist: async () => { if (fail) throw new Error('storage unavailable'); },
    });
    fail = true;
    await expect(field.edit(['X'])).rejects.toThrow('storage unavailable');
    await expect(field.flush()).rejects.toThrow('storage unavailable');
    expect(sent).toHaveLength(0);
    expect(field.value).toBe('Xhello');
    fail = false;
    await field.flush();
    expect(sent).toHaveLength(1);
    expect(field.value).toBe('Xhello');
  });

  it('serializes simultaneous flushes and preserves buffered edits made during a request', async () => {
    const { resource, sent, history } = setup();
    const field = await resource.open(target);
    await field.edit(['X']);
    const first = field.flush();
    await field.edit([1, 'Y']);
    const second = field.flush();
    expect(second).toBe(first);
    await first;
    expect(foldTextHistory(history).value).toBe('XYhello');
    expect(sent).toHaveLength(2);
  });

  it('keeps the pending state when compaction removes the operations needed for reconciliation', async () => {
    const { resource, history } = setup();
    const field = await resource.open(target);
    await field.edit(['X']);
    const before = field.exportState();
    history.base = { epoch: 'base', version: 5, value: 'peer text' };
    await expect(field.refresh()).rejects.toMatchObject({ code: 'stale_context' });
    expect(field.exportState()).toEqual(before);
  });
});
