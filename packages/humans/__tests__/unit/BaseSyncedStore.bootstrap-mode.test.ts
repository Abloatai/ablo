/**
 * BaseSyncedStore — `bootstrapMode: 'none'` skips baseline replication.
 *
 * The agent-worker (and any future transactional participant) opens
 * the WS, authenticates, processes live deltas, but does NOT pull the
 * org's full tenant plane on startup. This test pins that contract:
 *
 *  - `initialize()` with `bootstrapMode: 'none'` MUST NOT call
 *    `database.bootstrapFromServer`.
 *  - It MUST still flip `dataReady` + `initialized` + `syncStatus`
 *    so consumers can issue mutations.
 *  - `bootstrapMode: 'full'` (existing default for users) preserves
 *    legacy behavior — `bootstrapFromServer` is invoked when the
 *    database reports a non-`local` requirement.
 *  - `forceFullRebootstrap()` is a no-op for `'none'` participants.
 *
 * The test drives `initialize()` as a generator with mocked deps,
 * skipping the heavy constructor via `Object.create`. We aren't
 * exercising IDB / WS / pool semantics — those are covered elsewhere
 * — only the bootstrap-skip decision.
 */

import { LogPosition } from '../../src/local/logPosition.js';
import { BaseSyncedStore, type UserContext } from '../../src/local/BaseSyncedStore';
import { globalRuntime } from '../../src/local/context.js';
import type { Database } from '../../src/local/Database';
import type { SyncClient } from '../../src/local/SyncClient';

type GenStep = IteratorResult<Promise<unknown>, { success: boolean; error?: Error }>;

interface InitDeps {
  database: jest.Mocked<Pick<Database,
    | 'open'
    | 'getLastSyncId'
    | 'requiredBootstrap'
    | 'bootstrapFromServer'
    | 'markRequiresFullBootstrap'
  >>;
  syncClient: jest.Mocked<Pick<SyncClient, 'initialize' | 'hydrateFromDatabase'>>;
}

function makeDeps(overrides?: {
  requirementsType?: 'full' | 'partial' | 'local';
}): InitDeps {
  const requirementsType = overrides?.requirementsType ?? 'full';
  return {
    database: {
      open: jest.fn().mockResolvedValue(undefined),
      getLastSyncId: jest.fn().mockResolvedValue(0),
      requiredBootstrap: jest.fn().mockResolvedValue({ type: requirementsType }),
      bootstrapFromServer: jest.fn().mockResolvedValue({
        bootstrapData: { type: 'full', models: {} },
        deltaResults: [],
      }),
      markRequiresFullBootstrap: jest.fn(),
    },
    syncClient: {
      initialize: jest.fn().mockResolvedValue(undefined),
      hydrateFromDatabase: jest.fn().mockResolvedValue(undefined),
      position: new LogPosition(),
    } as unknown as InitDeps['syncClient'],
  };
}

interface StoreStub {
  database: InitDeps['database'];
  syncClient: InitDeps['syncClient'];
  objectPool: { size: number };
  lastAckedId: number;
  highestProcessedSyncId: number;
  initialized: boolean;
  dataReady: boolean;
  userContext: UserContext | null;
  setupWebSocketSync: jest.Mock;
  updateSyncStatus: jest.Mock;
  executeBootstrapWithTimeout: jest.Mock;
  performBackgroundBootstrap: jest.Mock;
  initialize: BaseSyncedStore['initialize'];
  forceFullRebootstrap: () => void;
}

function makeStore(deps: InitDeps): StoreStub {
  // Bypass the real constructor — we only need fields the
  // initialize() generator reads. The intersection types on
  // Database/SyncClient/etc. make a strongly-typed assignment
  // unwieldy, so each field is filled via an `unknown` cast and the
  // returned shape exposes only what the test uses.
  const stub = Object.create(BaseSyncedStore.prototype) as StoreStub;
  const w = stub as unknown as Record<string, unknown>;
  w.runtime = globalRuntime;
  w.database = deps.database;
  w.syncClient = deps.syncClient;
  w.objectPool = { size: 0 };
  // The connection is a constructor dependency now; initialize() reads it as
  // already connected so the bootstrapMode:'none' wait resolves immediately.
  w.syncWebSocket = { isConnected: () => true, disconnect: () => undefined };
  // lastAckedId/highestProcessedSyncId are getters delegating to
  // syncClient.position now — the stub provides a real LogPosition above.
  w.initialized = false;
  w.dataReady = false;
  w.userContext = null;
  w.setupWebSocketSync = jest.fn();
  w.updateSyncStatus = jest.fn();
  // If executeBootstrapWithTimeout fires, it would call
  // bootstrapFromServer for us — but we want to assert directly
  // against bootstrapFromServer, so just delegate the inner fn.
  w.executeBootstrapWithTimeout = jest.fn(
    async (fn: () => Promise<unknown>) => fn(),
  );
  w.performBackgroundBootstrap = jest.fn();
  return stub;
}

