/**
 * BaseSyncedStore session_error routing — access-credential expiry vs
 * terminal session loss.
 *
 * The hub's keepalive reaper closes sockets whose short-lived access
 * credential (`ek_`/`rk_`) passed its expiry with `4001 'credential_expired'`.
 * Pre-fix, the store's session_error handler treated EVERY session close as
 * terminal: notify sign-out listeners, clear IndexedDB + object pool, and
 * leave the socket behind the write-once `_sessionErrorDetected` latch — so a
 * long-running agent whose `rk_` TTL elapsed lost its local state and could
 * never reconnect, even with a credential refresher wired.
 *
 * Pins the recovery branch: a `credential_expired` close silently re-mints
 * through the single-flight CredentialLifecycle, un-latches, and reconnects
 * (directly for agents — `createConnectionManager` returns null for
 * kind 'agent', so there is no FSM to drive it). Local data survives and
 * sign-out listeners stay silent. Only a mint that answers `null` (the login
 * itself is gone) or a NON-expiry close reason (revocation) runs the terminal
 * path.
 *
 * Harness: `Object.create(BaseSyncedStore.prototype)` shell (the
 * createConnectionManager.test.ts pattern) + the FakeWebSocket global stub
 * (the SyncWebSocket.closingRace.test.ts pattern). The shell holds a real
 * host-built `SyncWebSocket`; `wireSocketEvents`, `setupWebSocketSync`, and
 * every handler under test are real.
 */

import { BaseSyncedStore } from '../../src/local/BaseSyncedStore';
import { globalRuntime } from '../../src/local/context.js';
import { SubscriptionManager } from '../../src/local/sync/SubscriptionManager';
import { CredentialLifecycle } from '../../src/local/sync/credentialLifecycle';
import { ClaimLog } from '../../src/local/coordination/ClaimLog.js';
import { initRuntime, resetRuntime } from '../../src/local/context.js';
import {
  noopLogger,
  browserOnlineStatus,
  defaultSessionErrorDetector,
  emptyConfig,
} from '../../src/local/RuntimeContext.js';
import { SyncWebSocket } from '../../src/local/sync/SyncWebSocket';
import { TerminalSessionLifecycle } from '../../src/local/sync/terminalSessionLifecycle';

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

/** Flush the promise chain behind the recovery branch (`performCredentialRefresh().then`). */
async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

interface Shell {
  store: BaseSyncedStore;
  refresher: jest.Mock;
  databaseClear: jest.Mock;
  objectPoolClear: jest.Mock;
  sessionErrorListener: jest.Mock;
  syncWebSocket: () => SyncWebSocket;
}

/**
 * Minimal store shell for `setupWebSocketSync`. `Object.create` skips the
 * heavy constructor (and class property initializers), so every field the
 * method + handlers under test touch is provided explicitly.
 */
function makeShell(refreshResult: string | null): Shell {
  const refresher = jest.fn(() => Promise.resolve(refreshResult));
  const databaseClear = jest.fn(() => Promise.resolve());
  const objectPoolClear = jest.fn();
  const sessionErrorListener = jest.fn();

  const shell = Object.create(BaseSyncedStore.prototype) as Record<string, unknown>;
  shell.runtime = globalRuntime;
  shell._syncServerUrl = 'http://localhost:8080';
  // The connection is a constructor dependency now — the shell holds a real
  // one, held closed exactly as the host builds it.
  const ws = new SyncWebSocket({
    baseUrl: 'http://localhost:8080',
    deferConnect: true,
  });
  shell.syncWebSocket = ws;
  shell.areaOfInterest = new SubscriptionManager({ transport: ws, sweepIntervalMs: 0 });
  // `Object.create` skips the class field initializers, so anything the real
  // constructor would have defaulted has to be set here too.
  shell._collaborationEvents = [];
  shell.auth = undefined;
  shell.dataReady = false;
  shell.disposers = [];
  shell.sessionErrorListeners = new Set([sessionErrorListener]);
  shell.database = { clear: databaseClear };
  shell.objectPool = { clear: objectPoolClear };
  shell.syncClient = {
    markConnected: () => {
      /* test stub */
    },
    disconnect: () => {
      /* test stub */
    },
    onTransactionEvent: () => () => {
      /* unsubscribe */
    },
  };
  shell.updateSyncStatus = jest.fn();
  shell.syncStatus = { state: 'idle' };
  shell.terminalSessionLifecycle = new TerminalSessionLifecycle({
    runtime: globalRuntime,
    listeners: shell.sessionErrorListeners as Set<(error: Error) => void>,
    purgeAuthenticatedState: async () => {
      await databaseClear();
      objectPoolClear();
    },
    updateSyncStatus: shell.updateSyncStatus as (updates: object) => void,
  });
  // Real lifecycle — the single-flight + tri-state contract under test.
  const lifecycle = new CredentialLifecycle({
    setAuthToken: () => {
      /* test stub */
    },
    nudgeReconnect: () => {
      /* test stub */
    },
    reportSessionExpired: () => {
      /* test stub */
    },
  });
  lifecycle.setRefresher(refresher);
  shell.credentialLifecycle = lifecycle;

  const store = shell as unknown as BaseSyncedStore;
  return {
    store,
    refresher,
    databaseClear,
    objectPoolClear,
    sessionErrorListener,
    syncWebSocket: () => {
      const ws = (shell as { syncWebSocket?: SyncWebSocket }).syncWebSocket;
      if (!ws) throw new Error('expected setupWebSocketSync to set syncWebSocket');
      return ws;
    },
  };
}

