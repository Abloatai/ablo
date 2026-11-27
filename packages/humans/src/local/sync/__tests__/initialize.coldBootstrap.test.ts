import { initialize, type InitializeHost } from '../initialize.js';

async function runGen<T>(gen: Generator<Promise<unknown>, T, unknown>): Promise<T> {
  let step = gen.next();
  while (!step.done) {
    const value = await step.value;
    step = gen.next(value);
  }
  return step.value;
}

function makeHost(opts: {
  hasLocalData?: boolean;
  initialSyncId?: number;
  postBootstrapSyncId?: number;
  requirementType?: 'full' | 'partial' | 'local';
  bootstrapMode?: 'full' | 'none';
}) {
  const events: string[] = [];
  let currentSyncId = opts.initialSyncId ?? 0;
  let poolSize = opts.hasLocalData ? 5 : 0;

  const host = {
    initialized: false,
    userContext: { userId: 'u1', organizationId: 'org1', bootstrapMode: opts.bootstrapMode },
    dataReady: false,
    runtime: {
      logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      observability: { captureBootstrapFailure: jest.fn(), breadcrumb: jest.fn() },
    },
    database: {
      open: jest.fn(async () => { events.push('db.open'); }),
      getLastSyncId: jest.fn(async () => currentSyncId),
      requiredBootstrap: jest.fn(async () => ({ type: opts.requirementType ?? 'full' })),
      bootstrapFromServer: jest.fn(async () => {
        events.push('bootstrapFromServer');
        currentSyncId = opts.postBootstrapSyncId ?? 415091;
        poolSize = 10;
      }),
    },
    syncClient: {
      initialize: jest.fn(async () => {}),
      hydrateFromDatabase: jest.fn(async () => { events.push('hydrateFromDatabase'); }),
      position: { advancePersisted: jest.fn() },
    },
    objectPool: {
      get size() { return poolSize; },
    },
    syncWebSocket: {
      isConnected: jest.fn(() => false),
      setSessionErrorDetected: jest.fn(),
      disconnect: jest.fn(),
    },
    updateSyncStatus: jest.fn(),
    setupWebSocketSync: jest.fn((_ctx: unknown, syncId: number) => {
      events.push(`setupWebSocketSync:${syncId}`);
    }),
    waitForWebSocketConnected: jest.fn(async () => {
      events.push('waitForWebSocketConnected');
      return true;
    }),
    performBackgroundBootstrap: jest.fn(async () => {
      events.push('performBackgroundBootstrap');
    }),
    executeBootstrapWithTimeout: jest.fn(async (fn: () => Promise<void>) => {
      await fn();
    }),
    resolveSyncGroups: jest.fn(() => ['platformsession:org1']),
  } as unknown as InitializeHost;

  return { host, events };
}

describe('initialize() cold bootstrap WebSocket ordering', () => {
  it('runs HTTP bootstrap before opening WebSocket on cold start and connects with post-bootstrap lastSyncId', async () => {
    const { host, events } = makeHost({
      hasLocalData: false,
      initialSyncId: 0,
      postBootstrapSyncId: 415091,
      requirementType: 'full',
    });

    const result = await runGen(initialize(host, { userId: 'u1', organizationId: 'org1' }));

    expect(result.success).toBe(true);
    expect(host.setupWebSocketSync).toHaveBeenCalledTimes(1);
    expect(host.setupWebSocketSync).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1' }),
      415091,
    );
    expect(events.indexOf('bootstrapFromServer')).toBeLessThan(events.indexOf('setupWebSocketSync:415091'));
    expect(events.indexOf('hydrateFromDatabase')).toBeLessThan(events.indexOf('setupWebSocketSync:415091'));
    expect(host.syncClient.position.advancePersisted).toHaveBeenLastCalledWith(415091);
  });

  it('opens WebSocket immediately on warm start when local data exists', async () => {
    const { host, events } = makeHost({
      hasLocalData: true,
      initialSyncId: 410000,
      requirementType: 'partial',
    });

    const result = await runGen(initialize(host, { userId: 'u1', organizationId: 'org1' }));

    expect(result.success).toBe(true);
    expect(host.setupWebSocketSync).toHaveBeenCalledTimes(1);
    expect(host.setupWebSocketSync).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1' }),
      410000,
    );
    expect(events.indexOf('setupWebSocketSync:410000')).toBeLessThan(events.indexOf('performBackgroundBootstrap'));
  });

  it('opens WebSocket immediately when bootstrapMode is none', async () => {
    const { host, events } = makeHost({
      hasLocalData: false,
      initialSyncId: 0,
      requirementType: 'full',
      bootstrapMode: 'none',
    });

    const result = await runGen(initialize(host, { userId: 'u1', organizationId: 'org1', bootstrapMode: 'none' }));

    expect(result.success).toBe(true);
    expect(host.setupWebSocketSync).toHaveBeenCalledWith(
      expect.objectContaining({ bootstrapMode: 'none' }),
      0,
    );
    expect(events).toContain('waitForWebSocketConnected');
  });
});
