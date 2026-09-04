import { describe, expect, it, jest } from '@jest/globals';
import { createPresence } from '../index.js';
import { createClaimStream } from '../../local/sync/createClaimStream.js';
import type { PresenceSession } from '@abloatai/transaction/presence';

type EventName = 'presence_session' | 'presence_snapshot' | 'presence_patch' | 'connected' | 'disconnected';

function transport() {
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

const activity = (id: string, model: string, recordId: string) => ({
  id, version: 1, operation: 'read' as const,
  target: { model, id: recordId }, source: 'session' as const,
  startedAt: '2026-09-04T10:00:00.000Z', updatedAt: '2026-09-04T10:00:00.000Z',
  expiresAt: '2026-09-04T10:01:00.000Z',
});

describe('reactive presence', () => {
  it('keeps two sessions for one participant and derives model presence from the same store', () => {
    const events = transport();
    const presence = createPresence(events);
    const changed = jest.fn();
    presence.onChange(changed);
    events.emit('presence_session', { presenceSessionId: 'tab-1' });
    for (const [presenceSessionId, id] of [['tab-1', 'one'], ['tab-2', 'two']] as const) {
      events.emit('presence_snapshot', {
        presenceSessionId,
        participant: { id: 'person-1', kind: 'user' }, revision: 1,
        activities: [activity(id, 'Documents', 'doc-1')], tombstones: [],
      });
    }

    expect(presence.active.map(({ id }) => id)).toEqual(['one']);
    expect(presence.others.map(({ presenceSessionId }) => presenceSessionId)).toEqual(['tab-2']);
    expect(presence.forModel('documents', 'doc-1')).toHaveLength(2);
    expect(changed).toHaveBeenCalled();
  });

  it('feeds authoritative claim activities into the existing claim reader', () => {
    const sessions: PresenceSession[] = [{
      presenceSessionId: 'agent-run',
      participant: { id: 'agent-1', kind: 'agent' },
      activities: [{
        ...activity('claim:lease-1', 'Documents', 'doc-1'),
        operation: 'claim', source: 'claim',
      }],
    }];
    const claims = createClaimStream(
      {},
      null,
      { others: sessions, onChange: () => () => undefined },
    );

    expect(claims.others).toMatchObject([{
      id: 'lease-1', heldBy: 'agent-1', participantKind: 'agent',
      target: { type: 'Documents', id: 'doc-1' },
    }]);
  });
});
