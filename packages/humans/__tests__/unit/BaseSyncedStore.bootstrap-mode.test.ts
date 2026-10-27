/**
 * BaseSyncedStore — `bootstrapMode: 'none'` skips baseline replication.
 *
 * A headless worker (or any future transactional participant) opens
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
 * The test drives `initialize()` as a generator over a real store whose
 * collaborators are real and spied: only the bootstrap-skip decision is
 * under test, so the database and socket calls answer canned values.
 */

import { BaseSyncedStore, type UserContext } from '../../src/local/BaseSyncedStore';
import type { BootstrapResult } from '../../src/local/Database';
import { storeDependencies } from '../../src/local/testing/helpers/storeDependencies';

type GenStep = IteratorResult<Promise<unknown>, { success: boolean; error?: Error }>;

/** The store under test, with the side paths `initialize()` leaves to the
 *  host stubbed and its protected state readable. */
class ProbeStore extends BaseSyncedStore {
  readonly webSocketSync = jest.fn();
  protected override setupWebSocketSync(): void {
    this.webSocketSync();
  }
  protected override updateSyncStatus(): void {}
  protected override executeBootstrapWithTimeout<T>(bootstrapFn: () => Promise<T>): Promise<T> {
    return bootstrapFn();
  }
  protected override async performBackgroundBootstrap(): Promise<void> {}
  get isDataReady(): boolean {
    return this.dataReady;
  }
  get isInitialized(): boolean {
    return this.initialized;
  }
  setUserContext(context: UserContext): void {
    this.userContext = context;
  }
  rebootstrap(): void {
    this.forceFullRebootstrap();
  }
}

function makeDeps(overrides?: { requirementsType?: 'full' | 'partial' | 'local' }) {
  const requirementsType = overrides?.requirementsType ?? 'full';
  const collaborators = storeDependencies();
  const { database, syncClient, syncWebSocket } = collaborators;
  const bootstrapResult: BootstrapResult = {
    modelsLoaded: 0,
    modelsStored: 0,
    bootstrapData: { type: 'full', models: {}, lastSyncId: 0, timestamp: 0 },
  };
  const spies = {
    open: jest.spyOn(database, 'open').mockResolvedValue(undefined),
    getLastSyncId: jest.spyOn(database, 'getLastSyncId').mockResolvedValue(0),
    requiredBootstrap: jest
      .spyOn(database, 'requiredBootstrap')
      .mockResolvedValue({ type: requirementsType, modelsToLoad: [], lastSyncId: 0, syncGroups: [] }),
    bootstrapFromServer: jest.spyOn(database, 'bootstrapFromServer').mockResolvedValue(bootstrapResult),
    markRequiresFullBootstrap: jest.spyOn(database, 'markRequiresFullBootstrap').mockImplementation(() => undefined),
    initialize: jest.spyOn(syncClient, 'initialize').mockResolvedValue(undefined),
    hydrateFromDatabase: jest.spyOn(syncClient, 'hydrateFromDatabase').mockResolvedValue(undefined),
  };
  // initialize() reads the connection as already open, so bootstrapMode:'none' resolves at once.
  jest.spyOn(syncWebSocket, 'isConnected').mockReturnValue(true);
  return { ...collaborators, spies };
}

type InitDeps = ReturnType<typeof makeDeps>;

function makeStore(deps: InitDeps): ProbeStore {
  return new ProbeStore({
    syncClient: deps.syncClient,
    database: deps.database,
    objectPool: deps.objectPool,
    modelRegistry: deps.modelRegistry,
    syncWebSocket: deps.syncWebSocket,
  });
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
      branchId: 'br_1',
      kind: 'agent',
      bootstrapMode: 'none',
      syncGroups: ['org:org_1'],
    };

    const result = await drive(store.initialize(ctx));

    expect(result.success).toBe(true);
    expect(deps.spies.bootstrapFromServer).not.toHaveBeenCalled();
    expect(deps.spies.requiredBootstrap).toHaveBeenCalledTimes(1);
    // Live-delta path must still be wired up.
    expect(store.webSocketSync).toHaveBeenCalledTimes(1);
    expect(store.isDataReady).toBe(true);
    expect(store.isInitialized).toBe(true);
  });

  it('still bootstraps when bootstrapMode is "full" (default user behavior)', async () => {
    const deps = makeDeps({ requirementsType: 'full' });
    const store = makeStore(deps);
    const ctx: UserContext = {
      userId: 'user_1',
      organizationId: 'org_1',
      branchId: 'br_1',
      kind: 'user',
      bootstrapMode: 'full',
      syncGroups: ['org:org_1'],
    };

    const result = await drive(store.initialize(ctx));

    expect(result.success).toBe(true);
    expect(deps.spies.bootstrapFromServer).toHaveBeenCalledTimes(1);
  });

  it('skips bootstrap when requirements are local even with bootstrapMode "full"', async () => {
    // Pre-existing branch — ensures we didn't regress it.
    const deps = makeDeps({ requirementsType: 'local' });
    const store = makeStore(deps);
    const ctx: UserContext = {
      userId: 'user_1',
      organizationId: 'org_1',
      branchId: 'br_1',
      kind: 'user',
      bootstrapMode: 'full',
      syncGroups: ['org:org_1'],
    };

    await drive(store.initialize(ctx));
    expect(deps.spies.bootstrapFromServer).not.toHaveBeenCalled();
  });
});

describe('BaseSyncedStore.forceFullRebootstrap — bootstrapMode guard', () => {
  it('no-ops when bootstrapMode is "none"', () => {
    const deps = makeDeps();
    const store = makeStore(deps);
    store.setUserContext({
      userId: 'agent:test',
      organizationId: 'org_1',
      branchId: 'br_1',
      kind: 'agent',
      bootstrapMode: 'none',
    });

    store.rebootstrap();

    expect(deps.spies.markRequiresFullBootstrap).not.toHaveBeenCalled();
  });

  it('marks the database when bootstrapMode is "full"', () => {
    const deps = makeDeps();
    const store = makeStore(deps);
    store.setUserContext({
      userId: 'user_1',
      organizationId: 'org_1',
      branchId: 'br_1',
      kind: 'user',
      bootstrapMode: 'full',
    });
    // forceFullRebootstrap calls into syncWebSocket?.disconnect()
    // and onConnectionEvent?.(...) — both optional, leave undefined.
    store.rebootstrap();

    expect(deps.spies.markRequiresFullBootstrap).toHaveBeenCalledTimes(1);
  });
});


it('never restores persisted rows or pending writes after persistence validation fails', async () => {
  const deps = makeDeps();
  const store = makeStore(deps);
  const error = new Error('Persistence authority mismatch');
  deps.spies.open.mockRejectedValue(error);
  const gen = store.initialize({
    userId: 'user', organizationId: 'org', branchId: 'branch',
    syncGroups: ['account:b'], operations: ['items.read'],
  });
  const opening = gen.next();
  await expect(opening.value).rejects.toBe(error);
  expect(gen.throw(error)).toEqual({ done: true, value: { success: false, error } });
  expect(deps.spies.open).toHaveBeenCalledWith(expect.objectContaining({
    syncGroups: ['account:b'], operations: ['items.read'],
  }));
  expect(deps.spies.initialize).not.toHaveBeenCalled();
  expect(deps.spies.hydrateFromDatabase).not.toHaveBeenCalled();
  expect(store.isDataReady).toBe(false);
});
