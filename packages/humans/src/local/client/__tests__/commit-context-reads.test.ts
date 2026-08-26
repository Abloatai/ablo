/** @jest-environment node */

import {
  EFFECTIVE_AUTHORITY_FIXTURE,
  modelReadResponse,
} from '@abloatai/transaction/testing/fixtures/httpResponses';
import { defineSchema, model } from '@abloatai/transaction/schema';
import { z } from 'zod';
import { Ablo, type InternalAbloOptions } from '../../../Ablo.js';

const schema = defineSchema({
  notes: model({ title: z.string(), status: z.string() }),
});

type TestOptions = InternalAbloOptions<(typeof schema)['models']>;

const sockets: MockWebSocket[] = [];
const originalWebSocket = globalThis.WebSocket;

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readonly url: string;
  readyState = MockWebSocket.OPEN;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly sent: string[] = [];

  constructor(url: string | URL) {
    this.url = String(url);
    sockets.push(this);
    queueMicrotask(() => this.onopen?.(new Event('open')));
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (typeof data !== 'string') return;
    this.sent.push(data);
    const frame = JSON.parse(data) as {
      type?: string;
      payload?: { clientTxId?: string; operations?: unknown[] };
    };
    if (frame.type !== 'commit' || !frame.payload?.clientTxId) return;
    const clientTxId = frame.payload.clientTxId;
    queueMicrotask(() => this.onmessage?.(new MessageEvent('message', {
      data: JSON.stringify({
        type: 'mutation_result',
        payload: {
          object: 'commit_receipt',
          clientTxId,
          serverTxId: `server-${clientTxId}`,
          createdAt: '2026-08-26T12:00:00.000Z',
          success: true,
          authority: EFFECTIVE_AUTHORITY_FIXTURE,
          status: 'confirmed',
          statusAt: '2026-08-26T12:00:00.010Z',
          lastSyncId: 62,
          ops: frame.payload?.operations?.length ?? 0,
        },
      }),
    })));
  }

  close(code = 1000, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code, reason }));
  }
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function createClient() {
  return Ablo({
    baseURL: 'ws://localhost:8080',
    schema,
    organizationId: 'org-1',
    branchId: 'branch-1',
    branchRoot: false,
    kind: 'agent',
    agentId: 'agent-1',
    bootstrapMode: 'none',
    inMemory: true,
    capabilityToken: 'test-token',
  } as TestOptions);
}

describe('reactive/WebSocket atomic commit context reads', () => {
  beforeEach(() => {
    sockets.length = 0;
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: MockWebSocket,
    });
    jest.mocked(globalThis.fetch).mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input instanceof URL
        ? input.href
        : input.url;
      if (new URL(url).pathname.endsWith('/sync/query')) {
        return Promise.resolve(response({
          results: [[{ id: 'note-2', title: 'Premise', status: 'ready' }]],
          evidence: [[{ id: 'note-2', stamp: 61 }]],
        }));
      }
      if (new URL(url).pathname.endsWith('/v1/models/notes/note-2')) {
        return Promise.resolve(response(modelReadResponse({
          model: 'notes',
          id: 'note-2',
          data: { id: 'note-2', title: 'Premise', status: 'ready' },
          stamp: 61,
        })));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  it('resolves a captured row into canonical reads on the commit frame', async () => {
    const client = createClient();
    try {
      await client.ready();
      const premise = await client.notes.read({ id: 'note-2' });
      if (!premise) throw new Error('expected premise row');

      await expect(client.commits.create({
        operations: [{
          action: 'update',
          model: 'notes',
          id: 'note-1',
          data: { status: 'reviewed' },
        }],
        reads: [{ ...premise }],
        idempotencyKey: 'ws-atomic-context-clone-must-fail',
        wait: 'queued',
      })).rejects.toMatchObject({ code: 'write_options_invalid', param: 'reads' });

      await client.commits.create({
        operations: [{
          action: 'update',
          model: 'notes',
          id: 'note-1',
          data: { status: 'reviewed' },
        }],
        reads: [premise],
        idempotencyKey: 'ws-atomic-context-reads',
        wait: 'queued',
      });

      const frames = sockets.flatMap((socket) => socket.sent.map((raw) => JSON.parse(raw)));
      const commit = frames.find((frame) => frame.type === 'commit');
      expect(commit?.payload).toMatchObject({
        clientTxId: 'ws-atomic-context-reads',
        reads: [{ model: 'notes', id: 'note-2', readAt: 61 }],
      });
      await client.waitForFlush(1_000);
    } finally {
      await client.dispose().catch(() => undefined);
    }
  });
});
