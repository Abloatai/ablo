/**
 * Receive-boundary delta validation (production-doctor T1.2).
 *
 * The SDK used to cast unvalidated wire frames to `SyncDelta` and hand them
 * to persistence — `clientSyncDeltaSchema` existed but was never parsed.
 * Now every inbound delta (single `delta` frame, batch element,
 * `sync_response` replay, legacy bare frame) is validated exactly once at
 * the `normalizeWireDelta` seam: malformed deltas are DROPPED (debug log +
 * observability breadcrumb) instead of applied, and the seam tolerates the
 * SERVER projection (string BIGINT ids, `transactionId: null`, nested/null
 * `createdBy`) so real deltas from deployed servers keep flowing.
 *
 * Harness mirrors ws-observability-wiring.test.ts: stub the global
 * `WebSocket`, fire `onmessage` by hand — the receive path under test is
 * the real one.
 */
import { afterEach, describe, expect, it } from '@jest/globals';
import { SyncWebSocket, type SyncDelta } from '../SyncWebSocket.js';
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
  readyState = FakeWebSocket.OPEN;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  readonly sent: string[] = [];
  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

/** ClaimLog with a recording breadcrumb so drops are observable. */
class SpyObservability extends ClaimLog {
  readonly breadcrumbs: { message: string; category: string }[] = [];
  override breadcrumb(message?: string, category?: string): void {
    this.breadcrumbs.push({
      message: message ?? '',
      category: category ?? '',
    });
  }
}

function installContext(observability: SpyObservability): void {
  initRuntime({
    logger: noopLogger,
    observability,
    onlineStatus: browserOnlineStatus,
    sessionErrorDetector: defaultSessionErrorDetector,
    config: emptyConfig,
    getModelMetadata: () => undefined,
    mutationExecutor: {
      commit: () => Promise.resolve({ lastSyncId: 0, status: 'confirmed' as const }),
      executeCreate: () => Promise.resolve(),
      executeUpdate: () => Promise.resolve(null),
      executeDelete: () => Promise.resolve(),
      executeArchive: () => Promise.resolve(),
      executeUnarchive: () => Promise.resolve(),
    },
  });
}

/**
 * A delta exactly as the deployed sync-server broadcasts it (the SERVER
 * projection from `rowsToSyncDeltas`): nullable `transactionId`,
 * `createdBy` as a nested ParticipantRef, plus the audit extras the client
 * contract doesn't declare.
 */
function serverShapedDelta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7,
    actionType: 'U',
    modelName: 'tasks',
    modelId: 'task-1',
    data: { id: 'task-1', title: 'hello' },
    previousData: null,
    syncGroups: ['org:org1'],
    transactionId: null,
    createdBy: { kind: 'user', id: 'u1' },
    actor: { kind: 'user', id: 'u1' },
    onBehalfOf: null,
    capabilityId: null,
    confirmationState: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function frame(type: string, payload: unknown): { data: string } {
  return { data: JSON.stringify({ type, payload }) };
}

function deliver(fake: FakeWebSocket, event: { data: string }): void {
  const onmessage = fake.onmessage;
  if (!onmessage) throw new Error('fake WebSocket has no message handler');
  onmessage(event);
}

