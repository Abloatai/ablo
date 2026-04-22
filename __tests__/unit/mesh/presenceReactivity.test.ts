/**
 * Mesh presence/intent reactivity unit tests.
 *
 * Proves that `participant.presence.subscribe(...)` and
 * `participant.intents.subscribe(...)` fire whenever the underlying
 * SyncAgent emits a `presence` event. Without this, the web app's
 * `useSyncExternalStore` binding (and MobX autorun callers) would
 * render once on mount and never update — the reactivity-gap risk
 * flagged in the plan.
 *
 * Tests the factories in isolation with a stub SyncAgent (no real
 * WebSocket, no network). The stub exposes `fireFakePresence(...)`
 * so the test can synthesize frames and observe subscriber calls.
 */

import {
  createPresenceStream,
  createIntentStream,
} from '../../../src/mesh/createMesh';
import type { SyncAgent } from '../../../src/agent/SyncAgent';
import type { PresenceEntry as AgentPresenceEntry } from '../../../src/agent/types';

// ── Stub SyncAgent: only the bits presence/intent streams consume ──

interface StubSyncAgent {
  /** Captures handlers registered via `onPresence(handler)`. */
  readonly presenceHandlers: Array<(entry: AgentPresenceEntry) => void>;
  /** Test helper: deliver a fake presence frame to all registered handlers. */
  fireFakePresence(entry: AgentPresenceEntry): void;
}

