/**
 * BaseSyncedStore — credential-lifecycle callback ordering.
 *
 * The credential lifecycle is constructed as a class-field initializer, which
 * runs before the constructor body fills `this.auth` and long before
 * `this.connectionManager` exists. Its three callbacks are therefore
 * lazily-resolved — they read those fields at call time, not capture time.
 * This pins that ordering: every lifecycle entry point is safe to drive on a
 * freshly constructed store, before any socket or connection FSM exists.
 *
 * Unlike the sibling suites, this uses the REAL constructor (with minimal
 * fake collaborators) — construction order is exactly what is under test, and
 * an `Object.create` shell would skip it.
 */

import { BaseSyncedStore } from '../../src/local/BaseSyncedStore';
import type { SyncClient } from '../../src/local/SyncClient';
import type { Database } from '../../src/local/Database';
import type { InstanceCache } from '../../src/local/InstanceCache';
import { ModelRegistry } from '../../src/local/ModelRegistry';
import type { AuthCredentialSource } from '@abloatai/transaction/auth/credentialSource';
import { initRuntime, resetRuntime } from '../../src/local/context.js';
import {
  noopLogger,
  noopObservability,
  browserOnlineStatus,
  defaultSessionErrorDetector,
  emptyConfig,
} from '../../src/local/RuntimeContext.js';

function makeAuth(): AuthCredentialSource & { tokens: string[] } {
  const tokens: string[] = [];
  let current: string | null = null;
  return {
    tokens,
    getAuthToken: () => current,
    setAuthToken: (token: string) => {
      current = token;
      tokens.push(token);
    },
  };
}

function makeStore(auth: AuthCredentialSource) {
  // Structural fakes: the constructor touches only these members, and the
  // Pick keeps each signature exact so a single assertion suffices.
  const wired: unknown[] = [];
  const syncClient: Pick<SyncClient, 'on' | 'onTransactionEvent'> = {
    on: (event, listener) => {
      wired.push(event, listener);
      return syncClient as SyncClient;
    },
    onTransactionEvent: () => () => undefined,
  };
  const objectPool: Pick<InstanceCache, 'registerForeignKey'> = {
    registerForeignKey: () => undefined,
  };
  return new BaseSyncedStore({
    syncClient: syncClient as SyncClient,
    database: {} as Database,
    objectPool: objectPool as InstanceCache,
    modelRegistry: new ModelRegistry(),
    auth,
  });
}

describe('BaseSyncedStore — credential lifecycle before any connection exists', () => {
  beforeEach(() => {
    initRuntime({
      logger: noopLogger,
      observability: noopObservability,
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
  });

  afterEach(() => {
    resetRuntime();
  });

  it('performCredentialRefresh mints and pushes the token into the live auth source', async () => {
    const auth = makeAuth();
    const store = makeStore(auth);
    store.setCredentialRefresher(() => Promise.resolve('ek_fresh'));

    await expect(store.performCredentialRefresh()).resolves.toBe('refreshed');
    expect(auth.tokens).toEqual(['ek_fresh']);
    expect(auth.getAuthToken()).toBe('ek_fresh');
  });

  it('recoverFromAuthRejection replays through the nudge even with no connection FSM', async () => {
    const auth = makeAuth();
    const store = makeStore(auth);
    store.setCredentialRefresher(() => Promise.resolve('ek_replayed'));

    // 'retry' requires the nudgeReconnect callback to tolerate the
    // still-null connectionManager — the ordering under test.
    await expect(
      store.recoverFromAuthRejection('access_credential_expiry'),
    ).resolves.toBe('retry');
    expect(auth.getAuthToken()).toBe('ek_replayed');
  });

  it('nudgeReconnect is a safe no-op before the connection FSM exists', () => {
    const store = makeStore(makeAuth());
    expect(() => { store.nudgeReconnect(); }).not.toThrow();
  });

  it('a null mint reports session expiry without a session-error listener in place', async () => {
    const auth = makeAuth();
    const store = makeStore(auth);
    store.setCredentialRefresher(() => Promise.resolve(null));

    // reportSessionExpired reaches through connectionManager?.send — also
    // null here — and must not throw.
    await expect(store.performCredentialRefresh()).resolves.toBe('session_error');
    expect(auth.tokens).toEqual([]);
  });
});
