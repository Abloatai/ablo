import { describe, expect, it } from '@jest/globals';
import {
  applyTextOperation,
  foldTextHistory,
  invertTextOperation,
  reconcileTextEdit,
  textOperationSchema,
  transformTextOperation,
  type TextHistory,
  type TextOperation,
} from '../index.js';

function history(value = 'hello'): TextHistory {
  return { base: { epoch: 'document-base', version: 0, value }, edits: [] };
}

function accept(log: TextHistory, id: string, operation: TextOperation, baseVersion = 0): void {
  log.edits.push(reconcileTextEdit(log, {
    id, epoch: log.base.epoch, baseVersion, operation,
  }, foldTextHistory(log).value));
}

describe('versioned text operations', () => {
  it('preserves an insertion while a concurrent writer deletes the original character', () => {
    for (const order of [['insert', 'delete'], ['delete', 'insert']]) {
      const log = history();
      for (const id of order) accept(log, id!, id === 'insert' ? ['X'] : [{ d: 'h' }]);
      expect(foldTextHistory(log)).toEqual({ epoch: 'document-base', version: 2, value: 'Xello' });
    }
  });

  it('uses code-point positions and inverts edits containing emoji', () => {
    const value = 'a🤖b';
    const operation = [1, { d: '🤖' }, '🌍'];
    const next = applyTextOperation(value, operation);
    expect(next).toBe('a🌍b');
    expect(applyTextOperation(next, invertTextOperation(value, operation))).toBe(value);
  });

  it('keeps every insertion in all six three-writer orders, including an overlapping delete', () => {
    const operations: Record<string, TextOperation> = {
      a: [1, 'A'], b: [1, 'B'], c: [{ d: 'he' }, 'C'],
    };
    for (const order of ['abc', 'acb', 'bac', 'bca', 'cab', 'cba']) {
      const log = history();
      for (const id of order) accept(log, id, operations[id]!);
      const value = foldTextHistory(log).value;
      expect(value).toContain('A');
      expect(value).toContain('B');
      expect(value).toContain('C');
      expect(value).toContain('llo');
      expect(value).not.toMatch(/[he]/);
    }
  });

  it('converges across generated pairs of inserts, deletes and replacements', () => {
    const value = 'a🤖bcd';
    const characters = Array.from(value);
    const operations: TextOperation[] = [];
    for (let position = 0; position <= characters.length; position++) {
      const prefix = position ? [position] : [];
      operations.push([...prefix, '🌍']);
      if (position < characters.length) {
        operations.push([...prefix, { d: 1 }]);
        operations.push([...prefix, { d: 1 }, 'X']);
      }
    }
    for (const left of operations) for (const right of operations) {
      const leftAfterRight = transformTextOperation(left, right, 'left');
      const rightAfterLeft = transformTextOperation(right, left, 'right');
      expect(applyTextOperation(applyTextOperation(value, left), rightAfterLeft))
        .toBe(applyTextOperation(applyTextOperation(value, right), leftAfterRight));
    }
  });

  it('rebases undo so it removes your insertion and preserves the collaborator’s', () => {
    const log = history();
    const own: TextOperation = ['X'];
    accept(log, 'own', own);
    const undo = invertTextOperation('hello', own);
    accept(log, 'peer', ['Y']);
    accept(log, 'undo', undo, 1);
    expect(foldTextHistory(log).value).toBe('Yhello');
  });

  it('rejects deleted-content mismatches, invalid positions and malformed Unicode', () => {
    for (const operation of [[{ d: 'wrong' }], [{ d: 6 }], [6, 'X'], [1.5, 'X']]) {
      expect(() => applyTextOperation('hello', operation)).toThrow();
    }
    expect(() => applyTextOperation('hello', ['\ud800'])).toThrow();
    for (const operation of [[NaN], [Infinity], [0], [{ d: -1 }], [{ d: 1, extra: true }]]) {
      expect(textOperationSchema.safeParse(operation).success).toBe(false);
    }
  });

  it('rejects external replacements without applying an operation against the wrong text', () => {
    const log = history();
    accept(log, 'own', ['X']);
    expect(() => reconcileTextEdit(log, {
      id: 'peer', epoch: log.base.epoch, baseVersion: 0, operation: [{ d: 'h' }],
    }, 'externally replaced')).toThrow('outside its edit history');
  });

  it('rejects expired, future, forked, duplicate and incomplete histories', () => {
    const log = history();
    accept(log, 'first', ['X']);
    const edit = { id: 'next', epoch: log.base.epoch, baseVersion: 0, operation: ['Y'] };
    expect(() => reconcileTextEdit(log, { ...edit, epoch: 'another-base' }, 'Xhello')).toThrow();
    expect(() => reconcileTextEdit(log, { ...edit, baseVersion: 2 }, 'Xhello')).toThrow();
    expect(() => reconcileTextEdit(log, { ...edit, id: 'first' }, 'Xhello')).toThrow('already accepted');
    const checkpoint = { base: foldTextHistory(log), edits: [] };
    expect(() => reconcileTextEdit(checkpoint, edit, 'Xhello')).toThrow('basis is unavailable');
    expect(() => foldTextHistory({ ...log, edits: [{ ...log.edits[0]!, version: 2 }] })).toThrow('incomplete');
    expect(() => foldTextHistory({ ...log, edits: [{ ...log.edits[0]!, epoch: 'another-base' }] })).toThrow('incomplete');
  });
});
