/**
 * participantKind ingest — peers' kind comes from the server-stamped
 * `participantKind` on the presence frame (canonical 'user'|'agent'|'system'),
 * NOT from the lossy `isAgent` boolean. The boolean remains the fallback for
 * frames from servers that predate the field, and the legacy `'human'` label
 * normalizes to `'user'` (wireParticipantKindSchema). Pins the de-flatten:
 * before this, a 'system' holder rendered as 'user'/'human' in every
 * client-side claim view.
 */

import { describe, it, expect } from '@jest/globals';
import { createClaimStream } from '../createClaimStream.js';
import { createPresenceStream } from '../../../presenceStream.js';
import type { SyncWebSocket } from '../SyncWebSocket.js';

function fakeWs() {
  const handlers: Record<string, ((p: Record<string, unknown>) => void)[]> = {};
  return {
    subscribe(event: string, h: (p: Record<string, unknown>) => void) {
      (handlers[event] ??= []).push(h);
      return () => {
        handlers[event] = (handlers[event] ?? []).filter((x) => x !== h);
      };
    },
    isConnected: () => true,
    send: () => undefined,
    emit(event: string, p: Record<string, unknown>) {
      for (const h of [...(handlers[event] ?? [])]) h(p);
    },
  };
}

function presenceFrameWithClaim(overrides: Record<string, unknown>) {
  return {
    kind: 'update',
    userId: 'peer-1',
    status: 'online',
    activeClaims: [
      {
        claimId: 'i1',
        entityType: 'Item',
        entityId: 't1',
        description: 'editing',
        declaredAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
    ],
    ...overrides,
  };
}

describe('createClaimStream participantKind ingest', () => {
  it("reads the server-stamped kind — a 'system' holder is no longer flattened", () => {
    const ws = fakeWs();
    const stream = createClaimStream({ participantId: 'me' });
    stream.attach(ws as unknown as SyncWebSocket);

    ws.emit(
      'presence_update',
      presenceFrameWithClaim({ userId: 'system:reaper', participantKind: 'system' }),
    );

    expect(stream.others).toHaveLength(1);
    expect(stream.others[0]?.participantKind).toBe('system');
  });

  it("normalizes a legacy 'human' stamp to 'user'", () => {
    const ws = fakeWs();
    const stream = createClaimStream({ participantId: 'me' });
    stream.attach(ws as unknown as SyncWebSocket);

    ws.emit(
      'presence_update',
      presenceFrameWithClaim({ participantKind: 'human' }),
    );

    expect(stream.others[0]?.participantKind).toBe('user');
  });

  it('falls back to isAgent when the frame predates the field', () => {
    const ws = fakeWs();
    const stream = createClaimStream({ participantId: 'me' });
    stream.attach(ws as unknown as SyncWebSocket);

    ws.emit('presence_update', presenceFrameWithClaim({ isAgent: true }));

    expect(stream.others[0]?.participantKind).toBe('agent');
  });
});

describe('createPresenceStream participantKind ingest', () => {
  it('peers surface the stamped kind, with isAgent fallback', () => {
    const ws = fakeWs();
    const stream = createPresenceStream({
      participantId: 'me',
      syncGroups: ['team:x'],
    });
    stream.attach(ws as unknown as SyncWebSocket);

    ws.emit('presence_update', {
      kind: 'enter',
      userId: 'system:reaper',
      status: 'online',
      participantKind: 'system',
    });
    ws.emit('presence_update', {
      kind: 'enter',
      userId: 'agent:old-server-peer',
      status: 'online',
      isAgent: true, // no participantKind — legacy server
    });

    const byId = new Map(stream.others.map((p) => [p.participantId, p]));
    expect(byId.get('system:reaper')?.participantKind).toBe('system');
    expect(byId.get('agent:old-server-peer')?.participantKind).toBe('agent');
  });
});
