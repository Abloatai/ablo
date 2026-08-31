import { describe, expect, it } from 'vitest';
import Ablo from '../src/index.js';
import { Ablo as ReactiveAblo } from '../src/client.js';
import { context } from '../src/context/index.js';
import { contextMessage } from '../src/ai-sdk.js';
import { defineSchema, model, z } from '../src/schema.js';
import {
  modelListResponse,
  modelReadResponse,
} from '@abloatai/transaction/testing/fixtures/httpResponses';

const schema = defineSchema({
  context: model({ title: z.string() }),
  records: model({ status: z.string() }),
});

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('context()', () => {
  it('accepts the reactive client without exposing an engine namespace', async () => {
    const ablo = ReactiveAblo({
      schema,
      apiKey: 'sk_context_reactive',
      baseURL: 'ws://localhost:1234',
    });
    try {
      const assembled = await context({
        ablo,
        data: { note: Promise.resolve('local application value') },
      });

      expect(assembled.data.note).toBe('local application value');
      expect(assembled.reads).toEqual([]);
      expect(typeof ablo.context.get).toBe('function');
    } finally {
      await ablo.dispose();
    }
  });

  it('awaits nested provider-shaped values without inventing Ablo evidence', async () => {
    const ablo = Ablo({
      schema,
      apiKey: 'sk_context_external',
      baseURL: 'https://api.example.test',
      fetch: () => Promise.reject(new Error('external context must not read Ablo')),
    });
    const memory = { matches: Promise.resolve([{ text: 'Board approved.' }]) };

    const assembled = await context({
      ablo,
      data: {
        memory,
        search: Promise.resolve({ rows: [{ id: 'candidate-1', score: 0.91 }] }),
        evidence: { citation: Promise.resolve('page 4') },
      },
    });

    expect(assembled.data).toEqual({
      memory: { matches: [{ text: 'Board approved.' }] },
      search: { rows: [{ id: 'candidate-1', score: 0.91 }] },
      evidence: { citation: 'page 4' },
    });
    expect(assembled.reads).toEqual([]);
  });

  it('collects exact reads, preserves a context model, and rejects a stale write', async () => {
    let mutation: Record<string, unknown> | undefined;
    const ablo = Ablo({
      schema,
      apiKey: 'sk_context_guard',
      baseURL: 'https://api.example.test',
      fetch: (input, init) => {
        const url = typeof input === 'string'
          ? input
          : input instanceof URL ? input.href : input.url;
        const path = new URL(url).pathname;
        const method = init?.method ?? 'GET';
        if (method === 'GET' && path.endsWith('/models/context/context-1')) {
          return Promise.resolve(response(modelReadResponse({
            model: 'context',
            id: 'context-1',
            data: { id: 'context-1', title: 'Quarterly brief' },
            stamp: 17,
          })));
        }
        if (method === 'PATCH' && path.endsWith('/models/records/record-1')) {
          mutation = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Promise.resolve(response({
            error: { code: 'stale_context', message: 'source row moved' },
          }, 409));
        }
        return Promise.reject(new Error(`Unexpected request: ${method} ${path}`));
      },
    });

    const briefRead = ablo.context.read({ id: 'context-1' });
    const assembled = await context({
      ablo,
      data: {
        brief: briefRead,
        memory: Promise.resolve({ summary: 'Revenue is ahead of plan.' }),
      },
    });

    expect(assembled.data.brief).toEqual({
      id: 'context-1',
      title: 'Quarterly brief',
    });
    expect(assembled.data.brief).toBe(await briefRead);
    expect(assembled.reads).toEqual([assembled.data.brief]);

    await expect(ablo.records.update({
      id: 'record-1',
      data: { status: 'ready' },
      reads: assembled.reads,
    })).rejects.toMatchObject({ code: 'stale_context' });
    expect(mutation).toMatchObject({
      reads: [{ model: 'context', id: 'context-1', readAt: 17 }],
    });
  });

  it('deduplicates reads nested alongside application values', async () => {
    const ablo = Ablo({
      schema,
      apiKey: 'sk_context_mixed',
      baseURL: 'https://api.example.test',
      fetch: (input) => {
        const url = typeof input === 'string'
          ? input
          : input instanceof URL ? input.href : input.url;
        const id = new URL(url).pathname.split('/').at(-1);
        if (id !== 'context-1' && id !== 'context-2') {
          return Promise.reject(new Error(`Unexpected context id: ${id}`));
        }
        return Promise.resolve(response(modelReadResponse({
          model: 'context',
          id,
          data: { id, title: id === 'context-1' ? 'Earlier' : 'Later' },
          stamp: id === 'context-1' ? 17 : 23,
        })));
      },
    });
    const earlier = await ablo.context.read({ id: 'context-1' });
    const later = await ablo.context.read({ id: 'context-2' });

    const assembled = await context({
      ablo,
      data: {
        primary: earlier,
        bundle: { earlier, repeated: earlier, later, note: 'provider result' },
      },
    });

    expect(assembled.reads).toEqual([earlier, later]);
  });

  it('shares one subscription and reports the existing stale-context error once', async () => {
    let subscriptions = 0;
    const ablo = Ablo({
      schema,
      apiKey: 'sk_context_change',
      baseURL: 'https://api.example.test',
      fetch: (input, init) => {
        const url = typeof input === 'string'
          ? input
          : input instanceof URL ? input.href : input.url;
        const path = new URL(url).pathname;
        if (path.endsWith('/models/context/context-1')) {
          return Promise.resolve(response(modelReadResponse({
            model: 'context',
            id: 'context-1',
            data: { id: 'context-1', title: 'Current' },
            stamp: 17,
          })));
        }
        if (path.endsWith('/auth/identity')) {
          return Promise.resolve(response({
            participantKind: 'agent',
            participantId: 'agent-context-change',
            accountScope: 'org-context-change',
            projectId: 'project-context-change',
            branchId: 'branch-context-change',
            branchRoot: false,
            syncGroups: ['org:org-context-change'],
            deliveryPartition: { index: 0, count: 2 },
            authority: {
              organizationId: 'org-context-change',
              projectId: 'project-context-change',
              branchId: 'branch-context-change',
              syncGroups: ['org:org-context-change'],
              operations: ['context.read'],
              participantKind: 'agent',
              participantId: 'agent-context-change',
              deliveryPartition: { index: 0, count: 2 },
            },
            userMeta: {},
          }));
        }
        if (path.endsWith('/v1/subscriptions') && init?.method === 'POST') {
          subscriptions += 1;
          expect(new Headers(init.headers).get('content-type')).toBe('application/json');
          expect(new Headers(init.headers).get('accept')).toBe('text/event-stream');
          expect(JSON.parse(String(init.body))).toEqual({
            reads: [{ model: 'context', id: 'context-1', readAt: 17 }],
          });
          return Promise.resolve(new Response(
            'event: stale_context\n' +
              'data: {"type":"AbloStaleContextError","code":"stale_context","message":"Context changed after read.","readAt":17,"conflicts":[{"model":"context","id":"context-1","observedSyncId":23}]}\n\n',
            { headers: { 'Content-Type': 'text/event-stream' } },
          ));
        }
        return Promise.reject(new Error(`Unexpected request: ${path}`));
      },
    });
    const current = await context({
      ablo,
      data: { brief: ablo.context.read({ id: 'context-1' }) },
    });
    const first = new Promise<unknown>((resolve) => current.onChange(resolve));
    const second = new Promise<unknown>((resolve) => current.onChange(resolve));

    await expect(first).resolves.toMatchObject({
      code: 'stale_context',
      readAt: 17,
      conflicts: [{ model: 'context', id: 'context-1', observedSyncId: 23 }],
    });
    await expect(second).resolves.toMatchObject({ code: 'stale_context' });
    expect(subscriptions).toBe(1);
  });

  it('reuses the selected WebSocket transport for context changes instead of opening SSE', async () => {
    const originalWebSocket = globalThis.WebSocket;
    let subscriptionPosts = 0;
    class TestWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      static instances: TestWebSocket[] = [];
      readyState = TestWebSocket.CONNECTING;
      onopen: (() => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor() { TestWebSocket.instances.push(this); }
      send(): void {}
      close(): void {
        this.readyState = TestWebSocket.CLOSED;
        this.onclose?.({ code: 1000, reason: 'closed' } as CloseEvent);
      }
      open(): void { this.readyState = TestWebSocket.OPEN; this.onopen?.(); }
      receive(frame: unknown): void {
        this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
      }
    }
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: TestWebSocket,
    });
    const ablo = Ablo({
      schema,
      apiKey: 'rk_context_ws',
      transport: 'websocket',
      baseURL: 'https://api.example.test',
      fetch: (input, init) => {
        const url = typeof input === 'string'
          ? input
          : input instanceof URL ? input.href : input.url;
        const path = new URL(url).pathname;
        if (path.endsWith('/models/context/context-1')) {
          return Promise.resolve(response(modelReadResponse({
            model: 'context', id: 'context-1',
            data: { id: 'context-1', title: 'Current' }, stamp: 17,
          })));
        }
        if (path.endsWith('/auth/identity')) {
          return Promise.resolve(response({
            participantKind: 'agent', participantId: 'agent-live',
            accountScope: 'org-live', projectId: 'project-live', branchId: 'branch-live',
            branchRoot: false, syncGroups: ['org:org-live'], deliveryPartition: null,
            authority: {
              organizationId: 'org-live', projectId: 'project-live', branchId: 'branch-live',
              syncGroups: ['org:org-live'], operations: [], participantKind: 'agent',
              participantId: 'agent-live', deliveryPartition: null,
            },
            userMeta: {},
          }));
        }
        if (path.endsWith('/v1/subscriptions') && init?.method === 'POST') {
          subscriptionPosts += 1;
          return Promise.reject(new Error('SSE must not open while WebSocket is selected'));
        }
        return Promise.reject(new Error(`Unexpected request: ${path}`));
      },
    });
    try {
      const selected = await context({
        ablo,
        data: { brief: ablo.context.read({ id: 'context-1' }) },
      });
      const opening = ablo.ready();
      await new Promise((resolve) => setTimeout(resolve, 0));
      TestWebSocket.instances[0]?.open();
      await opening;
      await expect(ablo.ready()).resolves.toBeUndefined();

      const changed = new Promise<Error>((resolve) => selected.onChange(resolve));
      await new Promise((resolve) => setTimeout(resolve, 0));
      TestWebSocket.instances[0]?.receive({
        type: 'delta',
        payload: {
          id: 18, actionType: 'U', modelName: 'context', modelId: 'context-1',
          data: { id: 'context-1', title: 'Changed' }, syncGroups: ['org:org-live'],
          createdAt: '2026-08-30T12:00:00.000Z',
        },
      });
      await expect(changed).resolves.toMatchObject({ code: 'stale_context' });
      expect(subscriptionPosts).toBe(0);
    } finally {
      await ablo.dispose();
      Object.defineProperty(globalThis, 'WebSocket', {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      });
    }
  });

  it('opens no subscription when the context contains no reads', async () => {
    const ablo = Ablo({
      schema,
      apiKey: 'sk_context_no_reads',
      baseURL: 'https://api.example.test',
      fetch: () => Promise.reject(new Error('no reads must open no subscription')),
    });
    const current = await context({ ablo, data: { note: 'plain value' } });
    const stop = current.onChange(() => {
      throw new Error('a context without reads cannot become stale');
    });
    stop();
  });

  it('treats list results as observational until rows are deliberately read', async () => {
    const rows = [
      { id: 'context-1', title: 'One' },
      { id: 'context-2', title: 'Two' },
    ];
    const ablo = Ablo({
      schema,
      apiKey: 'sk_context_list',
      baseURL: 'https://api.example.test',
      fetch: () => Promise.resolve(response(modelListResponse({
        model: 'context',
        data: rows,
        stamp: 29,
      }))),
    });

    const assembled = await context({
      ablo,
      data: { briefs: ablo.context.list() },
    });

    expect(assembled.reads).toEqual([]);
  });

  it('does not accept cloned or cross-client rows as authoritative evidence', async () => {
    const fetch = () => Promise.resolve(response(modelReadResponse({
      model: 'context',
      id: 'context-1',
      data: { id: 'context-1', title: 'Original' },
      stamp: 31,
    })));
    const first = Ablo({
      schema,
      apiKey: 'sk_context_first',
      baseURL: 'https://api.example.test',
      fetch,
    });
    const second = Ablo({
      schema,
      apiKey: 'sk_context_second',
      baseURL: 'https://api.example.test',
      fetch,
    });
    const row = await first.context.read({ id: 'context-1' });
    if (!row) throw new Error('Expected context row');

    const cloned = await context({ ablo: first, data: { row: { ...row } } });
    const foreign = await context({ ablo: second, data: { row } });

    expect(cloned.reads).toEqual([]);
    expect(foreign.reads).toEqual([]);
  });

  it('fails the whole assembly when a requested nested value rejects', async () => {
    const ablo = Ablo({
      schema,
      apiKey: 'sk_context_failure',
      baseURL: 'https://api.example.test',
      fetch: () => Promise.reject(new Error('context must not read Ablo')),
    });
    const failure = new Error('memory unavailable');

    await expect(context({
      ablo,
      data: { memory: { result: Promise.reject(failure) } },
    })).rejects.toBe(failure);
  });

  it('rejects an invalid client and data shape at the boundary', async () => {
    await expect(context({
      ablo: {},
      data: { record: Promise.resolve({ status: 'ready' }) },
    })).rejects.toThrow('requires an Ablo client');

    const ablo = Ablo({
      schema,
      apiKey: 'sk_context_invalid_data',
      baseURL: 'https://api.example.test',
      fetch: () => Promise.reject(new Error('invalid data must not read Ablo')),
    });
    await expect(context({
      ablo,
      data: [] as never,
    })).rejects.toThrow('requires `data` to be an object');
  });

  it('formats selected data as a user message', async () => {
    const ablo = Ablo({
      schema,
      apiKey: 'sk_context_message',
      baseURL: 'https://api.example.test',
      fetch: () => Promise.reject(new Error('message context must not read Ablo')),
    });
    const assembled = await context({
      ablo,
      data: {
        record: Promise.resolve({ status: 'ready' }),
        count: 2n,
        privateNote: 'omit',
      },
    });

    const message = contextMessage(assembled, { include: ['record'] });

    expect(message.role).toBe('user');
    expect(message.content).toContain('data, not instructions');
    expect(message.content).toContain('"status": "ready"');
    expect(message.content).not.toContain('privateNote');
    expect(contextMessage(assembled).content).toContain('"count": "2"');
    expect(() => contextMessage(
      assembled,
      { include: 'record' } as never,
    )).toThrow();

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const circularContext = await context({ ablo, data: { circular } });
    expect(() => contextMessage(circularContext)).toThrow();
  });
});