/** Agent context: `createConnectionManager` returns null → no FSM, the
 *  recovery branch must reconnect the socket directly. */
const AGENT_CONTEXT = {
  userId: 'u1',
  organizationId: 'org1',
  kind: 'agent' as const,
};

function setup(refreshResult: string | null): Shell & { socket: FakeWebSocket } {
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
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;

  const shell = makeShell(refreshResult);
  const driver = shell.store as unknown as {
    wireSocketEvents(): void;
    setupWebSocketSync(context: typeof AGENT_CONTEXT, lastSyncId: number): void;
  };
  // Construction-time wiring first, then the seed-and-connect step — the
  // same order the real constructor + initialize() run them in.
  driver.wireSocketEvents();
  driver.setupWebSocketSync(AGENT_CONTEXT, 0);

  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (!socket?.onopen) throw new Error('expected setupWebSocketSync to construct an open socket');
  socket.onopen();
  return { ...shell, socket };
}

function closeWith(socket: FakeWebSocket, code: number, reason: string): void {
  socket.readyState = FakeWebSocket.CLOSED;
  if (!socket.onclose) throw new Error('expected socket.onclose to be wired');
  socket.onclose({ code, reason, wasClean: true });
}

describe('BaseSyncedStore session_error routing (4001 credential_expired)', () => {
  const realWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  let shell: (Shell & { socket: FakeWebSocket }) | null = null;

  afterEach(() => {
    shell?.syncWebSocket().disconnect();
    shell = null;
    FakeWebSocket.instances = [];
    (globalThis as { WebSocket?: unknown }).WebSocket = realWebSocket;
    resetRuntime();
  });

  it('credential_expired → silent re-mint + direct reconnect; no sign-out, local data survives', async () => {
    shell = setup('rk_fresh_token');

    closeWith(shell.socket, 4001, 'credential_expired');
    await flushAsync();

    // Re-minted through the lifecycle, exactly once.
    expect(shell.refresher).toHaveBeenCalledTimes(1);
    // Silent: no sign-out listener fired, no local-data clear.
    expect(shell.sessionErrorListener).not.toHaveBeenCalled();
    expect(shell.databaseClear).not.toHaveBeenCalled();
    expect(shell.objectPoolClear).not.toHaveBeenCalled();
    // Un-latched and reconnected DIRECTLY (agents have no connection FSM).
    expect(shell.syncWebSocket().getConnectionDiagnostics().sessionErrorDetected).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const reconnect = FakeWebSocket.instances[1];
    if (!reconnect?.onopen) throw new Error('expected a reconnect socket with onopen');
    reconnect.onopen();
    expect(shell.syncWebSocket().isConnected()).toBe(true);
  });

  it('credential_expired but the mint answers null (login gone) → terminal path, re-latched', async () => {
    shell = setup(null);

    closeWith(shell.socket, 4001, 'credential_expired');
    await flushAsync();

    expect(shell.refresher).toHaveBeenCalledTimes(1);
    // Terminal: sign-out listener fired, local data cleared, no reconnect.
    expect(shell.sessionErrorListener).toHaveBeenCalledTimes(1);
    expect(shell.databaseClear).toHaveBeenCalledTimes(1);
    expect(shell.objectPoolClear).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    // Re-latched so writes reject with the permanent session type.
    expect(shell.syncWebSocket().getConnectionDiagnostics().sessionErrorDetected).toBe(true);
  });

  it('a non-expiry session close (revocation) stays terminal and never re-mints', async () => {
    shell = setup('rk_fresh_token');

    closeWith(shell.socket, 4001, 'revoked');
    await flushAsync();

    // A revoked credential must not be silently re-minted around.
    expect(shell.refresher).not.toHaveBeenCalled();
    expect(shell.sessionErrorListener).toHaveBeenCalledTimes(1);
    expect(shell.databaseClear).toHaveBeenCalledTimes(1);
    expect(shell.objectPoolClear).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(shell.syncWebSocket().getConnectionDiagnostics().sessionErrorDetected).toBe(true);
  });
});
