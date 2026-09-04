import { describe, expect, it } from '@jest/globals';
import { createPresenceProjection } from '../store.js';
import type { PresencePatch, PresenceSnapshot } from '../projections.js';

type EventName = 'presence_session' | 'presence_snapshot' | 'presence_patch' | 'connected' | 'disconnected';

function events() {
  const listeners = new Map<EventName, Set<(value: never) => void>>();
  return {
    subscribe(event: EventName, listener: (value: never) => void) {
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
      return () => { eventListeners.delete(listener); };
    },
    emit(event: EventName, value?: object) {
      for (const listener of listeners.get(event) ?? []) listener(value as never);
    },
  };
}

const read = (id: string, model = 'Documents', recordId = 'doc-1') => ({
  id,
  version: 1,
  operation: 'read' as const,
  target: { model, id: recordId },
  source: 'session' as const,
  startedAt: '2026-09-04T10:00:00.000Z',
  updatedAt: '2026-09-04T10:00:00.000Z',
  expiresAt: '2026-09-04T10:01:00.000Z',
});

describe('presence projection store', () => {
  it('keys sessions independently and projects active, others, model, and record views', () => {
    const source = events();
    const projection = createPresenceProjection(source);
    source.emit('presence_session', { presenceSessionId: 'self-session' });
    source.emit('presence_snapshot', {
      presenceSessionId: 'self-session', participant: { id: 'person-1', kind: 'user' },
      revision: 1, activities: [read('self-read')], tombstones: [],
    } satisfies PresenceSnapshot);
    source.emit('presence_snapshot', {
      presenceSessionId: 'other-tab', participant: { id: 'person-1', kind: 'user' },
      revision: 1, activities: [read('other-read'), read('clause-read', 'Clauses', 'clause-1')],
      tombstones: [],
    } satisfies PresenceSnapshot);

    expect(projection.active.map(({ id }) => id)).toEqual(['self-read']);
    expect(projection.others.map(({ presenceSessionId }) => presenceSessionId)).toEqual(['other-tab']);
    expect(projection.forModel('documents')).toHaveLength(2);
    expect(projection.forModel('documents', 'doc-1')[1]?.activities).toHaveLength(1);
  });

  it('can establish a session from the first attributed patch and remove its activity', () => {
    const source = events();
    const projection = createPresenceProjection(source);
    source.emit('presence_patch', {
      presenceSessionId: 'agent-run',
      participant: { id: 'agent-1', kind: 'agent' },
      activities: [read('read-1')],
    } satisfies PresencePatch);
    expect(projection.sessions).toHaveLength(1);

    source.emit('presence_patch', {
      presenceSessionId: 'agent-run',
      tombstones: [{
        activityId: 'read-1', version: 2, removedAt: '2026-09-04T10:00:30.000Z',
      }],
    } satisfies PresencePatch);
    expect(projection.sessions).toEqual([]);
  });
});
