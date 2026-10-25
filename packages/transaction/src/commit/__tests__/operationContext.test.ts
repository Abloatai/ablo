import { textDomain } from '../text/domain.js';
import { counterDomain } from '../counter/index.js';
import { reconcileOperation, foldOperationHistory } from '../operations/history.js';
import { appendContextOperation, appendIndependentOperation, prepareContextOperation, rebaseOperationContext } from '../operations/context.js';

const base = { epoch: 'epoch', version: 0, value: 'ab' };

test('a queued descendant acquires the actual parent revision after an interleaved remote edit', () => {
  let context = { snapshot: base, pending: [] as { id: string; operation: (string | number | { d: string | number })[] }[] };
  context = appendContextOperation(textDomain, context, 'parent', ['L']);
  context = appendContextOperation(textDomain, context, 'child', [1, 'C']);
  const restored = JSON.parse(JSON.stringify(context));
  const remote = { id: 'remote', epoch: 'epoch', version: 1, operation: ['R'] };
  let history = { base, edits: [remote] };
  const parent = prepareContextOperation(textDomain, context, history, 'parent');
  expect(parent).toMatchObject({ baseVersion: 1, operation: [1, 'L'] });
  const sealed = structuredClone(parent);
  history = { ...history, edits: [...history.edits, reconcileOperation(textDomain, history, parent, 'Rab')] };
  const child = prepareContextOperation(textDomain, restored, history, 'child');
  expect(child).toMatchObject({ baseVersion: 2, operation: [2, 'C'] });
  const accepted = reconcileOperation(textDomain, history, child, 'RLab');
  expect(textDomain.apply('RLab', accepted.operation)).toBe('RLCab');
  expect(parent).toEqual(sealed);
  expect(context.pending.map((edit) => edit.operation)).toEqual([['L'], [1, 'C']]);
});

test('accepted ancestors can be consumed after several local edits were journaled', () => {
  let context = appendContextOperation(textDomain, { snapshot: base, pending: [] }, 'one', ['1']);
  context = appendContextOperation(textDomain, context, 'two', [1, '2']);
  context = appendContextOperation(textDomain, context, 'three', [2, '3']);
  let history = { base, edits: [] as { id: string; epoch: string; version: number; operation: (string | number | { d: string | number })[] }[] };
  for (const id of ['one', 'two', 'three']) {
    const edit = prepareContextOperation(textDomain, context, history, id);
    const head = foldOperationHistory(textDomain, history);
    history.edits.push(reconcileOperation(textDomain, history, edit, head.value));
  }
  expect(rebaseOperationContext(textDomain, context, history)).toEqual({ snapshot: { ...base, version: 3, value: '123ab' }, pending: [] });
});

test('independent versioned writes compose with context without treating their positions as sequential', () => {
  const history = { base, edits: [] };
  let context = appendContextOperation(textDomain, { snapshot: base, pending: [] }, 'local', ['L']);
  context = appendIndependentOperation(textDomain, context, history, { id: 'independent', epoch: 'epoch', baseVersion: 0, operation: [1, 'I'] });
  expect(context.pending[1]?.operation).toEqual([2, 'I']);
});

test('a missing predecessor, expired history or corrupt snapshot preserves the original recovery context', () => {
  const context = appendContextOperation(textDomain, appendContextOperation(textDomain, { snapshot: base, pending: [] }, 'parent', ['L']), 'child', [1, 'C']);
  const original = structuredClone(context);
  expect(() => prepareContextOperation(textDomain, context, { base, edits: [] }, 'child')).toThrow('earlier local edit');
  expect(() => rebaseOperationContext(textDomain, context, { base: { ...base, version: 5 }, edits: [] })).toThrow('unavailable');
  expect(() => rebaseOperationContext(textDomain, { ...context, snapshot: { ...base, value: 'wrong' } }, { base, edits: [] })).toThrow('disagrees');
  expect(context).toEqual(original);
});

test('counter descendants use the same context and preserve concurrent increments', () => {
  const base = { epoch: 'counter', version: 0, value: 10 };
  let context = appendContextOperation(counterDomain, { snapshot: base, pending: [] }, 'parent', 2);
  context = appendContextOperation(counterDomain, context, 'child', 3);
  let history = { base, edits: [{ id: 'remote', epoch: 'counter', version: 1, operation: 7 }] };
  const parent = prepareContextOperation(counterDomain, context, history, 'parent');
  history.edits.push(reconcileOperation(counterDomain, history, parent, 17));
  expect(prepareContextOperation(counterDomain, context, history, 'child')).toMatchObject({ baseVersion: 2, operation: 3 });
});
