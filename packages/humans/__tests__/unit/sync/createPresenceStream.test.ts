/**
 * Transport-driven createPresenceStream — unit tests.
 *
 * The new presence factory lives at `src/sync/createPresenceStream.ts`
 * and powers `engine.presence`. Unlike the mesh-side factory (which
 * takes a `SyncAgent`), this one takes a `SyncWebSocket` directly —
 * the same transport entity sync rides on. After the dual-engine
 * collapse (step #36), this is the only presence factory in the SDK.
 *
 * Coverage:
 *   • subscribe() fires on inbound peer frames
 *   • own-echo frames are filtered out
 *   • leave kind removes from others
 *   • update() sends `{type: 'presence_update', payload: {...}}` over wire
 *   • deferred attach: pre-attach mutations only mutate self, not wire
 *   • post-attach attach() flushes any pending self-activity
 */

import { createPresenceStream } from '../../../src/presenceStream';
import type {
  SyncWebSocket,
  PresenceUpdate,
} from '../../../src/local/sync/SyncWebSocket';

// ── Stub SyncWebSocket ──────────────────────────────────────────────
//
// Only the four methods the factory consumes:
//   • subscribe('connected', cb): () => void
//   • subscribe('presence_update', cb): () => void
//   • send(frame): void
//   • isConnected(): boolean

interface SentFrame {
  type: string;
  payload?: Record<string, unknown>;
}

interface StubTransport {
  send: (frame: SentFrame) => void;
  isConnected: () => boolean;
  subscribe: (
    event: 'connected' | 'presence_update',
    cb: ((e: PresenceUpdate) => void) | (() => void),
  ) => () => void;
  // Test-side levers
  __sentFrames: SentFrame[];
  __fireConnected: () => void;
  __firePresence: (event: PresenceUpdate) => void;
  __setConnected: (v: boolean) => void;
}