describe('SyncWebSocket wire delta validation (T1.2)', () => {
  const realWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;

  afterEach(() => {
    (globalThis as { WebSocket?: unknown }).WebSocket = realWebSocket;
    resetRuntime();
  });

  function connectFake(): {
    ws: SyncWebSocket;
    fake: FakeWebSocket;
    spy: SpyObservability;
    deltas: SyncDelta[];
    batches: SyncDelta[][];
  } {
    const spy = new SpyObservability();
    installContext(spy);
    (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
    const ws = new SyncWebSocket({
      baseUrl: 'http://localhost:8080',
      syncGroups: [],
      userId: 'u1',
      organizationId: 'org1',
    });
    ws.connect();
    const fakeHolder = ws as unknown as { ws: FakeWebSocket };
    const deltas: SyncDelta[] = [];
    const batches: SyncDelta[][] = [];
    ws.subscribe('delta', (d) => deltas.push(d));
    ws.subscribe('delta_batch', (b) => batches.push(b));
    return { ws, fake: fakeHolder.ws, spy, deltas, batches };
  }

  it('emits a server-shaped delta (null transactionId, nested createdBy tolerated)', () => {
    const { fake, deltas, spy } = connectFake();
    deliver(fake, frame('delta', serverShapedDelta()));
    expect(deltas).toHaveLength(1);
    const emitted = deltas[0];
    if (!emitted) throw new Error('expected an emitted delta');
    expect(emitted.id).toBe(7);
    expect(emitted.modelName).toBe('tasks');
    expect(emitted.modelId).toBe('task-1');
    // The nullable server fields normalize to absent, never reject.
    expect(emitted.transactionId).toBeUndefined();
    expect(spy.breadcrumbs.filter((b) => b.message.includes('malformed'))).toHaveLength(0);
  });

  it('coerces a string BIGINT id once at the seam (old-server compat)', () => {
    const { fake, deltas } = connectFake();
    deliver(fake, frame('delta', serverShapedDelta({ id: '42' })));
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.id).toBe(42);
  });

  it('preserves an opaque source correlation beside the optimistic id', () => {
    const { fake, deltas } = connectFake();
    deliver(
      fake,
      frame(
        'delta',
        serverShapedDelta({
          transactionId: 'optimistic-write-1',
          correlationId: 'corr-scoped-source-batch',
        }),
      ),
    );

    expect(deltas[0]).toMatchObject({
      transactionId: 'optimistic-write-1',
      correlationId: 'corr-scoped-source-batch',
    });
  });

  it('drops a malformed delta (schema violation) with a breadcrumb, never emits', () => {
    const { fake, deltas, spy } = connectFake();
    // modelId is required non-empty — this used to be cast straight through.
    deliver(fake, frame('delta', serverShapedDelta({ modelId: '' })));
    deliver(fake, frame('delta', serverShapedDelta({ actionType: 'NOPE' })));
    expect(deltas).toHaveLength(0);
    expect(
      spy.breadcrumbs.filter((b) => b.message === 'Dropped malformed wire delta'),
    ).toHaveLength(2);
  });

  it('sync_response: malformed deltas drop out of the batch, valid ones survive', () => {
    const { fake, batches, spy } = connectFake();
    deliver(
      fake,
      frame('sync_response', {
        currentSyncId: 100,
        deltas: [
          serverShapedDelta({ id: 8 }),
          serverShapedDelta({ modelName: '' }), // invalid — dropped
          serverShapedDelta({ id: '9', modelId: 'task-2' }),
        ],
      }),
    );
    expect(batches).toHaveLength(1);
    const batch = batches[0];
    if (!batch) throw new Error('expected an emitted delta batch');
    expect(batch.map((d) => d.id)).toEqual([8, 9]);
    expect(
      spy.breadcrumbs.filter((b) => b.message === 'Dropped malformed wire delta'),
    ).toHaveLength(1);
  });

  it('delta frame with a { deltas: [...] } batch validates each element once', () => {
    const { fake, deltas } = connectFake();
    deliver(
      fake,
      frame('delta', {
        deltas: [serverShapedDelta({ id: 1 }), serverShapedDelta({ id: 2, modelId: 'task-2' })],
      }),
    );
    expect(deltas.map((d) => d.id)).toEqual([1, 2]);
  });

  it('legacy bare delta (no frame type) still flows through validation', () => {
    const { fake, deltas } = connectFake();
    deliver(fake, { data: JSON.stringify(serverShapedDelta({ id: 3 })) });
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.id).toBe(3);
  });

  it('non-object envelopes are dropped without throwing', () => {
    const { fake, deltas, batches } = connectFake();
    deliver(fake, { data: JSON.stringify(42) });
    deliver(fake, { data: JSON.stringify([serverShapedDelta()]) });
    deliver(fake, { data: JSON.stringify({ type: 123, payload: {} }) });
    expect(deltas).toHaveLength(0);
    expect(batches).toHaveLength(0);
  });

  it('accepts group-change control deltas (G with object envelope data)', () => {
    const { fake, deltas } = connectFake();
    deliver(
      fake,
      frame(
        'delta',
        serverShapedDelta({
          id: 0,
          actionType: 'G',
          modelName: '__sync_group__',
          modelId: 'u1',
          data: { addedGroups: ['team:t1'], removedGroups: [] },
        }),
      ),
    );
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.actionType).toBe('G');
  });
});
