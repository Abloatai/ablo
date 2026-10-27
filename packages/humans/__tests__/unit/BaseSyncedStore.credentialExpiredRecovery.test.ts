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

import { BaseSyncedStore, type UserContext } from '../../src/local/BaseSyncedStore';
import { storeDependencies } from '../../src/local/testing/helpers/storeDependencies';
import { ClaimLog } from '../../src/local/coordination/ClaimLog.js';
import { initRuntime, resetRuntime } from '../../src/local/context.js';
import {
  noopLogger,
  browserOnlineStatus,
  defaultSessionErrorDetector,
  emptyConfig,
} from '../../src/local/RuntimeContext.js';
import { SyncWebSocket } from '../../src/local/sync/SyncWebSocket';

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

/** A real store whose seed-and-connect step and socket a test can reach. */
class RecoveryProbe extends BaseSyncedStore {
  protected override updateSyncStatus(): void {}
  seedAndConnect(context: UserContext, lastSyncId: number): void {
    this.setupWebSocketSync(context, lastSyncId);
  }
  get socket(): SyncWebSocket {
    return this.syncWebSocket;
  }
}

interface Shell {
  store: RecoveryProbe;
  refresher: jest.Mock;
  databaseClear: jest.SpyInstance;
  objectPoolClear: jest.SpyInstance;
  sessionErrorListener: jest.Mock;
  syncWebSocket: () => SyncWebSocket;
}

/**
 * A real store over real collaborators. The credential refresher and the
 * session-error listener go in through the store's public hooks, and the two
 * purge targets are spied, so the recovery branch runs exactly as shipped.
 */
function makeShell(refreshResult: string | null): Shell {
  const deps = storeDependencies('http://localhost:8080');
  // The connection is a constructor dependency, held closed as the host builds it.
  const ws = new SyncWebSocket({ baseUrl: 'http://localhost:8080', deferConnect: true });
  const store = new RecoveryProbe({ ...deps, syncWebSocket: ws });
  const refresher = jest.fn(() => Promise.resolve(refreshResult));
  store.setCredentialRefresher(refresher);
  const sessionErrorListener = jest.fn();
  store.subscribeSessionError(sessionErrorListener);
  return {
    store,
    refresher,
    databaseClear: jest.spyOn(deps.database, 'purgePersistence').mockResolvedValue(undefined),
    objectPoolClear: jest.spyOn(deps.objectPool, 'clear').mockImplementation(() => undefined),
    sessionErrorListener,
    syncWebSocket: () => store.socket,
  };
}

/** Agent context: `createConnectionManager` returns null → no FSM, the
 *  recovery branch must reconnect the socket directly. */
const AGENT_CONTEXT: UserContext = {
  userId: 'u1',
  organizationId: 'org1',
  branchId: 'br1',
  kind: 'agent',
};

function setup(refreshResult: string | null): Shell & { socket: FakeWebSocket } {
  initRuntime({
    logger: noopLogger,
    observability: new ClaimLog(),
    onlineStatus: browserOnlineStatus,
    sessionErrorDetector: defaultSessionErrorDetector,
    config: emptyConfig,
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
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;

  const shell = makeShell(refreshResult);
  // The constructor already wired the socket events; this is the seed-and-connect
  // step initialize() runs next.
  shell.store.seedAndConnect(AGENT_CONTEXT, 0);

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
    reconnect.onmessage?.({ data: JSON.stringify({
      type: 'presence_session',
      payload: {
        presenceSessionId: '00000000-0000-4000-8000-000000000001',
        resumed: true,
      },
    }) });
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
