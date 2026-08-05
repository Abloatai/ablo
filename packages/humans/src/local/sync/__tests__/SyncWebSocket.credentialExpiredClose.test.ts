/**
 * 4001 `credential_expired` close — access-credential expiry vs session loss.
 *
 * The hub's keepalive reaper closes sockets whose SHORT-LIVED access
 * credential (`ek_`/`rk_`) passed its expiry with `4001 'credential_expired'`
 * (Hub.ts keepalive loop). That is the WS analog of HTTP's `apikey_expired`:
 * re-mintable from the still-valid login, never a sign-out. Pre-fix, the
 * client collapsed it into the terminal session latch:
 *
 *   - `_sessionErrorDetected` was write-once (no clear path), so a latched
 *     socket could never reconnect — even after a successful re-mint.
 *   - `notConnectedError()` stamped the transient `ws_not_ready`, so the
 *     MutationQueue parked commits for a reconnect that was suppressed —
 *     the retry-forever wedge.
 *
 * Pins the two client-side halves of the fix:
 *   1. `clearSessionError()` un-latches so the store's credential recovery
 *      (BaseSyncedStore session_error handler → re-mint → reconnect) works.
 *   2. A latched socket rejects sends with the PERMANENT `AbloSessionError`
 *      (`session_expired`, retryable=false) naming the close reason, while
 *      ordinary not-connected rejections keep the transient `ws_not_ready`
 *      contract.
 *
 * Harness mirrors SyncWebSocket.closingRace.test.ts: stub the global
 * `WebSocket` with a fake whose events we fire by hand.
 */
import { afterEach, describe, expect, it } from '@jest/globals';
import { SyncWebSocket } from '../SyncWebSocket.js';
import {
  AbloConnectionError,
  AbloSessionError,
  isAccessCredentialExpiryCloseReason,
} from '@abloatai/transaction/errors';
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

/** Fire a hand-stubbed socket's event, failing loudly if it was never wired. */
function fireOpen(socket: FakeWebSocket): void {
  if (!socket.onopen) throw new Error('expected socket.onopen to be wired');
  socket.onopen();
}
function fireClose(
  socket: FakeWebSocket,
  ev: { code: number; reason: string; wasClean: boolean },
): void {
  if (!socket.onclose) throw new Error('expected socket.onclose to be wired');
  socket.onclose(ev);
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
  fireOpen(socket);
  return { ws, socket };
}

const CREDENTIAL_EXPIRED_CLOSE = {
  code: 4001,
  reason: 'credential_expired',
  wasClean: true,
};

describe('4001 credential_expired close', () => {
  const realWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  let active: SyncWebSocket | null = null;

  afterEach(() => {
    active?.disconnect();
    active = null;
    FakeWebSocket.instances = [];
    (globalThis as { WebSocket?: unknown }).WebSocket = realWebSocket;
    resetRuntime();
  });

  it('emits session_error carrying the close reason and latches reconnection', () => {
    const { ws, socket } = openSyncWebSocket();
    active = ws;

    const sessionErrors: Error[] = [];
    ws.subscribe('session_error', (error: Error) => sessionErrors.push(error));

    socket.readyState = FakeWebSocket.CLOSED;
    fireClose(socket, CREDENTIAL_EXPIRED_CLOSE);

    expect(sessionErrors).toHaveLength(1);
    const error = sessionErrors[0];
    if (!error) throw new Error('expected a session_error to have been emitted');
    expect(AbloSessionError.isSessionError(error)).toBe(true);
    // The store's session_error handler branches on the reason travelling in
    // the message — this is the contract that routes credential expiry to the
    // silent re-mint path instead of sign-out.
    expect(isAccessCredentialExpiryCloseReason(error.message)).toBe(true);

    // Latched: connect() is suppressed, no new socket.
    ws.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(ws.getConnectionDiagnostics().sessionErrorDetected).toBe(true);
  });

  it('clearSessionError() un-latches so a post-re-mint reconnect works', () => {
    const { ws, socket } = openSyncWebSocket();
    active = ws;

    socket.readyState = FakeWebSocket.CLOSED;
    fireClose(socket, CREDENTIAL_EXPIRED_CLOSE);
    ws.connect();
    expect(FakeWebSocket.instances).toHaveLength(1); // still latched

    // What the store's credential recovery does after a successful re-mint.
    ws.clearSessionError();
    ws.connect();

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(ws.getConnectionDiagnostics().sessionErrorDetected).toBe(false);
    const reconnect = FakeWebSocket.instances[1];
    if (!reconnect) throw new Error('expected a reconnect socket');
    fireOpen(reconnect);
    expect(ws.isConnected()).toBe(true);
  });

  it('a latched socket rejects sends with the PERMANENT session type, naming the reason', async () => {
    const { ws, socket } = openSyncWebSocket();
    active = ws;

    socket.readyState = FakeWebSocket.CLOSED;
    fireClose(socket, CREDENTIAL_EXPIRED_CLOSE);

    const rejection = await ws.sendCommit([], 'tx-1').catch((e: unknown) => e);

    // AbloSessionError (code `session_expired`, retryable=false) — the
    // MutationQueue's `isPermanentError` surfaces it to the caller as
    // "re-authenticate" instead of parking the commit for a reconnect the
    // latch suppresses (the old ws_not_ready retry-forever wedge).
    expect(rejection).toBeInstanceOf(AbloSessionError);
    expect(rejection).not.toBeInstanceOf(AbloConnectionError);
    expect((rejection as AbloSessionError).message).toContain('credential_expired');
    expect(
      (rejection as AbloSessionError & { diagnostics: { lastCloseCode: number | null } })
        .diagnostics.lastCloseCode,
    ).toBe(4001);
  });

  it('an ordinary not-connected rejection keeps the transient ws_not_ready contract', async () => {
    const { ws, socket } = openSyncWebSocket();
    active = ws;

    // Plain network drop — no session close code.
    socket.readyState = FakeWebSocket.CLOSED;
    fireClose(socket, { code: 1006, reason: '', wasClean: false });

    const rejection = await ws.sendCommit([], 'tx-2').catch((e: unknown) => e);

    expect(rejection).toBeInstanceOf(AbloConnectionError);
    expect((rejection as AbloConnectionError).code).toBe('ws_not_ready');
  });
});

describe('isAccessCredentialExpiryCloseReason', () => {
  it('classifies only re-mintable access-credential expiry as recoverable', () => {
    // The hub keepalive reaper's literal reason.
    expect(isAccessCredentialExpiryCloseReason('credential_expired')).toBe(true);
    // Registry code with recovery `access_credential_expiry`.
    expect(isAccessCredentialExpiryCloseReason('apikey_expired')).toBe(true);

    // Revocation and genuine session loss stay terminal — a revoked
    // credential must not be silently re-minted around.
    expect(isAccessCredentialExpiryCloseReason('revoked')).toBe(false);
    expect(isAccessCredentialExpiryCloseReason('session_expired')).toBe(false);
    expect(isAccessCredentialExpiryCloseReason('Session expired')).toBe(false);
    expect(isAccessCredentialExpiryCloseReason('')).toBe(false);
  });
});
