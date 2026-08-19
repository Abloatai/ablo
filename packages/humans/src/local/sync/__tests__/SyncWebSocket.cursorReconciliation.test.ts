/**
 * Cursor reconciliation on an empty `sync_response`.
 *
 * The server stamps its authoritative head on every `sync_response`. When the
 * response carries no deltas, that head is a proof rather than a hint: the
 * server walked the log up to it under this client's own project and
 * capability scope, found nothing the client is entitled to, and measured the
 * head through the settled barrier so nothing at or below it can still be in
 * flight. The client may therefore move its cursor in EITHER direction.
 *
 * Pins both directions and the case that must not move:
 *   - head below the local cursor: local view diverged, reset down and resync;
 *   - head above the local cursor: nothing is owed to us, adopt it. Without
 *     this a client on a plane carrying traffic it cannot see never converges,
 *     and its 30s catch-up poll takes the plane's advisory lock forever;
 *   - a response WITH deltas: the cursor stays under the persistence gate,
 *     because those deltas have not reached local storage yet.
 *
 * Harness mirrors SyncWebSocket.wireDeltaValidation.test.ts: stub the global
 * `WebSocket`, fire `onmessage` by hand, and read the cursor back off the
 * `sync_request` frame the client sends, which is the only place it surfaces.
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
  readyState = FakeWebSocket.OPEN;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  readonly sent: string[] = [];
  /** The instance the transport just constructed. Recorded here so the test can
   *  reach it without casting the transport open. */
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

function installContext(): void {
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
          statusAt: '2026-08-19T10:00:00.000Z',
        }),
      executeCreate: () => Promise.resolve(),
      executeUpdate: () => Promise.resolve(null),
      executeDelete: () => Promise.resolve(),
      executeArchive: () => Promise.resolve(),
      executeUnarchive: () => Promise.resolve(),
    },
  });
}

function deliver(fake: FakeWebSocket, type: string, payload: unknown): void {
  const onmessage = fake.onmessage;
  if (!onmessage) throw new Error('fake WebSocket has no message handler');
  onmessage({ data: JSON.stringify({ type, payload }) });
}

/** The cursor the client would resume from, read off its `sync_request`. */
function requestedCursor(fake: FakeWebSocket): number | undefined {
  for (let i = fake.sent.length - 1; i >= 0; i -= 1) {
    const raw = fake.sent[i];
    if (raw === undefined) continue;
    const parsed = JSON.parse(raw) as { type?: string; payload?: { lastSyncId?: number } };
    if (parsed.type === 'sync_request') return parsed.payload?.lastSyncId;
  }
  return undefined;
}

describe('SyncWebSocket cursor reconciliation on an empty sync_response', () => {
  const realWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;

  afterEach(() => {
    (globalThis as { WebSocket?: unknown }).WebSocket = realWebSocket;
    FakeWebSocket.last = undefined;
    resetRuntime();
  });

  function connectFake(lastSyncId: number): { ws: SyncWebSocket; fake: FakeWebSocket } {
    installContext();
    (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
    const ws = new SyncWebSocket({
      baseUrl: 'http://localhost:8080',
      syncGroups: [],
      userId: 'u1',
      organizationId: 'org1',
      lastSyncId,
    });
    ws.connect();
    const fake = FakeWebSocket.last;
    if (!fake) throw new Error('connect() did not construct a socket');
    return { ws, fake };
  }

  it('adopts a head ABOVE the local cursor when the server sends nothing', async () => {
    const { ws, fake } = connectFake(10);
    deliver(fake, 'sync_response', { deltas: [], currentSyncId: 40 });
    await ws.requestIncrementalSync();
    expect(requestedCursor(fake)).toBe(40);
  });

  it('resets to a head BELOW the local cursor and resyncs', async () => {
    const { ws, fake } = connectFake(40);
    deliver(fake, 'sync_response', { deltas: [], currentSyncId: 10 });
    await ws.requestIncrementalSync();
    expect(requestedCursor(fake)).toBe(10);
  });

  it('leaves the cursor alone when the response carries deltas', async () => {
    const { ws, fake } = connectFake(10);
    deliver(fake, 'sync_response', {
      deltas: [
        {
          id: 40,
          actionType: 'U',
          modelName: 'items',
          modelId: 'item-1',
          data: { id: 'item-1' },
          previousData: null,
          syncGroups: ['org:org1'],
          transactionId: null,
          createdBy: { kind: 'user', id: 'u1' },
          createdAt: '2026-08-19T10:00:00.000Z',
        },
      ],
      currentSyncId: 40,
    });
    await ws.requestIncrementalSync();
    // The persistence-gated ack path owns the advance; nothing has reached
    // local storage yet, so the resume position must not move.
    expect(requestedCursor(fake)).toBe(10);
  });
});
