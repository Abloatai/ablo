import { textDomain } from '../text/domain.js';
import { counterDomain } from '../counter/index.js';
import { invertAcceptedFieldEdit, projectFieldEdits } from '../operations/model.js';
import { reconcileOperation } from '../operations/history.js';

const base = { epoch: 'epoch', version: 0, value: 'ab' };

test('projects pending text over accepted collaborators without changing its sealed basis', () => {
  const pending = { id: 'local', epoch: 'epoch', baseVersion: 0, operation: [1, 'L'] };
  const history = { base, edits: [{ id: 'remote', epoch: 'epoch', version: 1, operation: ['R'] }] };
  const original = structuredClone(pending);
  expect(projectFieldEdits(textDomain, history, [pending])).toBe('RaLb');
  expect(pending).toEqual(original);
  const accepted = reconcileOperation(textDomain, history, pending, 'Rab');
  expect(projectFieldEdits(textDomain, { ...history, edits: [...history.edits, accepted] }, [pending])).toBe('RaLb');
});

test('an inverse uses the accepted edit position and preserves later contributions', () => {
  const history = { base, edits: [
    { id: 'remote', epoch: 'epoch', version: 1, operation: ['R'] },
    { id: 'local', epoch: 'epoch', version: 2, operation: [2, 'L'] },
    { id: 'later', epoch: 'epoch', version: 3, operation: ['Z'] },
  ] };
  const inverse = invertAcceptedFieldEdit(textDomain, history, 'local', 'undo');
  expect(inverse.baseVersion).toBe(2);
  expect(projectFieldEdits(textDomain, history, [inverse])).toBe('ZRab');
  const accepted = reconcileOperation(textDomain, history, inverse, 'ZRaLb');
  const undone = { ...history, edits: [...history.edits, accepted] };
  const redo = invertAcceptedFieldEdit(textDomain, undone, 'undo', 'redo');
  expect(projectFieldEdits(textDomain, undone, [redo])).toBe('ZRaLb');
});

test('counter projection and undo preserve other increments', () => {
  const history = { base: { ...base, value: 10 }, edits: [
    { id: 'local', epoch: 'epoch', version: 1, operation: 3 },
    { id: 'remote', epoch: 'epoch', version: 2, operation: 7 },
  ] };
  const inverse = invertAcceptedFieldEdit(counterDomain, history, 'local', 'undo');
  expect(projectFieldEdits(counterDomain, history, [inverse])).toBe(17);
});

test('expired undo and changed epochs fail without changing retained intent', () => {
  const history = { base: { ...base, version: 8 }, edits: [] };
  expect(() => invertAcceptedFieldEdit(textDomain, history, 'expired', 'undo')).toThrow('retained history');
  const pending = { id: 'local', epoch: 'older', baseVersion: 8, operation: ['L'] };
  expect(() => projectFieldEdits(textDomain, history, [pending])).toThrow('basis is unavailable');
  expect(pending.epoch).toBe('older');
});
