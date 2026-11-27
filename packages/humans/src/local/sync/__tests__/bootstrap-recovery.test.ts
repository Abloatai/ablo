/**
 * Regression suite for ABL-1653: replay-overflow cursor preservation and
 * non-destructive replacement bootstrap recovery.
 *
 * Reproduces the exact failure mode observed when a reconnecting client hits
 * the Rust server's replay cap (20,000 delivered rows or 20 MiB):
 *   1. Server streams `catchup_begin` + `catchup_chunk` frames up to the cap
 *      (e.g., 19,968 of 20,001 rows), omits `catchup_end`, and sends
 *      `sync_response { requiresBootstrap: true, bootstrapHint, currentSyncId }`.
 *   2. `SyncWebSocket` must preserve the last durably acknowledged cursor
 *      (19,968, NOT 20,001), abandon `catchUp`, and emit `bootstrap_required`.
 *   3. `socketEventWiring` must wait for `catchUpLane` to finish persisting
 *      already-received chunks before invoking `handleBootstrapRequired`.
 *   4. `BaseSyncedStore` must keep the old local replica intact and usable
 *      while fetching a full replacement snapshot (`lastSyncId: 0`), queue
 *      concurrent live deltas via `withDeltaQueuing`, apply the replacement
 *      plus queued deltas, advance all cursors consistently, and follow up
 *      with an incremental sync request.
 */

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { LoadStrategy, ModelScope } from '@abloatai/transaction/types';
import { BaseSyncedStore, type UserContext } from '../../BaseSyncedStore.js';
import { Database, type BootstrapRequirements } from '../../Database.js';
import { InstanceCache } from '../../InstanceCache.js';
import { Model } from '../../Model.js';
import { ModelRegistry, clearActiveRegistry, setActiveRegistry } from '../../ModelRegistry.js';
import { SyncClient } from '../../SyncClient.js';
import { BootstrapFetcher, type BootstrapData } from '../BootstrapFetcher.js';
import { SyncWebSocket, type BootstrapHint } from '../SyncWebSocket.js';
import { ClaimLog } from '../../coordination/ClaimLog.js';
import { initRuntime, resetRuntime } from '../../context.js';
import {
  browserOnlineStatus,
  defaultSessionErrorDetector,
  emptyConfig,
  noopLogger,
} from '../../RuntimeContext.js';

class ItemModel extends Model {
  title = '';

  constructor(data?: Record<string, unknown>) {
    super(data);
    if (data && typeof data.title === 'string') {
      this.title = data.title;
    }
  }

  override getModelName(): string {
    return 'Item';
  }
}

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeWebSocket.OPEN;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  readonly sent: string[] = [];
  static last: FakeWebSocket | undefined;

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    FakeWebSocket.last = this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

class TestStore extends BaseSyncedStore {
  protected override createConnectionManager() {
    return null;
  }

