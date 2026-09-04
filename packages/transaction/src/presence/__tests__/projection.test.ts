import { describe, expect, it } from '@jest/globals';
import {
  applyPresencePatch,
  applyPresenceSnapshot,
  presenceForModel,
  presenceForRecord,
  type PresenceActivity,
  type PresencePatch,
  type PresenceSession,
  type PresenceSnapshot,
} from '../index.js';

const at = (second: number): string => `2026-09-04T10:00:${String(second).padStart(2, '0')}.000Z`;

function activity(
  id: string,
  version: number,
  model: string,
  recordId?: string,
): PresenceActivity {
  return {
    id,
    version,
    operation: 'read',
    target: { model, ...(recordId === undefined ? {} : { id: recordId }) },
    source: 'session',
    startedAt: at(0),
    updatedAt: at(version),
    expiresAt: at(59),
  };
}

const participant = { id: 'agent-1', kind: 'agent' as const };

function snapshot(activities: PresenceActivity[] = []): PresenceSnapshot {
  return {
    presenceSessionId: 'session-1',
    participant,
    revision: 10,
    activities,
    tombstones: [],
  };
}

function patch(
  activities: PresenceActivity[] = [],
  tombstones: PresencePatch['tombstones'] = [],
): PresencePatch {
  return {
    presenceSessionId: 'session-1',
    activities,
    tombstones,
  };
}

describe('presence projection convergence', () => {
  it('converges independent activity patches in either delivery order', () => {
    const left = patch([activity('read-a', 1, 'Document', 'doc-1')]);
    const right = patch([activity('read-b', 4, 'Clause', 'clause-1')]);

    const leftThenRight = applyPresencePatch(applyPresencePatch(snapshot(), left), right);
    const rightThenLeft = applyPresencePatch(applyPresencePatch(snapshot(), right), left);

    expect(leftThenRight).toEqual(rightThenLeft);
    expect(leftThenRight.activities.map(({ id }) => id)).toEqual(['read-a', 'read-b']);
  });

  it('does not resurrect an activity behind an equal or newer tombstone', () => {
    const removed = patch([], [{
      activityId: 'read-a',
      version: 3,
      removedAt: at(4),
    }]);
    const staleActivity = patch([activity('read-a', 2, 'Document', 'doc-1')]);

    const result = applyPresencePatch(applyPresencePatch(snapshot(), removed), staleActivity);

    expect(result.activities).toEqual([]);
    expect(result.tombstones).toHaveLength(1);
  });

  it('does not require contiguous session revisions for filtered patches', () => {
    const visiblePatch = patch([activity('read-visible', 8, 'Document', 'doc-1')]);
    const result = applyPresencePatch(snapshot(), visiblePatch);

    expect(result.revision).toBe(10);
    expect(result.activities[0]?.version).toBe(8);
    expect(visiblePatch).not.toHaveProperty('revision');
  });

  it('ignores an older complete snapshot for the same session', () => {
    const current = snapshot([activity('read-a', 1, 'Document', 'doc-1')]);
    expect(applyPresenceSnapshot(current, { ...current, revision: 9 })).toBe(current);
  });

  it('requires a new session id for a new session lifetime', () => {
    const current = snapshot();
    expect(() => applyPresenceSnapshot(current, {
      ...current,
      presenceSessionId: 'session-2',
      revision: 0,
    })).toThrow('different session');
  });
});

describe('model presence projections', () => {
  const sessions: PresenceSession[] = [
    {
      presenceSessionId: 'current-session',
      participant,
      activities: [
        activity('doc-1-read', 1, 'Documents', 'doc-1'),
        activity('doc-2-read', 1, 'documents', 'doc-2'),
        activity('clause-read', 1, 'Clause', 'clause-1'),
      ],
    },
    {
      presenceSessionId: 'other-session',
      participant: { id: 'user-2', kind: 'user' },
      activities: [activity('doc-1-write', 1, 'documents', 'doc-1')],
    },
  ];

  it('includes the current session and retains only matching model activities', () => {
    const result = presenceForModel(sessions, 'Documents');

    expect(result.map(({ presenceSessionId }) => presenceSessionId))
      .toEqual(['current-session', 'other-session']);
    expect(result[0]?.activities.map(({ id }) => id))
      .toEqual(['doc-1-read', 'doc-2-read']);
  });

  it('requires an exact record id and retains only matching activities', () => {
    const result = presenceForRecord(sessions, 'documents', 'doc-1');

    expect(result).toHaveLength(2);
    expect(result.every((session) =>
      session.activities.every(({ target }) => target.id === 'doc-1'))).toBe(true);
    expect(presenceForRecord(sessions, 'documents', 'DOC-1')).toEqual([]);
  });
});
