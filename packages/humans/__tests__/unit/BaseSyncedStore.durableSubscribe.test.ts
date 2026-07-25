/**
 * BaseSyncedStore.subscribe — durable frame subscriptions (ADR 0016).
 *
 * The connection object is host-built and stable for the store's lifetime;
 * `subscribe()` is a plain delegate onto it. Durability is a property of
 * that construction, and this pins it: a subscription made before the
 * connection ever opens delivers once it does, it survives the socket
 * *inside* the connection being replaced across reconnects (the only churn
 * that exists — the wrapper is never rebuilt), and unsubscribing stops
 * delivery for good.
 *
 * Harness: `Object.create(BaseSyncedStore.prototype)` shell holding a real
 * `SyncWebSocket` + the FakeWebSocket global stub (the
 * credentialExpiredRecovery pattern); the whole inbound frame path is real.
 */

import { BaseSyncedStore } from '../../src/local/BaseSyncedStore';
import { SyncWebSocket } from '../../src/local/sync/SyncWebSocket';
import { initRuntime, resetRuntime } from '../../src/local/context.js';
import { ClaimLog } from '../../src/local/coordination/ClaimLog.js';
import {
  noopLogger,
  browserOnlineStatus,
  defaultSessionErrorDetector,
  emptyConfig,
} from '../../src/local/RuntimeContext.js';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  readonly sent: string[] = [];
  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

interface CursorEvents {
  'slide:cursor': [{ deckId: string; slideId: string; x: number; y: number }];
}

type Store = BaseSyncedStore<CursorEvents>;

/** The slice of the store the suite drives: the two public methods under
 *  test, plus the (protected-on-the-class) connection field the shell fills. */
interface StoreShell {
  syncWebSocket: SyncWebSocket<CursorEvents>;
  subscribe: Store['subscribe'];
  sendCollaborationEvent: Store['sendCollaborationEvent'];
}

const liveConnections: SyncWebSocket<CursorEvents>[] = [];

function makeStore(): { store: StoreShell; ws: SyncWebSocket<CursorEvents> } {
  const ws = new SyncWebSocket<CursorEvents>({
    baseUrl: 'http://localhost:8080',
    collaborationEvents: ['slide:cursor'],
  });
  liveConnections.push(ws);
  const store = Object.create(BaseSyncedStore.prototype) as StoreShell;
  store.syncWebSocket = ws;
  return { store, ws };
}

/** Open the connection through its full open ritual; returns the inner socket. */
function openInnerSocket(ws: SyncWebSocket<CursorEvents>): FakeWebSocket {
  ws.connect();
  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  socket.onopen?.();
  return socket;
}

function deliverCursorFrame(socket: FakeWebSocket, x: number): void {
  socket.onmessage?.({
    data: JSON.stringify({
      type: 'slide_cursor',
      payload: { deckId: 'd1', slideId: 's1', x, y: 0 },
    }),
  });
}

describe('BaseSyncedStore.subscribe — durable across inner-socket churn', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
    initRuntime({
      logger: noopLogger,
      observability: new ClaimLog(),
      onlineStatus: browserOnlineStatus,
      sessionErrorDetector: defaultSessionErrorDetector,
      config: emptyConfig,
      mutationExecutor: {
        commit: () => Promise.resolve({ lastSyncId: 0 }),
        executeCreate: () => Promise.resolve(),
        executeUpdate: () => Promise.resolve(null),
        executeDelete: () => Promise.resolve(),
        executeArchive: () => Promise.resolve(),
        executeUnarchive: () => Promise.resolve(),
      },
    });
  });

  afterEach(() => {
    for (const ws of liveConnections.splice(0)) ws.disconnect();
    resetRuntime();
    delete (globalThis as { WebSocket?: unknown }).WebSocket;
  });

  it('a subscription made before the connection opens delivers once it does', () => {
    const { store, ws } = makeStore();
    const handler = jest.fn();

    store.subscribe('slide:cursor', handler);
    const socket = openInnerSocket(ws);
    deliverCursorFrame(socket, 10);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ deckId: 'd1', x: 10 }),
    );
  });

  it('survives the inner socket being replaced, and the dead socket stops delivering', () => {
    const { store, ws } = makeStore();
    const handler = jest.fn();
    store.subscribe('slide:cursor', handler);

    const first = openInnerSocket(ws);
    deliverCursorFrame(first, 1);
    expect(handler).toHaveBeenCalledTimes(1);

    // Reconnect: a fresh socket replaces the old one inside the same
    // connection object — the only rebuild that exists.
    ws.disconnect();
    const second = openInnerSocket(ws);
    expect(second).not.toBe(first);
    deliverCursorFrame(second, 2);
    expect(handler).toHaveBeenCalledTimes(2);

    // A late frame on the dead socket is dropped by the stale-socket guard —
    // it must not double-deliver through the wrapper's handler.
    deliverCursorFrame(first, 3);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('unsubscribing stops delivery and survives no reconnect', () => {
    const { store, ws } = makeStore();
    const handler = jest.fn();
    const unsubscribe = store.subscribe('slide:cursor', handler);

    const first = openInnerSocket(ws);
    deliverCursorFrame(first, 1);
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();
    deliverCursorFrame(first, 2);
    expect(handler).toHaveBeenCalledTimes(1);

    // Even a fresh inner socket must not resurrect a removed subscription.
    ws.disconnect();
    const second = openInnerSocket(ws);
    deliverCursorFrame(second, 3);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('sendCollaborationEvent is a no-op before connect and sends once live', () => {
    const { store, ws } = makeStore();

    // No socket yet — must not throw (state frames drop, per the
    // send-during-reconnect contract).
    store.sendCollaborationEvent('slide:cursor', {
      deckId: 'd1',
      slideId: 's1',
      x: 5,
      y: 6,
    });

    const socket = openInnerSocket(ws);
    store.sendCollaborationEvent('slide:cursor', {
      deckId: 'd1',
      slideId: 's1',
      x: 5,
      y: 6,
    });

    const frames = socket.sent.map((raw) => JSON.parse(raw) as { type: string });
    expect(frames.some((f) => f.type === 'slide_cursor')).toBe(true);
  });
});