  setSessionContext(context: UserContext, lastSyncId: number): void {
    this.userContext = context;
    this.dataReady = true;
    this.initialized = true;
    this.updateSyncStatus({ state: 'idle', progress: 100 });
    this.setupWebSocketSync(context, lastSyncId);
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function wireDelta(
  id: number,
  actionType: 'I' | 'U' | 'D',
  modelId: string,
  data: Record<string, unknown> | null,
) {
  return {
    id,
    actionType,
    modelName: 'Item',
    modelId,
    data,
    previousData: null,
    syncGroups: ['org:org_1'],
    transactionId: null,
    createdBy: { kind: 'user', id: 'u1' },
    createdAt: '2026-11-26T12:00:00.000Z',
  };
}

function deliver(fake: FakeWebSocket, type: string, payload: unknown): void {
  if (!fake.onmessage) throw new Error('FakeWebSocket has no message handler');
  fake.onmessage({ data: JSON.stringify({ type, payload }) });
}

function sentFrames(fake: FakeWebSocket, type: string): Record<string, unknown>[] {
  return fake.sent
    .map((raw) => JSON.parse(raw) as { type?: string; payload?: Record<string, unknown> })
    .filter((frame) => frame.type === type)
    .map((frame) => frame.payload ?? {});
}

async function flushMicrotasks(macroTurns = 2): Promise<void> {
  for (let i = 0; i < macroTurns; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function installRuntime(): void {
  initRuntime({
    logger: noopLogger,
    observability: new ClaimLog(),
    onlineStatus: browserOnlineStatus,
    sessionErrorDetector: defaultSessionErrorDetector,
    config: emptyConfig,
    getModelMetadata: () => undefined,
    mutationExecutor: {
      commit: () =>
        Promise.resolve({
          lastSyncId: 0,
          status: 'confirmed' as const,
          statusAt: '2026-11-26T12:00:00.000Z',
        }),
      executeCreate: () => Promise.resolve(),
      executeUpdate: () => Promise.resolve(null),
      executeDelete: () => Promise.resolve(),
      executeArchive: () => Promise.resolve(),
      executeUnarchive: () => Promise.resolve(),
    },
  });
}

async function createHarness(options: {
  initialSyncId?: number;
  bootstrapMode?: 'full' | 'none';
  seedItems?: { id: string; title: string }[];
} = {}) {
  installRuntime();
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;

  const modelRegistry = new ModelRegistry({ validateOnRegister: false, allowLateReferences: true });
  modelRegistry.registerModel('Item', ItemModel, { loadStrategy: LoadStrategy.instant });
  setActiveRegistry(modelRegistry);

  const objectPool = new InstanceCache({ maxSize: 1000, gcInterval: 0, useWeakRefs: false }, modelRegistry);
  const bootstrapFetcher = new BootstrapFetcher({ baseUrl: 'http://sync.test/api', maxRetries: 1, retryDelay: 1 });
  const database = new Database(modelRegistry, bootstrapFetcher, { inMemory: true });
  await database.open({
    participantId: 'u1',
    organizationId: 'org_1',
    participantKind: 'user',
    projectId: 'org_1',
    branchId: 'br_1',
    syncGroups: ['org:org_1'],
  });

  const initialSyncId = options.initialSyncId ?? 1;
  await database.updateWorkspaceMetadata({ lastSyncId: initialSyncId });

  const seedItems = options.seedItems ?? [{ id: 'item-1', title: 'Initial Replica Item' }];
  for (const row of seedItems) {
    await database.putRecord('Item', row.id, row);
    const model = objectPool.createFromData({ __typename: 'Item', ...row });
    if (model) {
      model.markAsPersisted();
      objectPool.add(model, ModelScope.live);
    }
  }

  const syncClient = new SyncClient(objectPool, database);
  await syncClient.initialize('u1', 'org_1');
  syncClient.position.advancePersisted(initialSyncId);

  const syncWebSocket = new SyncWebSocket({
    baseUrl: 'http://sync.test',
    userId: 'u1',
    organizationId: 'org_1',
    syncGroups: ['org:org_1'],
    lastSyncId: initialSyncId,
    deferConnect: true,
  });

  const store = new TestStore({
    syncClient,
    database,
    objectPool,
    modelRegistry,
    syncWebSocket,
    url: 'http://sync.test',
  });

  store.setSessionContext(
    {
      userId: 'u1',
      organizationId: 'org_1',
      branchId: 'br_1',
      syncGroups: ['org:org_1'],
      bootstrapMode: options.bootstrapMode ?? 'full',
    },
    initialSyncId,
  );

  const fakeSocket = FakeWebSocket.last;
  if (!fakeSocket) throw new Error('Expected FakeWebSocket to be constructed');
  deliver(fakeSocket, 'presence_session', {
    presenceSessionId: '00000000-0000-4000-8000-000000000001',
    resumed: false,
  });

  return { store, database, bootstrapFetcher, syncClient, objectPool, syncWebSocket, fakeSocket };
}

describe('ABL-1653 replay-overflow bootstrap recovery', () => {
  const realWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  const storesToCleanup: TestStore[] = [];

  afterEach(async () => {
    while (storesToCleanup.length > 0) {
      await storesToCleanup.pop()?.disconnect();
    }
    (globalThis as { WebSocket?: unknown }).WebSocket = realWebSocket;
    FakeWebSocket.last = undefined;
    clearActiveRegistry();
    resetRuntime();
  });

  it('recovers all 33 withheld changes in the 20,001-row overflow scenario without losing old replica or concurrent live deltas', async () => {
    const harness = await createHarness({ initialSyncId: 1 });
    storesToCleanup.push(harness.store);
    const { store, bootstrapFetcher, syncClient, syncWebSocket, fakeSocket } = harness;

    const bootstrapDeferred = createDeferred<BootstrapData>();
    const fetchBootstrapSpy = jest
      .spyOn(bootstrapFetcher, 'fetchBootstrap')
      .mockReturnValue(bootstrapDeferred.promise);
    const bootstrapFromServerSpy = jest.spyOn(harness.database, 'bootstrapFromServer');

    // Server streams chunks up to 19,968 of 20,001 rows, omits catchup_end,
    // and signals requiresBootstrap with authoritative head 20,001.
    deliver(fakeSocket, 'catchup_begin', {
      exchangeId: 'ex-20001',
      fromSyncId: 1,
      currentSyncId: 20_001,
    });
    deliver(fakeSocket, 'catchup_chunk', {
      exchangeId: 'ex-20001',
      sequence: 0,
      position: 10_000,
      deltas: [wireDelta(10_000, 'I', 'item-10000', { id: 'item-10000', title: 'Chunk Row 10000' })],
    });
    deliver(fakeSocket, 'catchup_chunk', {
      exchangeId: 'ex-20001',
      sequence: 1,
      position: 19_968,
      deltas: [wireDelta(19_968, 'I', 'item-19968', { id: 'item-19968', title: 'Chunk Row 19968' })],
    });
    deliver(fakeSocket, 'sync_response', {
      requiresBootstrap: true,
      bootstrapHint: { reason: 'too_far_behind' } satisfies BootstrapHint,
      currentSyncId: 20_001,
    });

    // Wait for catchUpLane to drain and start the replacement bootstrap.
    await flushMicrotasks();

    // 1. Cursor MUST stay at 19,968 (NOT 20,001) while replacement is in flight.
    expect(syncWebSocket.getLastSyncId()).toBe(19_968);
    expect(fetchBootstrapSpy).toHaveBeenCalledTimes(1);
    expect(fetchBootstrapSpy).toHaveBeenCalledWith(0);
    expect(bootstrapFromServerSpy).toHaveBeenCalledWith(
      expect.objectContaining<Partial<BootstrapRequirements>>({
        type: 'full',
        lastSyncId: 0,
        modelsToLoad: ['Item'],
      }),
      ['org:org_1'],
    );

    // 2. Old local replica MUST remain readable and ready while bootstrap runs.
    expect(store.isReady).toBe(true);
    expect((store.getById('item-1') as ItemModel | undefined)?.title).toBe('Initial Replica Item');
    expect((store.getById('item-19968') as ItemModel | undefined)?.title).toBe('Chunk Row 19968');

    // 3. Live deltas arriving during replacement bootstrap are queued and applied after swap:
    //    - 19,990 (<= snapshot 20,001) must NOT regress the snapshot value.
    //    - 20,005 (new live insert) and 20,006 (live update to withheld row 20,001) MUST apply.
    deliver(fakeSocket, 'delta', wireDelta(19_990, 'U', 'item-1', { id: 'item-1', title: 'Stale Pre-Snapshot Update' }));
    deliver(fakeSocket, 'delta', wireDelta(20_005, 'I', 'item-live-20005', { id: 'item-live-20005', title: 'Live Insert During Bootstrap' }));
    deliver(fakeSocket, 'delta', wireDelta(20_006, 'U', 'item-20001', { id: 'item-20001', title: 'Live Updated 20001' }));

    // Resolve replacement snapshot containing existing rows + all 33 withheld rows (19,969..20,001).
    const withheldRows = Array.from({ length: 33 }, (_, i) => {
      const syncId = 19_969 + i;
      return { id: `item-${syncId}`, title: `Withheld Row ${syncId}` };
    });
    bootstrapDeferred.resolve({
      type: 'full',
      lastSyncId: 20_001,
      timestamp: Date.now(),
      models: {
        Item: [
          { id: 'item-1', title: 'Snapshot Item 1' },
          { id: 'item-10000', title: 'Chunk Row 10000' },
          { id: 'item-19968', title: 'Chunk Row 19968' },
          ...withheldRows,
        ],
      },
    });

    await flushMicrotasks(3);

    // 4. All 33 withheld changes (19,969..20,001) + live deltas are materialized.
    for (let syncId = 19_969; syncId <= 20_000; syncId += 1) {
      const row = store.getById(`item-${syncId}`) as ItemModel | undefined;
      expect(row?.title).toBe(`Withheld Row ${syncId}`);
    }
    expect((store.getById('item-20001') as ItemModel | undefined)?.title).toBe('Live Updated 20001');
    expect((store.getById('item-live-20005') as ItemModel | undefined)?.title).toBe('Live Insert During Bootstrap');
    // Stale queued delta 19,990 must not have regressed snapshot row item-1.
    expect((store.getById('item-1') as ItemModel | undefined)?.title).toBe('Snapshot Item 1');

    // 5. All cursor watermarks advanced cleanly to >= 20,001 (20,006 after live delta replay).
    expect(syncWebSocket.getLastSyncId()).toBe(20_006);
    expect(syncClient.position.applied).toBe(20_006);
    expect(syncClient.position.persisted).toBe(20_006);
    expect(store.syncStatus.state).toBe('idle');

    // 6. Follow-up incremental sync was sent with the post-bootstrap cursor (>= 20,001).
    const syncRequests = sentFrames(fakeSocket, 'sync_request');
    const lastSyncRequest = syncRequests.at(-1);
    expect(typeof lastSyncRequest?.lastSyncId).toBe('number');
    expect(lastSyncRequest?.lastSyncId as number).toBeGreaterThanOrEqual(20_001);
  });

  it('recovers from 20 MiB byte-cap / too_many_deltas overflow and ignores stray frames from abandoned catch-up', async () => {
    const harness = await createHarness({ initialSyncId: 50 });
    storesToCleanup.push(harness.store);
    const { store, bootstrapFetcher, syncWebSocket, fakeSocket } = harness;

    const bootstrapDeferred = createDeferred<BootstrapData>();
    const fetchBootstrapSpy = jest
      .spyOn(bootstrapFetcher, 'fetchBootstrap')
      .mockReturnValue(bootstrapDeferred.promise);

    deliver(fakeSocket, 'catchup_begin', {
      exchangeId: 'ex-20mib',
      fromSyncId: 50,
      currentSyncId: 1_500,
    });
    deliver(fakeSocket, 'catchup_chunk', {
      exchangeId: 'ex-20mib',
      sequence: 0,
      position: 900,
      deltas: [wireDelta(900, 'I', 'item-900', { id: 'item-900', title: 'Delivered Before 20 MiB Cap' })],
    });
    deliver(fakeSocket, 'sync_response', {
      requiresBootstrap: true,
      bootstrapHint: { reason: 'too_many_deltas' } satisfies BootstrapHint,
      currentSyncId: 1_500,
    });
    // Stray frames from the abandoned exchange must not advance cursor or apply.
    deliver(fakeSocket, 'catchup_chunk', {
      exchangeId: 'ex-20mib',
      sequence: 1,
      position: 1_500,
      deltas: [wireDelta(1_500, 'I', 'item-stray', { id: 'item-stray', title: 'Stray' })],
    });
    deliver(fakeSocket, 'catchup_end', {
      exchangeId: 'ex-20mib',
      currentSyncId: 1_500,
      chunks: 1,
    });

    await flushMicrotasks();

    expect(syncWebSocket.getLastSyncId()).toBe(900);
    expect(store.getById('item-stray')).toBeUndefined();
    expect(fetchBootstrapSpy).toHaveBeenCalledTimes(1);

    bootstrapDeferred.resolve({
      type: 'full',
      lastSyncId: 1_500,
      timestamp: Date.now(),
      models: {
        Item: [
          { id: 'item-1', title: 'Initial Replica Item' },
          { id: 'item-900', title: 'Delivered Before 20 MiB Cap' },
          { id: 'item-1500', title: 'Recovered After Byte Cap' },
        ],
      },
    });

    await flushMicrotasks(3);

    expect((store.getById('item-1500') as ItemModel | undefined)?.title).toBe('Recovered After Byte Cap');
    expect(syncWebSocket.getLastSyncId()).toBe(1_500);
    expect(harness.syncClient.position.persisted).toBe(1_500);
  });

  it('preserves old replica and unadvanced cursor on transient bootstrap failure so subsequent retry recovers cleanly', async () => {
    const harness = await createHarness({ initialSyncId: 10 });
    storesToCleanup.push(harness.store);
    const { store, bootstrapFetcher, syncWebSocket, fakeSocket } = harness;

    const firstAttempt = createDeferred<BootstrapData>();
    const secondAttempt = createDeferred<BootstrapData>();
    const fetchBootstrapSpy = jest
      .spyOn(bootstrapFetcher, 'fetchBootstrap')
      .mockReturnValueOnce(firstAttempt.promise)
      .mockReturnValueOnce(secondAttempt.promise);

    deliver(fakeSocket, 'catchup_begin', { exchangeId: 'ex-fail', fromSyncId: 10, currentSyncId: 20_001 });
    deliver(fakeSocket, 'catchup_chunk', {
      exchangeId: 'ex-fail',
      sequence: 0,
      position: 19_968,
      deltas: [wireDelta(19_968, 'I', 'item-19968', { id: 'item-19968', title: 'Before Transient Failure' })],
    });
    deliver(fakeSocket, 'sync_response', {
      requiresBootstrap: true,
      bootstrapHint: { reason: 'too_far_behind' } satisfies BootstrapHint,
      currentSyncId: 20_001,
    });

    await flushMicrotasks();
    expect(fetchBootstrapSpy).toHaveBeenCalledTimes(1);

    // Fail first replacement bootstrap transiently.
    firstAttempt.reject(new Error('HTTP 503 Service Unavailable'));
    await flushMicrotasks(3);

    // Old replica and cursor MUST remain intact, and status must not wedge in 'syncing'.
    expect(syncWebSocket.getLastSyncId()).toBe(19_968);
    expect(harness.syncClient.position.persisted).toBe(19_968);
    expect((store.getById('item-1') as ItemModel | undefined)?.title).toBe('Initial Replica Item');
    expect((store.getById('item-19968') as ItemModel | undefined)?.title).toBe('Before Transient Failure');
    expect(store.syncStatus.state).toBe('idle');

    // Next reconnect / catch-up poll sends the preserved old cursor (19,968).
    await syncWebSocket.requestIncrementalSync();
    expect(sentFrames(fakeSocket, 'sync_request').at(-1)?.lastSyncId).toBe(19_968);

    // Server again signals requiresBootstrap -> retry runs and succeeds.
    deliver(fakeSocket, 'sync_response', {
      requiresBootstrap: true,
      bootstrapHint: { reason: 'too_far_behind' } satisfies BootstrapHint,
      currentSyncId: 20_001,
    });
    await flushMicrotasks();
    expect(fetchBootstrapSpy).toHaveBeenCalledTimes(2);

    secondAttempt.resolve({
      type: 'full',
      lastSyncId: 20_001,
      timestamp: Date.now(),
      models: {
        Item: [
          { id: 'item-1', title: 'Initial Replica Item' },
          { id: 'item-19968', title: 'Before Transient Failure' },
          { id: 'item-20001', title: 'Recovered On Retry' },
        ],
      },
    });
    await flushMicrotasks(3);

    expect((store.getById('item-20001') as ItemModel | undefined)?.title).toBe('Recovered On Retry');
    expect(syncWebSocket.getLastSyncId()).toBe(20_001);
    expect(harness.syncClient.position.persisted).toBe(20_001);
  });

  it('coalesces concurrent bootstrap_required frames into a single replacement bootstrap and waits for catchUpLane settlement', async () => {
    const harness = await createHarness({ initialSyncId: 1 });
    storesToCleanup.push(harness.store);
    const { database, bootstrapFetcher, syncWebSocket, fakeSocket } = harness;

    const order: string[] = [];
    const chunkPersistGate = createDeferred<undefined>();
    const originalProcessDeltaBatch = database.processDeltaBatch.bind(database);
    jest.spyOn(database, 'processDeltaBatch').mockImplementationOnce(async (deltas) => {
      order.push('chunk-persist-start');
      await chunkPersistGate.promise;
      const result = await originalProcessDeltaBatch(deltas);
      order.push('chunk-persist-done');
      return result;
    });

    const bootstrapDeferred = createDeferred<BootstrapData>();
    const fetchBootstrapSpy = jest
      .spyOn(bootstrapFetcher, 'fetchBootstrap')
      .mockImplementation(() => {
        order.push('bootstrap-fetch-start');
        return bootstrapDeferred.promise;
      });

    deliver(fakeSocket, 'catchup_begin', { exchangeId: 'ex-race', fromSyncId: 1, currentSyncId: 20_001 });
    deliver(fakeSocket, 'catchup_chunk', {
      exchangeId: 'ex-race',
      sequence: 0,
      position: 19_968,
      deltas: [wireDelta(19_968, 'I', 'item-19968', { id: 'item-19968', title: 'Slow Chunk' })],
    });
    // Send multiple duplicate requiresBootstrap responses while the chunk is still persisting.
    deliver(fakeSocket, 'sync_response', {
      requiresBootstrap: true,
      bootstrapHint: { reason: 'too_far_behind' } satisfies BootstrapHint,
      currentSyncId: 20_001,
    });
    deliver(fakeSocket, 'sync_response', {
      requiresBootstrap: true,
      bootstrapHint: { reason: 'too_far_behind' } satisfies BootstrapHint,
      currentSyncId: 20_001,
    });

    await flushMicrotasks();
    // Bootstrap MUST NOT start until the in-flight catchup_chunk has settled!
    expect(fetchBootstrapSpy).not.toHaveBeenCalled();
    expect(order).toEqual(['chunk-persist-start']);

    // Release the slow chunk -> it finishes persisting & acknowledging before bootstrap starts.
    chunkPersistGate.resolve(undefined);
    await flushMicrotasks();

    expect(order).toEqual(['chunk-persist-start', 'chunk-persist-done', 'bootstrap-fetch-start']);
    expect(syncWebSocket.getLastSyncId()).toBe(19_968);
    expect(fetchBootstrapSpy).toHaveBeenCalledTimes(1);

    // Another duplicate requiresBootstrap while bootstrap is already in flight also coalesces.
    deliver(fakeSocket, 'sync_response', {
      requiresBootstrap: true,
      bootstrapHint: { reason: 'too_far_behind' } satisfies BootstrapHint,
      currentSyncId: 20_001,
    });
    await flushMicrotasks();
    expect(fetchBootstrapSpy).toHaveBeenCalledTimes(1);

    bootstrapDeferred.resolve({
      type: 'full',
      lastSyncId: 20_001,
      timestamp: Date.now(),
      models: {
        Item: [
          { id: 'item-1', title: 'Initial Replica Item' },
          { id: 'item-20001', title: 'Tail Row' },
        ],
      },
    });
    await flushMicrotasks(3);

    expect(syncWebSocket.getLastSyncId()).toBe(20_001);
  });

  it('does not trigger bootstrap and does not corrupt cursor when bootstrapMode is none', async () => {
    const harness = await createHarness({ initialSyncId: 100, bootstrapMode: 'none' });
    storesToCleanup.push(harness.store);
    const { bootstrapFetcher, syncWebSocket, fakeSocket } = harness;

    const fetchBootstrapSpy = jest.spyOn(bootstrapFetcher, 'fetchBootstrap');

    deliver(fakeSocket, 'catchup_begin', { exchangeId: 'ex-none', fromSyncId: 100, currentSyncId: 20_001 });
    deliver(fakeSocket, 'catchup_chunk', {
      exchangeId: 'ex-none',
      sequence: 0,
      position: 19_968,
      deltas: [wireDelta(19_968, 'I', 'item-19968', { id: 'item-19968', title: 'Chunk Row' })],
    });
    deliver(fakeSocket, 'sync_response', {
      requiresBootstrap: true,
      bootstrapHint: { reason: 'too_far_behind' } satisfies BootstrapHint,
      currentSyncId: 20_001,
    });

    await flushMicrotasks(3);

    expect(fetchBootstrapSpy).not.toHaveBeenCalled();
    // Cursor MUST stay at the last durably acknowledged chunk position (19,968), NOT 20,001.
    expect(syncWebSocket.getLastSyncId()).toBe(19_968);
    await syncWebSocket.requestIncrementalSync();
    expect(sentFrames(fakeSocket, 'sync_request').at(-1)?.lastSyncId).toBe(19_968);
  });
});