function makeStubTransport(): StubTransport {
  const sentFrames: SentFrame[] = [];
  const connectedHandlers: (() => void)[] = [];
  const presenceHandlers: ((e: PresenceUpdate) => void)[] = [];
  let connected = true;

  return {
    send: (frame: SentFrame) => {
      sentFrames.push(frame);
    },
    isConnected: () => connected,
    subscribe: (event, cb) => {
      if (event === 'connected') {
        connectedHandlers.push(cb as () => void);
        return () => {
          const i = connectedHandlers.indexOf(cb as () => void);
          if (i >= 0) connectedHandlers.splice(i, 1);
        };
      }
      const handler = cb;
      presenceHandlers.push(handler);
      return () => {
        const i = presenceHandlers.indexOf(handler);
        if (i >= 0) presenceHandlers.splice(i, 1);
      };
    },
    __sentFrames: sentFrames,
    __fireConnected: () => {
      for (const h of connectedHandlers) h();
    },
    __firePresence: (event) => {
      for (const h of presenceHandlers) h(event);
    },
    __setConnected: (v: boolean) => {
      connected = v;
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('createPresenceStream (transport-driven) — direct attach', () => {
  it('fires subscribers when a peer frame arrives', () => {
    const t = makeStubTransport();
    const presence = createPresenceStream(
      { participantId: 'me', syncGroups: ['collection:X'] },
      t as unknown as SyncWebSocket,
    );

    let fireCount = 0;
    presence.onChange(() => {
      fireCount++;
    });

    expect(presence.others).toEqual([]);

    t.__firePresence({
      kind: 'enter',
      userId: 'peer-1',
      status: 'online',
      syncGroups: ['collection:X'],
      isAgent: false,
      timestamp: Date.now(),
      activity: { entityType: 'Entry', entityId: 's-1', action: 'editing' },
    });

    expect(fireCount).toBe(1);
    expect(presence.others).toHaveLength(1);
    expect(presence.others[0]?.participantId).toBe('peer-1');
  });

  it('filters out own-echo frames', () => {
    const t = makeStubTransport();
    const presence = createPresenceStream(
      { participantId: 'me', syncGroups: ['collection:X'] },
      t as unknown as SyncWebSocket,
    );

    let fireCount = 0;
    presence.onChange(() => {
      fireCount++;
    });

    t.__firePresence({
      kind: 'enter',
      userId: 'me', // self
      status: 'online',
      activity: { entityType: 'Entry', entityId: 's-1', action: 'editing' },
    });

    expect(fireCount).toBe(0);
    expect(presence.others).toHaveLength(0);
  });

  it('removes peers on `leave` kind', () => {
    const t = makeStubTransport();
    const presence = createPresenceStream(
      { participantId: 'me', syncGroups: ['collection:X'] },
      t as unknown as SyncWebSocket,
    );

    t.__firePresence({
      kind: 'enter',
      userId: 'peer-1',
      status: 'online',
      activity: { entityType: 'Entry', entityId: 's-1', action: 'viewing' },
    });
    expect(presence.others).toHaveLength(1);

    t.__firePresence({ kind: 'leave', userId: 'peer-1', status: 'offline' });
    expect(presence.others).toHaveLength(0);
  });

  it('sends presence_update frames on update()', () => {
    const t = makeStubTransport();
    const presence = createPresenceStream(
      { participantId: 'me', syncGroups: ['collection:X'] },
      t as unknown as SyncWebSocket,
    );

    presence.editing({ type: 'Entry', id: 's-3' }, 'entry 3');

    expect(t.__sentFrames).toHaveLength(1);
    const frame = t.__sentFrames[0];
    if (!frame) throw new Error('expected one sent presence frame');
    expect(frame.type).toBe('presence_update');
    expect(frame.payload).toEqual({
      status: 'online',
      activity: {
        entityType: 'Entry',
        entityId: 's-3',
        action: 'editing',
        detail: 'entry 3',
      },
    });
  });
});

describe('createPresenceStream (transport-driven) — deferred attach', () => {
  it('does not send wire frames until attach() is called', () => {
    const presence = createPresenceStream({
      participantId: 'me',
      syncGroups: ['collection:X'],
    });

    presence.editing({ type: 'Entry', id: 's-1' });

    // self mutated...
    expect(presence.self.activity.entityId).toBe('s-1');
    // ...but no wire send happened (no transport)
  });

  it('flushes pending self activity on attach()', () => {
    const presence = createPresenceStream({
      participantId: 'me',
      syncGroups: ['collection:X'],
    });
    presence.editing({ type: 'Entry', id: 's-7' });

    const t = makeStubTransport();
    presence.attach(t as unknown as SyncWebSocket);

    // The deferred self-activity should now be on the wire.
    expect(t.__sentFrames).toHaveLength(1);
    expect(t.__sentFrames[0]?.payload).toMatchObject({
      activity: { entityId: 's-7', action: 'editing' },
    });
  });

  it('reconnect re-broadcasts self and clears stale roster', () => {
    const t = makeStubTransport();
    const presence = createPresenceStream(
      { participantId: 'me', syncGroups: ['collection:X'] },
      t as unknown as SyncWebSocket,
    );

    // Set self activity + populate roster
    presence.editing({ type: 'Entry', id: 's-9' });
    t.__firePresence({
      kind: 'enter',
      userId: 'peer-1',
      status: 'online',
      activity: { entityType: 'Entry', entityId: 's-1', action: 'viewing' },
    });
    expect(presence.others).toHaveLength(1);
    expect(t.__sentFrames).toHaveLength(1); // initial editing send

    // Simulate reconnect: hub will ship a fresh roster snapshot, so
    // the local stale roster should be cleared and self re-announced.
    t.__fireConnected();

    expect(presence.others).toHaveLength(0);
    expect(t.__sentFrames).toHaveLength(2); // initial + re-announce
  });
});