function makeStubSyncAgent(): StubSyncAgent & SyncAgent {
  const handlers: Array<(entry: AgentPresenceEntry) => void> = [];
  const stub = {
    presenceHandlers: handlers,
    fireFakePresence(entry: AgentPresenceEntry) {
      for (const h of handlers) h(entry);
    },
    onPresence(handler: (entry: AgentPresenceEntry) => void) {
      handlers.push(handler);
      return () => {
        const i = handlers.indexOf(handler);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
    // Unused by the factories in these tests but needed for the cast.
    announce: jest.fn(),
    beginIntent: jest.fn(),
    // `on('connected', ...)` is used by `createPresenceStream` to
    // reset `othersById` on WS reconnect. Stub accepts the callback
    // and drops it — tests don't exercise the reconnect-clear path
    // (separate test would need a fake SyncAgent with emit()).
    on: jest.fn(),
    off: jest.fn(),
  };
  return stub as unknown as StubSyncAgent & SyncAgent;
}

// ── PresenceStream reactivity ──────────────────────────────────────

describe('createPresenceStream — reactivity', () => {
  it('fires subscribers when a peer presence frame arrives', () => {
    const stub = makeStubSyncAgent();
    const presence = createPresenceStream(stub, 'me', 'Self', ['deck:X']);

    let fireCount = 0;
    const unsubscribe = presence.subscribe(() => {
      fireCount++;
    });

    expect(fireCount).toBe(0);
    expect(presence.others).toEqual([]);

    // Deliver a synthetic presence entry for another participant.
    stub.fireFakePresence({
      kind: 'enter',
      userId: 'peer-1',
      status: 'online',
      syncGroups: ['deck:X'],
      isAgent: false,
      timestamp: Date.now(),
      activity: {
        entityType: 'Slide',
        entityId: 's-1',
        action: 'editing',
      },
    });

    expect(fireCount).toBe(1);
    expect(presence.others).toHaveLength(1);
    expect(presence.others[0]!.participantId).toBe('peer-1');

    // A second frame (activity change on same peer) still fires the listener.
    stub.fireFakePresence({
      kind: 'enter',
      userId: 'peer-1',
      status: 'online',
      syncGroups: ['deck:X'],
      isAgent: false,
      timestamp: Date.now(),
      activity: {
        entityType: 'Slide',
        entityId: 's-2',
        action: 'reviewing',
      },
    });
    expect(fireCount).toBe(2);
    expect(presence.others[0]!.activity.entityId).toBe('s-2');

    unsubscribe();

    // After unsubscribe, further frames do not call the listener.
    stub.fireFakePresence({
      kind: 'enter',
      userId: 'peer-2',
      status: 'online',
      syncGroups: ['deck:X'],
      isAgent: false,
      timestamp: Date.now(),
      activity: { entityType: 'Slide', entityId: 's-3', action: 'editing' },
    });
    expect(fireCount).toBe(2);
    // But `others` still updated — presence state is kept even without listeners.
    expect(presence.others).toHaveLength(2);
  });

  it('ignores self frames (echoed back from server)', () => {
    const stub = makeStubSyncAgent();
    const presence = createPresenceStream(stub, 'me', 'Self', ['deck:X']);

    let fireCount = 0;
    presence.subscribe(() => {
      fireCount++;
    });

    // Server echo of our OWN presence update — must not fire listeners.
    stub.fireFakePresence({
      kind: 'enter',
      userId: 'me',
      status: 'online',
      syncGroups: ['deck:X'],
      isAgent: false,
      timestamp: Date.now(),
      activity: { entityType: 'Slide', entityId: 's-1', action: 'editing' },
    });

    expect(fireCount).toBe(0);
    expect(presence.others).toHaveLength(0);
  });

  it('supports multiple concurrent subscribers independently', () => {
    const stub = makeStubSyncAgent();
    const presence = createPresenceStream(stub, 'me', 'Self', ['deck:X']);

    let aFires = 0;
    let bFires = 0;
    const unsubA = presence.subscribe(() => {
      aFires++;
    });
    presence.subscribe(() => {
      bFires++;
    });

    stub.fireFakePresence({
      kind: 'enter',
      userId: 'peer-1',
      status: 'online',
      syncGroups: ['deck:X'],
      isAgent: true,
      timestamp: Date.now(),
      activity: { entityType: 'Slide', entityId: 's-1', action: 'generating' },
    });
    expect(aFires).toBe(1);
    expect(bFires).toBe(1);

    unsubA();
    stub.fireFakePresence({
      kind: 'enter',
      userId: 'peer-2',
      status: 'online',
      syncGroups: ['deck:X'],
      isAgent: false,
      timestamp: Date.now(),
      activity: { entityType: 'Slide', entityId: 's-2', action: 'editing' },
    });
    expect(aFires).toBe(1); // unsubscribed
    expect(bFires).toBe(2); // still firing
  });

  it('isolates listener errors — one throwing handler does not break others', () => {
    const stub = makeStubSyncAgent();
    const presence = createPresenceStream(stub, 'me', 'Self', ['deck:X']);

    let bFires = 0;
    presence.subscribe(() => {
      throw new Error('boom');
    });
    presence.subscribe(() => {
      bFires++;
    });

    stub.fireFakePresence({
      kind: 'enter',
      userId: 'peer-1',
      status: 'online',
      syncGroups: ['deck:X'],
      isAgent: false,
      timestamp: Date.now(),
      activity: { entityType: 'Slide', entityId: 's-1', action: 'editing' },
    });
    expect(bFires).toBe(1);
  });
});

// ── IntentStream reactivity ────────────────────────────────────────

describe('createIntentStream — reactivity', () => {
  it('fires subscribers when a peer announces an intent via presence', () => {
    const stub = makeStubSyncAgent();
    const intents = createIntentStream(stub, 'me');

    let fireCount = 0;
    intents.subscribe(() => {
      fireCount++;
    });

    expect(intents.others).toEqual([]);

    // Intents ride on presence frames (server's `activeIntents` payload).
    stub.fireFakePresence({
      kind: 'enter',
      userId: 'peer-1',
      status: 'online',
      syncGroups: ['deck:X'],
      isAgent: true,
      timestamp: Date.now(),
      activeIntents: [
        {
          intentId: 'intent-1',
          entityType: 'Slide',
          entityId: 's-1',
          action: 'rewriting',
          declaredAt: Date.now(),
          expiresAt: Date.now() + 120_000,
        },
      ],
    });

    expect(fireCount).toBe(1);
    expect(intents.others).toHaveLength(1);
    expect(intents.others[0]!.id).toBe('intent-1');
    expect(intents.others[0]!.heldBy).toBe('peer-1');

    // When the intent clears (presence frame without it), subscriber fires again.
    stub.fireFakePresence({
      kind: 'enter',
      userId: 'peer-1',
      status: 'online',
      syncGroups: ['deck:X'],
      isAgent: true,
      timestamp: Date.now(),
      activeIntents: [],
    });

    expect(fireCount).toBe(2);
    expect(intents.others).toHaveLength(0);
  });

  it('does not fire when a frame leaves intent state unchanged', () => {
    const stub = makeStubSyncAgent();
    const intents = createIntentStream(stub, 'me');

    let fireCount = 0;
    intents.subscribe(() => {
      fireCount++;
    });

    // First frame — no intents, participant has no existing intents in
    // the map → prune loop is a no-op → no listener call.
    stub.fireFakePresence({
      kind: 'enter',
      userId: 'peer-1',
      status: 'online',
      syncGroups: ['deck:X'],
      isAgent: false,
      timestamp: Date.now(),
      activeIntents: [],
    });
    expect(fireCount).toBe(0);
  });

  it('ignores self-echo intent frames', () => {
    // Server echoes our own presence_update back (carrying our own
    // activeIntents). Those echoes must NOT appear in `.others`.
    const stub = makeStubSyncAgent();
    const intents = createIntentStream(stub, 'me');

    let fireCount = 0;
    intents.subscribe(() => {
      fireCount++;
    });

    stub.fireFakePresence({
      kind: 'enter',
      userId: 'me', // self echo
      status: 'online',
      syncGroups: ['deck:X'],
      isAgent: false,
      timestamp: Date.now(),
      activeIntents: [
        {
          intentId: 'my-intent',
          entityType: 'Slide',
          entityId: 's-1',
          action: 'editing',
          declaredAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      ],
    });

    expect(fireCount).toBe(0);
    expect(intents.others).toHaveLength(0);
  });

  it('supports unsubscribe', () => {
    const stub = makeStubSyncAgent();
    const intents = createIntentStream(stub, 'me');

    let fireCount = 0;
    const unsubscribe = intents.subscribe(() => {
      fireCount++;
    });

    stub.fireFakePresence({
      kind: 'enter',
      userId: 'peer-1',
      status: 'online',
      syncGroups: ['deck:X'],
      isAgent: true,
      timestamp: Date.now(),
      activeIntents: [
        {
          intentId: 'intent-1',
          entityType: 'Slide',
          entityId: 's-1',
          action: 'editing',
          declaredAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      ],
    });
    expect(fireCount).toBe(1);

    unsubscribe();

    stub.fireFakePresence({
      kind: 'enter',
      userId: 'peer-2',
      status: 'online',
      syncGroups: ['deck:X'],
      isAgent: true,
      timestamp: Date.now(),
      activeIntents: [
        {
          intentId: 'intent-2',
          entityType: 'Slide',
          entityId: 's-2',
          action: 'editing',
          declaredAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      ],
    });
    expect(fireCount).toBe(1); // unsubscribed, no fire
    // Underlying state still updates regardless of subscription.
    expect(intents.others).toHaveLength(2);
  });
});