async function drive(
  gen: Generator<Promise<unknown>, { success: boolean; error?: Error }, unknown>,
): Promise<{ success: boolean; error?: Error }> {
  let step: GenStep = gen.next();
  while (!step.done) {
    const yielded = step.value;
    const resolved = yielded instanceof Promise ? await yielded : yielded;
    step = gen.next(resolved);
  }
  return step.value;
}

describe('BaseSyncedStore.initialize — bootstrapMode', () => {
  it('skips bootstrapFromServer when bootstrapMode is "none"', async () => {
    const deps = makeDeps({ requirementsType: 'full' });
    const store = makeStore(deps);
    const ctx: UserContext = {
      userId: 'agent:test',
      organizationId: 'org_1',
      kind: 'agent',
      bootstrapMode: 'none',
      syncGroups: ['org:org_1'],
    };

    const result = await drive(store.initialize(ctx));

    expect(result.success).toBe(true);
    expect(deps.database.bootstrapFromServer).not.toHaveBeenCalled();
    expect(deps.database.requiredBootstrap).toHaveBeenCalledTimes(1);
    // Live-delta path must still be wired up.
    expect(store.setupWebSocketSync).toHaveBeenCalledTimes(1);
    expect(store.dataReady).toBe(true);
    expect(store.initialized).toBe(true);
  });

  it('still bootstraps when bootstrapMode is "full" (default user behavior)', async () => {
    const deps = makeDeps({ requirementsType: 'full' });
    const store = makeStore(deps);
    const ctx: UserContext = {
      userId: 'user_1',
      organizationId: 'org_1',
      kind: 'user',
      bootstrapMode: 'full',
      syncGroups: ['org:org_1'],
    };

    const result = await drive(store.initialize(ctx));

    expect(result.success).toBe(true);
    expect(deps.database.bootstrapFromServer).toHaveBeenCalledTimes(1);
  });

  it('skips bootstrap when requirements are local even with bootstrapMode "full"', async () => {
    // Pre-existing branch — ensures we didn't regress it.
    const deps = makeDeps({ requirementsType: 'local' });
    const store = makeStore(deps);
    const ctx: UserContext = {
      userId: 'user_1',
      organizationId: 'org_1',
      kind: 'user',
      bootstrapMode: 'full',
      syncGroups: ['org:org_1'],
    };

    await drive(store.initialize(ctx));
    expect(deps.database.bootstrapFromServer).not.toHaveBeenCalled();
  });
});

describe('BaseSyncedStore.forceFullRebootstrap — bootstrapMode guard', () => {
  it('no-ops when bootstrapMode is "none"', () => {
    const deps = makeDeps();
    const store = makeStore(deps);
    store.userContext = {
      userId: 'agent:test',
      organizationId: 'org_1',
      kind: 'agent',
      bootstrapMode: 'none',
    };

    store.forceFullRebootstrap();

    expect(deps.database.markRequiresFullBootstrap).not.toHaveBeenCalled();
  });

  it('marks the database when bootstrapMode is "full"', () => {
    const deps = makeDeps();
    const store = makeStore(deps);
    store.userContext = {
      userId: 'user_1',
      organizationId: 'org_1',
      kind: 'user',
      bootstrapMode: 'full',
    };
    // forceFullRebootstrap calls into syncWebSocket?.disconnect()
    // and onConnectionEvent?.(...) — both optional, leave undefined.
    store.forceFullRebootstrap();

    expect(deps.database.markRequiresFullBootstrap).toHaveBeenCalledTimes(1);
  });
});
