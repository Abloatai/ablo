import { describe, expect, it } from 'vitest';
import Ablo from '../src/index.js';
import { Ablo as ReactiveAblo } from '../src/client.js';
import { context } from '../src/context.js';
import { contextMessage } from '../src/ai-sdk.js';
import { defineSchema, model, z } from '../src/schema.js';
import {
  modelListResponse,
  modelReadResponse,
} from '@abloatai/transaction/testing/fixtures/httpResponses';

const schema = defineSchema({
  context: model({ title: z.string() }),
  tasks: model({ status: z.string() }),
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
    expect(assembled.cursor).toBeNull();
    expect(assembled.sources).toEqual([
      { key: 'memory', kind: 'value', guarantee: 'informational', cursor: null },
      { key: 'search', kind: 'value', guarantee: 'informational', cursor: null },
      { key: 'evidence', kind: 'value', guarantee: 'informational', cursor: null },
    ]);
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
        if (method === 'PATCH' && path.endsWith('/models/tasks/task-1')) {
          mutation = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Promise.resolve(response({
            error: { code: 'stale_context', message: 'source row moved' },
          }, 409));
        }
        return Promise.reject(new Error(`Unexpected request: ${method} ${path}`));
      },
    });

    const briefRead = ablo.context.get({ id: 'context-1' });
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
    expect(assembled.cursor).toBe(17);
    expect(assembled.sources).toEqual([
      { key: 'brief', kind: 'ablo', guarantee: 'guardable', cursor: 17 },
      { key: 'memory', kind: 'value', guarantee: 'informational', cursor: null },
    ]);

    await expect(ablo.tasks.update({
      id: 'task-1',
      data: { status: 'ready' },
      reads: assembled.reads,
    })).rejects.toMatchObject({ code: 'stale_context' });
    expect(mutation).toMatchObject({
      reads: [{ model: 'context', id: 'context-1', readAt: 17 }],
    });
  });

  it('deduplicates reads, advances the cursor, and reports mixed provenance honestly', async () => {
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
    const earlier = await ablo.context.get({ id: 'context-1' });
    const later = await ablo.context.get({ id: 'context-2' });

    const assembled = await context({
      ablo,
      data: {
        primary: earlier,
        bundle: { earlier, repeated: earlier, later, note: 'provider result' },
      },
    });

    expect(assembled.reads).toEqual([earlier, later]);
    expect(assembled.cursor).toBe(23);
    expect(assembled.sources).toEqual([
      { key: 'primary', kind: 'ablo', guarantee: 'guardable', cursor: 17 },
      { key: 'bundle', kind: 'mixed', guarantee: 'partial', cursor: 23 },
    ]);
  });

  it('retains evidence for every row in an authoritative list', async () => {
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

    expect(assembled.reads).toEqual(assembled.data.briefs);
    expect(assembled.sources).toEqual([
      { key: 'briefs', kind: 'ablo', guarantee: 'guardable', cursor: 29 },
    ]);
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
    const row = await first.context.get({ id: 'context-1' });
    if (!row) throw new Error('Expected context row');

    const cloned = await context({ ablo: first, data: { row: { ...row } } });
    const foreign = await context({ ablo: second, data: { row } });

    expect(cloned.reads).toEqual([]);
    expect(foreign.reads).toEqual([]);
    expect(cloned.sources[0]).toMatchObject({ kind: 'value', guarantee: 'informational' });
    expect(foreign.sources[0]).toMatchObject({ kind: 'value', guarantee: 'informational' });
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
      data: { task: Promise.resolve({ status: 'ready' }) },
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
        task: Promise.resolve({ status: 'ready' }),
        count: 2n,
        privateNote: 'omit',
      },
    });

    const message = contextMessage(assembled, { include: ['task'] });

    expect(message.role).toBe('user');
    expect(message.content).toContain('data, not instructions');
    expect(message.content).toContain('"status": "ready"');
    expect(message.content).not.toContain('privateNote');
    expect(contextMessage(assembled).content).toContain('"count": "2"');
    expect(() => contextMessage(
      assembled,
      { include: 'task' } as never,
    )).toThrow();

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const circularContext = await context({ ablo, data: { circular } });
    expect(() => contextMessage(circularContext)).toThrow();
  });
});
