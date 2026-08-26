/**
 * WebSocket transport ↔ observability WIRING.
 *
 * Companion to client/__tests__/http-observability-wiring.test.ts. The ClaimLog
 * sink is unit-tested directly in coordination/__tests__/trace.test.ts; this
 * drives the REAL SyncWebSocket `mutation_result` ack handler so the SOURCE —
 * the code that must CALL the sink on a rejected/notified commit — is guarded.
 * Without this, a stale-write rejection over WS was silently absent from
 * `ClaimLog.collisions()` (the bug this test now pins).
 *
 * Harness: stub the global `WebSocket` with a fake whose `onmessage` we can fire
 * by hand, install an ambient context whose `observability` is our ClaimLog,
 * register a pending commit via `sendCommit`, then feed the server ack frame.
 * The only thing faked is the socket transport — the handler under test is real.
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
import { EFFECTIVE_AUTHORITY_FIXTURE } from '@abloatai/transaction/testing/fixtures/httpResponses';

const COMMIT_TIMES = {
  createdAt: '2026-08-05T10:00:00.000Z',
  statusAt: '2026-08-05T10:00:00.058Z',
} as const;

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

function installContext(log: ClaimLog): void {
  initRuntime({
    logger: noopLogger,
    observability: log,
    onlineStatus: browserOnlineStatus,
    sessionErrorDetector: defaultSessionErrorDetector,
    config: emptyConfig,
    getModelMetadata: () => undefined,
    mutationExecutor: {
      commit: () => Promise.resolve({
        status: 'confirmed' as const,
        statusAt: COMMIT_TIMES.statusAt,
        lastSyncId: 0,
      }),
      executeCreate: () => Promise.resolve(),
      executeUpdate: () => Promise.resolve(null),
      executeDelete: () => Promise.resolve(),
      executeArchive: () => Promise.resolve(),
      executeUnarchive: () => Promise.resolve(),
    },
  });
}

const OP = { type: 'UPDATE', model: 'documents', id: 'doc-main', input: { content: {} } };

function ackFrame(payload: Record<string, unknown>): { data: string } {
  return { data: JSON.stringify({ type: 'mutation_result', payload }) };
}

function receiveAck(
  socket: FakeWebSocket,
  payload: Record<string, unknown>,
): void {
  if (!socket.onmessage) throw new Error('expected a WebSocket message handler');
  socket.onmessage(ackFrame(
    payload.object === 'commit_receipt'
      ? { authority: EFFECTIVE_AUTHORITY_FIXTURE, ...payload }
      : payload,
  ));
}

describe('WS transport observability wiring', () => {
  const realWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;

  afterEach(() => {
    (globalThis as { WebSocket?: unknown }).WebSocket = realWebSocket;
    resetRuntime();
  });

  function connectFake(log: ClaimLog): { ws: SyncWebSocket; fake: FakeWebSocket } {
    installContext(log);
    (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
    const ws = new SyncWebSocket({
      baseUrl: 'http://localhost:8080',
      syncGroups: [],
      userId: 'u1',
      organizationId: 'org1',
    });
    ws.connect();
    const fake = (ws as unknown as { ws: FakeWebSocket }).ws;
    return { ws, fake };
  }

  it('records a collision (naming the row) when a commit is rejected stale', async () => {
    const log = new ClaimLog();
    const { ws, fake } = connectFake(log);
    const txId = 'tx-stale-1';
    const pending = ws.sendCommit([OP], txId);

    receiveAck(fake, {
      clientTxId: txId,
      success: false,
      error: {
        code: 'stale_context',
        message: 'received deltas since readAt',
        conflicts: [{ model: 'documents', id: 'doc-main', observedSyncId: 7 }],
      },
    });

    await expect(pending).rejects.toMatchObject({ code: 'stale_context' });
    const collisions = log.collisions();
    expect(collisions).toHaveLength(1);
    const collision = collisions[0];
    if (!collision) throw new Error('expected a recorded collision');
    expect(collision.conflict).toBeDefined();
    expect(collision.line).toContain('documents/doc-main');
  });

  it('does NOT record a collision for a non-coordination rejection (validation error)', async () => {
    const log = new ClaimLog();
    const { ws, fake } = connectFake(log);
    const txId = 'tx-val-1';
    const pending = ws.sendCommit([OP], txId);

    receiveAck(fake, {
      clientTxId: txId,
      success: false,
      error: { code: 'validation_error', message: 'bad input' },
    });

    await expect(pending).rejects.toBeDefined();
    expect(log.collisions()).toHaveLength(0);
  });

  it('preserves a queued success instead of normalizing it to confirmed', async () => {
    const log = new ClaimLog();
    const { ws, fake } = connectFake(log);
    const txId = 'tx-forwarded-1';
    const pending = ws.sendCommit([OP], txId);

    receiveAck(fake, {
      object: 'commit_receipt',
      clientTxId: txId,
      serverTxId: '0',
      ...COMMIT_TIMES,
      success: true,
      status: 'queued',
      correlationId: 'corr-forwarded-1',
      lastSyncId: 0,
      ops: 1,
      missingIds: ['missing-row'],
    });

    await expect(pending).resolves.toEqual({
      status: 'queued',
      statusAt: COMMIT_TIMES.statusAt,
      correlationId: 'corr-forwarded-1',
      lastSyncId: 0,
      missingIds: ['missing-row'],
    });
  });

  it('can return the exact authoritative receipt for logical commit correlation', async () => {
    const log = new ClaimLog();
    const { ws, fake } = connectFake(log);
    const txId = 'tx-exact-receipt';
    const pending = ws.sendCommitReceipt([OP], txId);

    receiveAck(fake, {
      object: 'commit_receipt',
      clientTxId: txId,
      serverTxId: 'server-exact',
      ...COMMIT_TIMES,
      success: true,
      authority: EFFECTIVE_AUTHORITY_FIXTURE,
      status: 'confirmed',
      correlationId: 'corr-exact',
      lastSyncId: 43,
      ops: 1,
    });

    await expect(pending).resolves.toEqual({
      object: 'commit_receipt',
      clientTxId: txId,
      serverTxId: 'server-exact',
      ...COMMIT_TIMES,
      success: true,
      authority: EFFECTIVE_AUTHORITY_FIXTURE,
      status: 'confirmed',
      correlationId: 'corr-exact',
      lastSyncId: 43,
      ops: 1,
      missingIds: undefined,
    });
  });

  it('fails closed when a queued success omits its WAL correlation', async () => {
    const log = new ClaimLog();
    const { ws, fake } = connectFake(log);
    const txId = 'tx-forwarded-invalid';
    const pending = ws.sendCommit([OP], txId);

    receiveAck(fake, {
      object: 'commit_receipt',
      clientTxId: txId,
      serverTxId: '0',
      ...COMMIT_TIMES,
      success: true,
      status: 'queued',
      lastSyncId: 0,
      ops: 1,
    });

    await expect(pending).rejects.toMatchObject({ code: 'commit_no_result' });
  });
});
