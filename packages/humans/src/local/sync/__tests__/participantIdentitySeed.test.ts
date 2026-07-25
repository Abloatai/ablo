/**
 * Late-bound participant identity — the host resolves who this client is and
 * seeds the streams (ADR 0016 follow-up: the host owns identity).
 *
 * A hosted client is constructed before identity is known: `participantId`
 * is empty until identity resolution derives it from the credential's scope
 * inside `ready()`. Until this seeding existed, the streams' own-echo
 * filters compared against the empty guess, so a participant's own frames
 * landed in `others` — an agent contending with itself. Pins:
 *   - `setParticipant` updates the own-echo filter on both streams,
 *   - the presence `self` entry updates in place (held references included),
 *   - peers keep flowing after the seed.
 */

import { describe, it, expect } from '@jest/globals';
import {
  createPresenceStream,
  type PresenceTransport,
} from '../../../presenceStream.js';
import { createClaimStream } from '../createClaimStream.js';

/** Emitting fake of the structural port both streams attach to. */
function fakePort(): PresenceTransport & {
  emit(event: string, payload: Record<string, unknown>): void;
} {
  const handlers = new Map<string, ((...args: never) => void)[]>();
  return {
    subscribe(event: string, handler: (...args: never) => void): () => void {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        handlers.set(
          event,
          (handlers.get(event) ?? []).filter((h) => h !== handler),
        );
      };
    },
    isConnected: () => true,
    send: () => undefined,
    emit(event: string, payload: Record<string, unknown>): void {
      for (const h of [...(handlers.get(event) ?? [])]) {
        (h as (p: Record<string, unknown>) => void)(payload);
      }
    },
  };
}

function presenceFrame(userId: string, extra: Record<string, unknown> = {}) {
  return { kind: 'update', userId, status: 'online', ...extra };
}

describe('presence stream — setParticipant', () => {
  it('filters own echoes by the seeded identity, not the construction guess', () => {
    const port = fakePort();
    const stream = createPresenceStream(
      { participantId: '', syncGroups: [] },
      port,
    );

    stream.setParticipant({ id: 'user-1', kind: 'agent', syncGroups: ['org:acme'] });

    port.emit('presence_update', presenceFrame('user-1'));
    expect(stream.others).toHaveLength(0);

    port.emit('presence_update', presenceFrame('peer-2'));
    expect(stream.others).toHaveLength(1);
    expect(stream.others[0]?.participantId).toBe('peer-2');
  });

  it('updates the self entry in place, so held references see the resolved identity', () => {
    const stream = createPresenceStream({ participantId: '', syncGroups: [] });
    const heldSelf = stream.self;

    stream.setParticipant({ id: 'user-1', kind: 'agent', syncGroups: ['org:acme'] });

    expect(heldSelf.participantId).toBe('user-1');
    expect(heldSelf.participantKind).toBe('agent');
    expect(heldSelf.syncGroups).toEqual(['org:acme']);
  });
});

describe('claim stream — setParticipant', () => {
  it("filters the participant's own claims out of others by the seeded identity", () => {
    const port = fakePort();
    const stream = createClaimStream({ participantId: '' }, port);

    stream.setParticipant({ id: 'agent-9' });

    const claim = {
      claimId: 'c1',
      entityType: 'Task',
      entityId: 't1',
      description: 'editing',
      declaredAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    port.emit('presence_update', presenceFrame('agent-9', { activeClaims: [claim] }));
    expect(stream.others).toHaveLength(0);

    port.emit('presence_update', presenceFrame('peer-2', { activeClaims: [claim] }));
    expect(stream.others).toHaveLength(1);
    expect(stream.others[0]?.heldBy).toBe('peer-2');
  });
});
