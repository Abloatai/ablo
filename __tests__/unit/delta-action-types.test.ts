/**
 * Delta action type tests — verifies the wire format for the Linear-compatible
 * action vocabulary, including the permission/access-control additions:
 *
 *   I — Insert       A — Archive     V — Unarchive (reVive)
 *   U — Update       D — Delete
 *   C — Covering     G — GroupAdded  S — GroupRemoved
 *
 * These tests pin the wire contract that the Go sync-engine writer produces
 * and the TypeScript client consumes. A change in any of these shapes is a
 * breaking protocol change and must be accompanied by a server-side update.
 */

import {
  createDelta,
  createInsertDelta,
  createUpdateDelta,
  createDeleteDelta,
  createArchiveDelta,
  createUnarchiveDelta,
  createCoveringDelta,
  createGroupAddedDelta,
  createLegacyGroupChangeDelta,
  createGroupRemovedDelta,
  resetDeltaCounter,
} from '../../src/testing';
import type { SyncActionType } from '../../src/types';

describe('Delta action type constants', () => {
  it('SyncActionType union covers all 8 Linear-compatible letters', () => {
    // Exhaustive switch at compile time — if SyncActionType ever loses a case
    // (or gains one), the default branch will become reachable and TypeScript
    // will flag this test as unreachable-default. That's the compile error
    // we want: the test enforces exhaustiveness.
    const letters: SyncActionType[] = ['I', 'U', 'A', 'D', 'C', 'G', 'S', 'V'];

    function classify(a: SyncActionType): string {
      switch (a) {
        case 'I':
          return 'insert';
        case 'U':
          return 'update';
        case 'D':
          return 'delete';
        case 'A':
          return 'archive';
        case 'V':
          return 'unarchive';
        case 'C':
          return 'covering';
        case 'G':
          return 'group-added';
        case 'S':
          return 'group-removed';
      }
      // Unreachable if SyncActionType is exhaustively handled above.
      const _exhaustive: never = a;
      return _exhaustive;
    }

    expect(letters.map(classify)).toEqual([
      'insert',
      'update',
      'archive',
      'delete',
      'covering',
      'group-added',
      'group-removed',
      'unarchive',
    ]);
  });

  it('each action letter is distinct (catches copy-paste bugs)', () => {
    const letters: SyncActionType[] = ['I', 'U', 'A', 'D', 'C', 'G', 'S', 'V'];
    const unique = new Set(letters);
    expect(unique.size).toBe(letters.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Basic CRUD fixtures — regression guard against shape drift
// ─────────────────────────────────────────────────────────────────────────────

describe('CRUD delta fixtures', () => {
  beforeEach(() => {
    resetDeltaCounter();
  });

  it('createInsertDelta produces { action: "I", ... }', () => {
    const delta = createInsertDelta('Task', 'task_1', { title: 'hello' }, 42);
    expect(delta).toMatchObject({
      id: 42,
      modelName: 'Task',
      modelId: 'task_1',
      action: 'I',
      data: { title: 'hello' },
      __class: 'SyncAction',
    });
  });

  it('createUpdateDelta produces { action: "U", ... }', () => {
    const delta = createUpdateDelta('Task', 'task_1', { title: 'renamed' });
    expect(delta.action).toBe('U');
    expect(delta.data).toEqual({ title: 'renamed' });
  });

  it('createDeleteDelta produces { action: "D", ... }', () => {
    const delta = createDeleteDelta('Task', 'task_1');
    expect(delta.action).toBe('D');
  });

  it('createArchiveDelta produces { action: "A", data: { archivedAt } }', () => {
    const delta = createArchiveDelta('Task', 'task_1');
    expect(delta.action).toBe('A');
    expect((delta.data as Record<string, unknown>).archivedAt).toBeDefined();
  });

  it('createUnarchiveDelta produces { action: "V", data: { archivedAt: null } }', () => {
    const delta = createUnarchiveDelta('Task', 'task_1');
    expect(delta.action).toBe('V');
    expect((delta.data as Record<string, unknown>).archivedAt).toBeNull();
  });

  it('auto-increments sync IDs across factory calls', () => {
    const a = createInsertDelta('Task', 't1', {});
    const b = createUpdateDelta('Task', 't1', {});
    const c = createDeleteDelta('Task', 't1');
    expect(b.id).toBe(a.id + 1);
    expect(c.id).toBe(b.id + 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Covering ('C') — client gained permission to see an existing entity
// ─────────────────────────────────────────────────────────────────────────────

describe('createCoveringDelta', () => {
  beforeEach(() => {
    resetDeltaCounter();
  });

  it('produces action="C" with the entity payload intact', () => {
    const delta = createCoveringDelta('Task', 'task_1', { title: 'Now Visible' });
    expect(delta.action).toBe('C');
    expect(delta.modelName).toBe('Task');
    expect(delta.modelId).toBe('task_1');
    expect(delta.data).toEqual({ title: 'Now Visible' });
    expect(delta.__class).toBe('SyncAction');
  });

  it('supports explicit sync IDs for ordered playback', () => {
    const a = createCoveringDelta('Task', 'task_a', {}, 100);
    const b = createCoveringDelta('Task', 'task_b', {}, 101);
    const c = createCoveringDelta('Task', 'task_c', {}, 102);
    expect([a.id, b.id, c.id]).toEqual([100, 101, 102]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GroupAdded ('G') — incremental payload shape { group, userId }
// ─────────────────────────────────────────────────────────────────────────────

describe('createGroupAddedDelta (incremental shape)', () => {
  beforeEach(() => {
    resetDeltaCounter();
  });

  it('produces action="G" with { group, userId } payload', () => {
    const delta = createGroupAddedDelta('user_123', 'team:team_456');

    expect(delta.action).toBe('G');
    expect(delta.modelName).toBe('SyncGroupChange');
    expect(delta.data).toEqual({
      group: 'team:team_456',
      userId: 'user_123',
    });
  });

  it('payload matches the Go EmitGroupAdded wire format', () => {
    // The Go writer emits { group: <string>, userId: <string> }.
    // The client detects this shape to dispatch to handleGroupAdded
    // (no re-bootstrap) instead of the legacy handleSyncGroupChange path.
    const delta = createGroupAddedDelta('user_alpha', 'project:proj_xyz');
    const data = delta.data as Record<string, unknown>;

    expect(typeof data.group).toBe('string');
    expect(typeof data.userId).toBe('string');
    expect(data).not.toHaveProperty('addedGroups');
    expect(data).not.toHaveProperty('removedGroups');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GroupAdded ('G') — legacy payload shape { addedGroups, removedGroups }
// ─────────────────────────────────────────────────────────────────────────────

describe('createLegacyGroupChangeDelta', () => {
  beforeEach(() => {
    resetDeltaCounter();
  });

  it('produces action="G" with legacy addedGroups/removedGroups payload', () => {
    const delta = createLegacyGroupChangeDelta(
      'user_123',
      ['team:team_new'],
      ['team:team_old']
    );

    expect(delta.action).toBe('G');
    expect(delta.modelName).toBe('SyncGroupChange');
    expect(delta.data).toEqual({
      addedGroups: ['team:team_new'],
      removedGroups: ['team:team_old'],
    });
  });

  it('legacy payload is shape-distinguishable from incremental payload', () => {
    // The client detects which code path to take by checking for
    // `group`/`userId` (new) vs `addedGroups`/`removedGroups` (legacy).
    // These two shapes must never overlap or the dispatch becomes ambiguous.
    const legacy = createLegacyGroupChangeDelta('user_1', ['team:a'], []);
    const incremental = createGroupAddedDelta('user_1', 'team:a');

    const legacyData = legacy.data as Record<string, unknown>;
    const incrementalData = incremental.data as Record<string, unknown>;

    expect(legacyData).toHaveProperty('addedGroups');
    expect(legacyData).toHaveProperty('removedGroups');
    expect(legacyData).not.toHaveProperty('group');

    expect(incrementalData).toHaveProperty('group');
    expect(incrementalData).toHaveProperty('userId');
    expect(incrementalData).not.toHaveProperty('addedGroups');
    expect(incrementalData).not.toHaveProperty('removedGroups');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GroupRemoved ('S') — { group, userId }
// ─────────────────────────────────────────────────────────────────────────────

describe('createGroupRemovedDelta', () => {
  beforeEach(() => {
    resetDeltaCounter();
  });

  it('produces action="S" with { group, userId } payload', () => {
    const delta = createGroupRemovedDelta('user_123', 'team:team_456');

    expect(delta.action).toBe('S');
    expect(delta.modelName).toBe('SyncGroupChange');
    expect(delta.data).toEqual({
      group: 'team:team_456',
      userId: 'user_123',
    });
  });

  it('uses a distinct action letter from GroupAdded', () => {
    // Same payload shape, different action type. The action letter is
    // the signal that tells the client whether to add or purge.
    const added = createGroupAddedDelta('user_1', 'team:x');
    const removed = createGroupRemovedDelta('user_1', 'team:x');

    expect(added.action).toBe('G');
    expect(removed.action).toBe('S');
    expect(added.data).toEqual(removed.data);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Incremental flow — GroupAdded followed by Coverings
//
// Mirrors the Go-side TestIncrementalSyncFlow_GroupAddedFollowedByCoverings.
// Verifies that the TypeScript fixtures produce the same sequence the server
// emits, so client tests can replay exactly what the Go tests assert.
// ─────────────────────────────────────────────────────────────────────────────

describe('Incremental sync flow fixtures', () => {
  beforeEach(() => {
    resetDeltaCounter();
  });

  it('constructs a GroupAdded + N Covering sequence with sequential sync IDs', () => {
    const userId = 'user_123';
    const teamGroup = 'team:team_456';
    const taskIds = ['task_1', 'task_2', 'task_3'];

    // 1. User is added to the team
    const groupAdded = createGroupAddedDelta(userId, teamGroup, 1);

    // 2. Push the entities the user can now see
    const coverings = taskIds.map((id, i) =>
      createCoveringDelta('Task', id, { id, teamId: 'team_456' }, 2 + i)
    );

    const sequence = [groupAdded, ...coverings];

    // Sync IDs strictly ascending
    const ids = sequence.map((d) => d.id);
    expect(ids).toEqual([1, 2, 3, 4]);

    // First delta is the group signal
    expect(sequence[0].action).toBe('G');
    expect((sequence[0].data as Record<string, unknown>).group).toBe(teamGroup);

    // Remaining deltas are coverings, one per task, in order
    for (let i = 0; i < taskIds.length; i++) {
      expect(sequence[i + 1].action).toBe('C');
      expect(sequence[i + 1].modelName).toBe('Task');
      expect(sequence[i + 1].modelId).toBe(taskIds[i]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createDelta — generic factory supports all action letters
// ─────────────────────────────────────────────────────────────────────────────

describe('createDelta (generic factory)', () => {
  beforeEach(() => {
    resetDeltaCounter();
  });

  it.each<[SyncActionType]>([
    ['I'],
    ['U'],
    ['D'],
    ['A'],
    ['V'],
    ['C'],
    ['G'],
    ['S'],
  ])('accepts action letter %s', (action) => {
    const delta = createDelta({
      modelName: 'Task',
      modelId: 'task_1',
      action,
    });
    expect(delta.action).toBe(action);
  });
});
