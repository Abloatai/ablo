/**
 * inverseOp schema — validation boundary for the undo model.
 *
 * Pins the contract that recorded entries are well-formed and that malformed
 * ops are rejected at ingestion (with a precise path) rather than crashing
 * later inside applyOps.
 */

import { AbloValidationError } from '@abloatai/transaction/errors';
import {
  inverseOpSchema,
  undoEntrySchema,
  parseUndoEntry,
  type UndoEntry,
} from '../inverseOp.js';

describe('inverseOpSchema', () => {
  it('accepts every op kind with its required shape', () => {
    const ops = [
      { kind: 'create', modelKey: 'slideLayers', data: { id: 'a', x: 1 } },
      { kind: 'update', modelKey: 'slideLayers', patch: { id: 'a', x: 2 } },
      { kind: 'delete', modelKey: 'slideLayers', id: 'a' },
      { kind: 'createMany', modelKey: 'slideLayers', data: [{ id: 'a' }, { id: 'b' }] },
      { kind: 'updateMany', modelKey: 'slideLayers', patches: [{ id: 'a', x: 1 }] },
      { kind: 'deleteMany', modelKey: 'slideLayers', ids: ['a', 'b'] },
    ];
    for (const op of ops) {
      expect(inverseOpSchema.safeParse(op).success).toBe(true);
    }
  });

  it('rejects an unknown kind', () => {
    expect(inverseOpSchema.safeParse({ kind: 'patch', modelKey: 'x', id: 'a' }).success).toBe(
      false,
    );
  });

  it('requires patch.id on update ops', () => {
    const result = inverseOpSchema.safeParse({
      kind: 'update',
      modelKey: 'slideLayers',
      patch: { x: 1 }, // missing id
    });
    expect(result.success).toBe(false);
  });
});

describe('parseUndoEntry', () => {
  it('returns the entry when valid (empty arrays allowed)', () => {
    const entry: UndoEntry = { label: 'edit', inverses: [], forwards: [] };
    expect(parseUndoEntry(entry)).toEqual(entry);
  });

  it('throws AbloValidationError with the failing path in details', () => {
    const bad = {
      label: 'broken',
      inverses: [{ kind: 'update', modelKey: 'slideLayers', patch: { x: 1 } }],
      forwards: [],
    };
    try {
      parseUndoEntry(bad);
      throw new Error('expected parseUndoEntry to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AbloValidationError);
      const e = err as AbloValidationError;
      expect(e.code).toBe('undo_entry_invalid');
      const issues = (e.details as { issues?: { path: (string | number)[] }[] })?.issues;
      expect(issues?.[0]?.path).toEqual(['inverses', 0, 'patch', 'id']);
    }
  });

  it('rejects a non-object', () => {
    expect(() => parseUndoEntry(null)).toThrow(AbloValidationError);
    expect(() => parseUndoEntry('nope')).toThrow(AbloValidationError);
  });

  it('round-trips through undoEntrySchema', () => {
    const entry: UndoEntry = {
      label: 'Move layer',
      inverses: [{ kind: 'update', modelKey: 'slideLayers', patch: { id: 'a', x: 0 } }],
      forwards: [{ kind: 'update', modelKey: 'slideLayers', patch: { id: 'a', x: 10 } }],
    };
    expect(undoEntrySchema.parse(entry)).toEqual(entry);
  });
});
