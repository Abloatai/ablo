/**
 * CLOSING-socket race (production-doctor T1.18).
 *
 * The bug: `connect()`'s busy guard only checked OPEN, and the old socket's
 * `onclose` unconditionally ran `this.ws = null; stopCatchupInterval();
 * stopHeartbeat()`. Sequence that orphaned a live connection:
 *
 *   1. socket A drops (network flap) — the browser queues its close event
 *   2. `connect()` runs first, sees A not-OPEN, creates socket B
 *   3. A's delayed `onclose` fires and clobbers B: nulls `this.ws`,
 *      kills B's timers, schedules a duplicate reconnect
 *
 * B keeps receiving deltas (zombie) but every send path and `isConnected()`
 * is broken. The fix captures `const socket = this.ws` per
 * `setupEventHandlers` call and guards each handler on socket identity;
 * `connect()` additionally treats CLOSING as busy.
 *
 * Harness mirrors ws-observability-wiring.test.ts: stub the global
 * `WebSocket` with a fake whose events we fire by hand — the handlers under
 * test are the real ones.
 */
import { afterEach, describe, expect, it } from '@jest/globals';
import { SyncWebSocket } from '../SyncWebSocket.js';
import { ClaimLog } from '../../coordination/ClaimLog.js';
import { initRuntime, resetRuntime } from '../../context.js';
import {
  noopLogger,
  browserOnlineStatus,
  defaultSessionErrorDetector,
  emptyConfig,
} from '../../RuntimeContext.js';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  /** Every socket `connect()` constructed, in order. */
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

function installContext(): void {
  initRuntime({
    logger: noopLogger,
    observability: new ClaimLog(),
    onlineStatus: browserOnlineStatus,
    sessionErrorDetector: defaultSessionErrorDetector,
    config: emptyConfig,
    getModelMetadata: () => undefined,
    mutationExecutor: {
      commit: () => Promise.resolve({
        lastSyncId: 0,
        status: 'confirmed' as const,
        statusAt: '2026-08-05T10:00:00.058Z',
      }),
      executeCreate: () => Promise.resolve(),
      executeUpdate: () => Promise.resolve(null),
      executeDelete: () => Promise.resolve(),
      executeArchive: () => Promise.resolve(),
      executeUnarchive: () => Promise.resolve(),
    },
  });
}

function openSyncWebSocket(): { ws: SyncWebSocket; socket: FakeWebSocket } {
  installContext();
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
  const ws = new SyncWebSocket({
    baseUrl: 'http://localhost:8080',
    syncGroups: [],
    userId: 'u1',
    organizationId: 'org1',
  });
  ws.connect();
  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (!socket) throw new Error('expected connect() to construct a socket');
  socket.onopen!();
  return { ws, socket };
}

const CLOSE_1006 = { code: 1006, reason: '', wasClean: false };

describe('SyncWebSocket CLOSING-socket race (T1.18)', () => {
  const realWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  let active: SyncWebSocket | null = null;

  afterEach(() => {
    active?.disconnect();
    active = null;
    FakeWebSocket.instances = [];
    (globalThis as { WebSocket?: unknown }).WebSocket = realWebSocket;
    resetRuntime();
  });

  it('a stale socket closing AFTER a new socket opened does not orphan the new one', () => {
    const { ws, socket: socketA } = openSyncWebSocket();
    active = ws;

    const disconnected: unknown[] = [];
    const reconnecting: unknown[] = [];
    ws.subscribe('disconnected', (ev) => disconnected.push(ev));
    ws.subscribe('reconnecting', (ev) => reconnecting.push(ev));

    // Network flap: A dies abruptly. The close EVENT is delayed (queued
    // behind other work) — exactly the window the race lives in.
    socketA.readyState = FakeWebSocket.CLOSED;

    // Reconnect wins the race: connect() sees a CLOSED socket and creates B.
    ws.connect();
    expect(FakeWebSocket.instances).toHaveLength(2);
    const socketB = FakeWebSocket.instances[1];
    if (!socketB) throw new Error('expected connect() to construct a second socket');
    socketB.onopen!();
    expect(ws.isConnected()).toBe(true);

    // A's delayed close event finally lands. Pre-fix this nulled this.ws,
    // stopped B's catch-up/heartbeat timers, and scheduled a duplicate
    // reconnect cycle.
    socketA.onclose!(CLOSE_1006);

    // B is still the live connection and no stale lifecycle events leaked.
    expect(ws.isConnected()).toBe(true);
    expect(ws.getConnectionDiagnostics().readyState).toBe(FakeWebSocket.OPEN);
    expect(disconnected).toHaveLength(0);
    expect(reconnecting).toHaveLength(0);

    // The current socket's own close still runs the full path.
    socketB.readyState = FakeWebSocket.CLOSED;
    socketB.onclose!(CLOSE_1006);
    expect(ws.isConnected()).toBe(false);
    expect(disconnected).toHaveLength(1);
  });

  it('connect() treats a CLOSING socket as busy instead of overwriting it', () => {
    const { ws, socket: socketA } = openSyncWebSocket();
    active = ws;

    // Close teardown in flight — onclose has not fired yet.
    socketA.readyState = FakeWebSocket.CLOSING;
    ws.connect();

    // No second socket: the pending onclose owns scheduling the reconnect.
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('manual disconnect still runs the full close path (rejects + emits disconnected)', () => {
    const { ws, socket: socketA } = openSyncWebSocket();
    active = ws;

    const disconnected: unknown[] = [];
    const reconnecting: unknown[] = [];
    ws.subscribe('disconnected', (ev) => disconnected.push(ev));
    ws.subscribe('reconnecting', (ev) => reconnecting.push(ev));

    // disconnect() nulls this.ws BEFORE the close event lands — the onclose
    // guard deliberately lets a nulled host through so consumers still get
    // their 'disconnected' signal.
    ws.disconnect();
    socketA.onclose!({ code: 1000, reason: 'Manual disconnect', wasClean: true });

    expect(disconnected).toHaveLength(1);
    expect(reconnecting).toHaveLength(0); // manual close never reconnects
  });
});
