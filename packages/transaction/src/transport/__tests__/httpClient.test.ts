/**
 * @jest-environment node
 *
 * Runs in the node environment (not jsdom): these test the SERVER-SIDE HTTP
 * client, and `withServerRuntime` toggles the global `window` to prove the
 * browser-safety guard. jsdom 26 (jest 30) defines `window` as a
 * non-configurable accessor, so it can no longer be redefined or deleted — but
 * in node `window` is genuinely absent, which is the state these tests want.
 *
 * Unit tests for the stateless, typed HTTP client used by server-side actors
 * (agents, workers), constructed via the ONE factory `Ablo({ transport: 'http' })`.
 * These assert the FACADE SHAPE only, with no network: that typed model proxies +
 * protocol members resolve to the right things, and that stateful-only
 * capabilities are absent (they're compile errors via the `AbloHttpClient<S>`
 * type; here we confirm they're not present at runtime either, so a loose `any`
 * access can't accidentally hit one).
 */
import { Ablo } from '../../ablo.js';
import { defineSchema, model, selectModels, z } from '../../schema/index.js';
import { AbloError } from '../../errors.js';
import {
  claimAcquiredResponse,
  claimHeartbeatReply,
  claimListResponse,
  claimQueuedResponse,
  confirmedCommitReceiptResponse,
  modelClaim,
  modelListResponse,
  modelReadResponse,
} from '../../testing/fixtures/httpResponses.js';

const schema = defineSchema({
  items: model({ title: z.string(), status: z.string() }),
});

const COMMIT_TIMES = {
  createdAt: '2026-08-05T10:00:00.000Z',
  statusAt: '2026-08-05T10:00:00.058Z',
} as const;
const TEST_AUTHORITY = {
  organizationId: 'org-1', projectId: 'project-1', branchId: 'branch-1',
  syncGroups: ['org:org-1'], operations: [],
  participantKind: 'agent' as const, participantId: 'researcher-1', deliveryPartition: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const make = () =>
  Ablo({
    schema,
    apiKey: 'sk_test_facadeunit',
    baseURL: 'https://api.example.test',
    dangerouslyAllowBrowser: true,
    transport: 'http',
  });

describe("Ablo({ transport: 'http' }) facade shape", () => {
  it('exposes typed model proxies with the full HTTP surface', () => {
    const items = make().items;
    for (const m of ['get', 'list', 'create', 'update', 'delete'] as const) {
      expect(typeof Reflect.get(items, m)).toBe('function');
    }
    expect(typeof items.claim).toBe('function'); // claim is callable
    expect(typeof items.claim.release).toBe('function'); // …with .release
  });

  it('passes lifecycle and commit members through without exposing the protocol accessor', () => {
    const c = make();
    expect(c.commits).toBeDefined();
    expect(typeof c.ready).toBe('function');
    expect(typeof c.dispose).toBe('function');
    expect(Reflect.get(c, 'model')).toBeUndefined();
  });

  it('exposes the server-confirmed effective authority after readiness', async () => {
    const c = Ablo({
      schema,
      apiKey: 'rk_test_authority',
      baseURL: 'https://api.example.test',
      transport: 'http',
      fetch: () => Promise.resolve(jsonResponse({
        participantKind: 'agent',
        participantId: 'researcher-1',
        accountScope: 'org-1',
        projectId: 'project-1',
        branchId: 'branch-1',
        branchRoot: false,
        syncGroups: ['org:org-1'],
        deliveryPartition: null,
        authority: TEST_AUTHORITY,
        userMeta: {},
      })),
    });

    expect(c.identity).toBeNull();
    await c.ready();
    expect(c.identity).toEqual(TEST_AUTHORITY);
  });

  it('reads complete commit records through ordinary get/list methods', async () => {
    const record = {
      id: 'execution-1',
      attempts: [{
        id: 'request-1',
        observedAt: COMMIT_TIMES.createdAt,
        transport: 'http' as const,
        kind: 'execution' as const,
      }],
      actor: { kind: 'agent' as const, id: 'researcher-1' },
      authority: TEST_AUTHORITY,
      claims: [],
      createdAt: COMMIT_TIMES.createdAt,
      status: 'confirmed' as const,
      statusAt: COMMIT_TIMES.statusAt,
      lastSyncId: 41,
      readSet: [],
      operations: [{
        action: 'update',
        model: 'items',
        id: 'item-1',
        data: { retention: 'redacted' as const },
      }],
      receipt: { clientTxId: 'execution-1', serverTxId: '41', ops: 1 },
    };
    const requested: string[] = [];
    const c = Ablo({
      schema,
      apiKey: 'sk_test_commit_reads',
      baseURL: 'https://api.example.test',
      transport: 'http',
      fetch: (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        requested.push(url);
        return Promise.resolve(jsonResponse(
          url.includes('/execution-1')
            ? record
            : { data: [record], nextCursor: 'execution-0' },
        ));
      },
    });

    await expect(c.commits.get({ id: 'execution-1' })).resolves.toEqual(record);
    await expect(c.commits.list({
      where: { actorId: 'researcher-1', status: 'confirmed' },
      cursor: 'execution-2',
      limit: 25,
    })).resolves.toEqual({ data: [record], nextCursor: 'execution-0' });
    expect(requested[0]).toContain('/v1/commits/execution-1');
    expect(requested[1]).toContain('actorId=researcher-1');
    expect(requested[1]).toContain('status=confirmed');
    expect(requested[1]).toContain('cursor=execution-2');
    expect(requested[1]).toContain('limit=25');
  });

  it('does NOT expose turn/item primitives on the type — the surface is ablo.<model> + claim', () => {
    const c = make();
    // Turns and the agent-work item resource were removed; coordination +
    // attribution ride on `claim`. The @ts-expect-error lines ARE the
    // assertion — these members no longer exist on the type, so re-adding
    // `beginTurn` or `protocol` makes the directive unused and breaks this
    // file at compile time. Unknown runtime keys are undefined too, so loose
    // JavaScript cannot accidentally create a plausible phantom model.
    // @ts-expect-error — `beginTurn` was removed from the client surface
    void c.beginTurn;
    // @ts-expect-error — no `protocol` escape hatch on the facade
    void c.protocol;
    expect(Reflect.get(c, 'beginTurn')).toBeUndefined();
    expect(Reflect.get(c, 'protocol')).toBeUndefined();
    expect(c.commits).toBeDefined(); // a real protocol member still passes through
  });

  it('does not expose the retired dynamic model(name) door', () => {
    expect(Reflect.get(make(), 'model')).toBeUndefined();
  });

  it('does NOT expose stateful-only members at runtime (no get/getAll/onChange)', () => {
    // The HTTP model client implements only the request/response subset; the
    // stateful pool reads + live subscription have no HTTP analog and must be
    // absent so a stray dynamic access returns undefined, not a half-working stub.
    const items = make().items;
    expect(Reflect.get(items, 'onChange')).toBeUndefined();
    expect(Reflect.get(items, 'getAll')).toBeUndefined();
    expect(Reflect.get(items, 'getCount')).toBeUndefined();
  });

  it('a model the schema projection left out throws the error that names it', () => {
    // An app can compile against the full source schema while running a
    // projection, so this misuse never fails a type check. The access itself
    // must answer with the model's name and the fix, not undefined (which
    // crashes one property later as a bare TypeError).
    const full = defineSchema({
      items: model({ title: z.string() }),
      invoices: model({ total: z.number() }),
    });
    const projected = Ablo({
      schema: selectModels(full, ['items']),
      apiKey: 'sk_test_facadeunit',
      baseURL: 'https://api.example.test',
      dangerouslyAllowBrowser: true,
      transport: 'http',
    });
    let thrown: unknown;
    try {
      Reflect.get(projected, 'invoices');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AbloError);
    expect((thrown as AbloError).code).toBe('model_not_in_schema');
    expect((thrown as AbloError).message).toContain('invoices');
    // A plain typo is still a typo: only projected-out names get the error.
    expect(Reflect.get(projected, 'invocies')).toBeUndefined();
  });
});

describe("Ablo({ transport: 'http' }) — one factory, stateless client", () => {
  const makeViaAblo = () =>
    Ablo({
      schema,
      apiKey: 'sk_test_facadeunit',
      baseURL: 'https://api.example.test',
      dangerouslyAllowBrowser: true,
      transport: 'http',
    });

  it('returns the stateless HTTP facade (typed model proxies + protocol members)', () => {
    const c = makeViaAblo();
    for (const m of ['get', 'list', 'create', 'update', 'delete'] as const) {
      expect(typeof Reflect.get(c.items, m)).toBe('function');
    }
    expect(typeof c.items.claim).toBe('function');
    expect(c.commits).toBeDefined();
    expect(typeof c.ready).toBe('function');
    expect(typeof c.dispose).toBe('function');
  });

  it('forwards reads and track through a per-model update', async () => {
    let mutationBody: unknown;
    const c = Ablo({
      schema,
      apiKey: 'sk_test_read_dependencies',
      baseURL: 'https://api.example.test',
      transport: 'http',
      fetch: (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const path = new URL(url).pathname;
        const method = init?.method ?? 'GET';
        if (method === 'PATCH' && path === '/api/v1/models/items/item-1') {
          mutationBody = JSON.parse(String(init?.body));
          return Promise.resolve(jsonResponse({
            object: 'commit_receipt',
            clientTxId: 'client-tx-1',
            serverTxId: 'server-tx-1',
            success: true,
            authority: TEST_AUTHORITY,
            status: 'confirmed',
            ...COMMIT_TIMES, lastSyncId: 18,
            ops: 1,
          }));
        }
        if (method === 'GET' && path === '/api/v1/models/items/item-1') {
          return Promise.resolve(jsonResponse(modelReadResponse({
            model: 'items',
            id: 'item-1',
            data: { id: 'item-1', title: 'Ship it', status: 'done' },
            stamp: 18,
          })));
        }
        return Promise.reject(new Error(`unexpected fetch: ${method} ${url}`));
      },
    });

    await c.items.update({
      id: 'item-1',
      data: { status: 'done' },
      idempotencyKey: 'client-tx-1',
      reads: [{ model: 'runs', id: 'run-1', readAt: 16 }],
      track: [{ model: 'reports', id: 'report-1', readAt: 15 }],
    });

    expect(mutationBody).toMatchObject({
      reads: [{ model: 'runs', id: 'run-1', readAt: 16 }],
      track: [{ model: 'reports', id: 'report-1', readAt: 15 }],
    });
  });

  it('guards an update with the exact returned row passed through reads', async () => {
    const mutationBodies: Record<string, unknown>[] = [];
    let reads = 0;
    const c = Ablo({
      schema,
      apiKey: 'sk_test_automatic_read_set',
      baseURL: 'https://api.example.test',
      transport: 'http',
      fetch: (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const path = new URL(url).pathname;
        const method = init?.method ?? 'GET';
        if (method === 'GET' && path === '/api/v1/models/items/item-1') {
          reads += 1;
          return Promise.resolve(jsonResponse(modelReadResponse({
            model: 'items',
            id: 'item-1',
            data: { id: 'item-1', title: 'Ship it', status: reads === 1 ? 'todo' : 'done' },
            stamp: reads === 1 ? 17 : 18,
          })));
        }
        if (method === 'PATCH' && path === '/api/v1/models/items/item-1') {
          mutationBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return Promise.resolve(jsonResponse({
            object: 'commit_receipt',
            clientTxId: 'guarded-update',
            serverTxId: 'server-guarded-update',
            success: true,
            authority: TEST_AUTHORITY,
            status: 'confirmed',
            ...COMMIT_TIMES, lastSyncId: 18,
            ops: 1,
          }));
        }
        return Promise.reject(new Error(`unexpected fetch: ${method} ${url}`));
      },
    });

    const item = await c.items.get({ id: 'item-1' });
    expect(item).toEqual({ id: 'item-1', title: 'Ship it', status: 'todo' });
    expect(item).not.toHaveProperty('stamp');
    await c.items.update({
      id: 'item-1',
      data: { status: 'done' },
      idempotencyKey: 'guarded-update',
      reads: [item!],
    });

    expect(mutationBodies).toEqual([
      expect.objectContaining({
        reads: [{ model: 'items', id: 'item-1', readAt: 17 }],
      }),
    ]);
  });

  it('keeps explicit dependencies on every functional CAS attempt', async () => {
    const attemptKeys: string[] = [];
    const mutationBodies: Record<string, unknown>[] = [];
    let pointReads = 0;
    let attempts = 0;
    const updater = jest.fn((current: { status: string }) => ({
      status: current.status === 'todo' ? 'review' : 'done',
    }));
    const c = Ablo({
      schema,
      apiKey: 'sk_test_functional_bracket',
      baseURL: 'https://api.example.test',
      transport: 'http',
      fetch: (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const path = new URL(url).pathname;
        const method = init?.method ?? 'GET';
        if (method === 'GET' && path.endsWith('/item-2')) {
          return Promise.resolve(jsonResponse(modelReadResponse({
            model: 'items', id: 'item-2',
            data: { id: 'item-2', title: 'Run dependency', status: 'ready' },
            stamp: 99,
          })));
        }
        if (method === 'GET' && path.endsWith('/item-1')) {
          pointReads += 1;
          const final = pointReads >= 3;
          return Promise.resolve(jsonResponse(modelReadResponse({
            model: 'items', id: 'item-1',
            data: {
              id: 'item-1', title: 'Functional',
              status: final ? 'done' : pointReads === 1 ? 'todo' : 'blocked',
            },
            stamp: final ? 103 : pointReads === 1 ? 100 : 101,
          })));
        }
        if (method === 'PATCH' && path.endsWith('/item-1')) {
          attempts += 1;
          const key = new Headers(init?.headers).get('Idempotency-Key');
          if (!key) return Promise.reject(new Error('missing attempt key'));
          attemptKeys.push(key);
          mutationBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          if (attempts === 1) {
            return Promise.resolve(jsonResponse({
              error: { code: 'stale_context', message: 'row moved' },
            }, 409));
          }
          return Promise.resolve(jsonResponse({
            object: 'commit_receipt', clientTxId: key,
            serverTxId: 'server-functional', success: true, authority: TEST_AUTHORITY,
            status: 'confirmed', ...COMMIT_TIMES, lastSyncId: 103, ops: 1,
          }));
        }
        return Promise.reject(new Error(`unexpected fetch: ${method} ${url}`));
      },
    });

    const dependency = await c.items.get({ id: 'item-2' });
    if (!dependency) throw new Error('expected cross-target dependency');
    await expect(c.items.update('item-1', updater, {
      retries: 1,
      reads: [dependency],
    })).resolves.toMatchObject({ status: 'done' });

    expect(updater).toHaveBeenCalledTimes(2);
    expect(attemptKeys).toHaveLength(2);
    expect(attemptKeys[0]).not.toBe(attemptKeys[1]);
    expect(attemptKeys.every((key) => !key.startsWith('readset:v1:'))).toBe(true);
    expect(mutationBodies).toEqual([
      expect.objectContaining({
        readAt: 100,
        data: { status: 'review' },
        reads: [{ model: 'items', id: 'item-2', readAt: 99 }],
      }),
      expect.objectContaining({
        readAt: 101,
        data: { status: 'done' },
        reads: [{ model: 'items', id: 'item-2', readAt: 99 }],
      }),
    ]);
  });

  it('does not invent guarded-absence evidence for an undefined result', async () => {
    let reads = 0;
    let createBody: Record<string, unknown> | undefined;
    let automaticKey: string | null = null;
    const c = Ablo({
      schema,
      apiKey: 'sk_test_absence_read_set',
      baseURL: 'https://api.example.test',
      transport: 'http',
      fetch: (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const path = new URL(url).pathname;
        const method = init?.method ?? 'GET';
        if (method === 'GET' && path === '/api/v1/models/items/item-new') {
          reads += 1;
          return Promise.resolve(jsonResponse(modelReadResponse({
            model: 'items',
            id: 'item-new',
            data: reads === 1
              ? null
              : { id: 'item-new', title: 'Created', status: 'todo' },
            stamp: reads === 1 ? 71 : 72,
          })));
        }
        if (method === 'POST' && path === '/api/v1/models/items') {
          createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          automaticKey = new Headers(init?.headers).get('Idempotency-Key');
          return Promise.resolve(jsonResponse({
            object: 'commit_receipt',
            clientTxId: automaticKey,
            serverTxId: 'server-created',
            success: true,
            authority: TEST_AUTHORITY,
            status: 'confirmed',
            ...COMMIT_TIMES, lastSyncId: 72,
            ops: 1,
          }));
        }
        return Promise.reject(new Error(`unexpected fetch: ${method} ${url}`));
      },
    });

    await expect(c.items.get({ id: 'item-new' })).resolves.toBeUndefined();
    await c.items.create({
      id: 'item-new',
      data: { title: 'Created', status: 'todo' },
      idempotencyKey: 'create-if-absent:item-new',
    });

    expect(automaticKey).toBe('create-if-absent:item-new');
    expect(createBody).toMatchObject({
      id: 'item-new',
      data: { title: 'Created', status: 'todo' },
    });
    expect(createBody).not.toHaveProperty('readAt');
    expect(createBody).not.toHaveProperty('reads');
  });

  it('accepts an exact list row through explicit reads without a point reread', async () => {
    let mutationBody: Record<string, unknown> | undefined;
    let listReads = 0;
    let pointReads = 0;
    const c = Ablo({
      schema,
      apiKey: 'sk_test_list_read_set',
      baseURL: 'https://api.example.test',
      transport: 'http',
      fetch: (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const path = new URL(url).pathname;
        const method = init?.method ?? 'GET';
        if (method === 'GET' && path === '/api/v1/models/items') {
          listReads += 1;
          return Promise.resolve(jsonResponse(modelListResponse({
            model: 'items',
            data: [{ id: 'item-1', title: 'Listed', status: 'todo' }],
            stamp: 9_999,
            evidence: [{ id: 'item-1', stamp: 80 }],
          })));
        }
        if (method === 'GET' && path === '/api/v1/models/items/item-1') {
          pointReads += 1;
          return Promise.resolve(jsonResponse(modelReadResponse({
            model: 'items',
            id: 'item-1',
            // The row stopped matching the original filter after the list.
            data: { id: 'item-1', title: 'Refreshed', status: 'done' },
            stamp: 81,
          })));
        }
        if (method === 'PATCH' && path === '/api/v1/models/items/item-1') {
          mutationBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          const key = new Headers(init?.headers).get('Idempotency-Key');
          return Promise.resolve(jsonResponse({
            object: 'commit_receipt', clientTxId: key,
            serverTxId: 'server-list-update', success: true, authority: TEST_AUTHORITY,
            status: 'confirmed', ...COMMIT_TIMES, lastSyncId: 82, ops: 1,
          }));
        }
        return Promise.reject(new Error(`unexpected fetch: ${method} ${url}`));
      },
    });

    const [item] = await c.items.list({ where: { status: 'todo' } });
    expect(item).toEqual({ id: 'item-1', title: 'Listed', status: 'todo' });
    if (!item) throw new Error('expected listed item');
    await c.items.update({
      id: item.id,
      data: { status: 'done' },
      reads: [item],
      idempotencyKey: 'list-update:item-1',
    });

    // The only point read is the update's established result readback.
    expect({ listReads, pointReads }).toEqual({ listReads: 1, pointReads: 1 });
    expect(mutationBody).toMatchObject({
      reads: [{ model: 'items', id: 'item-1', readAt: 80 }],
    });
    expect(mutationBody).not.toMatchObject({
      reads: [{ model: 'items', id: 'item-1', readAt: 9_999 }],
    });
  });

  it('does not turn an incidental read into a write dependency', async () => {
    let mutationBody: Record<string, unknown> | undefined;
    const c = Ablo({
      schema,
      apiKey: 'sk_test_incidental_read',
      baseURL: 'https://api.example.test',
      transport: 'http',
      fetch: (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const path = new URL(url).pathname;
        const method = init?.method ?? 'GET';
        if (method === 'GET' && path.endsWith('/item-2')) {
          return Promise.resolve(jsonResponse(modelReadResponse({
            model: 'items', id: 'item-2',
            data: { id: 'item-2', title: 'Incidental', status: 'todo' }, stamp: 31,
          })));
        }
        if (method === 'PATCH' && path.endsWith('/item-1')) {
          mutationBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Promise.resolve(jsonResponse({
            object: 'commit_receipt', clientTxId: 'incidental-update',
            serverTxId: 'server-incidental-update', success: true, authority: TEST_AUTHORITY,
            status: 'confirmed', ...COMMIT_TIMES, lastSyncId: 32, ops: 1,
          }));
        }
        if (method === 'GET' && path.endsWith('/item-1')) {
          return Promise.resolve(jsonResponse(modelReadResponse({
            model: 'items', id: 'item-1',
            data: { id: 'item-1', title: 'Target', status: 'done' }, stamp: 32,
          })));
        }
        return Promise.reject(new Error(`unexpected fetch: ${method} ${url}`));
      },
    });

    await c.items.get({ id: 'item-2' });
    await c.items.update({
      id: 'item-1', data: { status: 'done' }, idempotencyKey: 'incidental-update',
    });

    expect(mutationBody).not.toHaveProperty('readAt');
    expect(mutationBody).not.toHaveProperty('reads');
  });

  it('resolves an exact captured row in reads and rejects a clone', async () => {
    let mutationBody: Record<string, unknown> | undefined;
    const c = Ablo({
      schema,
      apiKey: 'sk_test_row_reference',
      baseURL: 'https://api.example.test',
      transport: 'http',
      fetch: (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const path = new URL(url).pathname;
        const method = init?.method ?? 'GET';
        if (method === 'GET' && path.endsWith('/item-2')) {
          return Promise.resolve(jsonResponse(modelReadResponse({
            model: 'items', id: 'item-2',
            data: { id: 'item-2', title: 'Dependency', status: 'ready' }, stamp: 41,
          })));
        }
        if (method === 'PATCH' && path.endsWith('/item-1')) {
          mutationBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Promise.resolve(jsonResponse({
            object: 'commit_receipt', clientTxId: 'cross-target-update',
            serverTxId: 'server-cross-target-update', success: true, authority: TEST_AUTHORITY,
            status: 'confirmed', ...COMMIT_TIMES, lastSyncId: 42, ops: 1,
          }));
        }
        if (method === 'GET' && path.endsWith('/item-1')) {
          return Promise.resolve(jsonResponse(modelReadResponse({
            model: 'items', id: 'item-1',
            data: { id: 'item-1', title: 'Target', status: 'done' }, stamp: 42,
          })));
        }
        return Promise.reject(new Error(`unexpected fetch: ${method} ${url}`));
      },
    });

    const dependency = await c.items.get({ id: 'item-2' });
    expect(dependency).toBeDefined();
    await expect(c.items.update({
      id: 'item-1', data: { status: 'done' },
      idempotencyKey: 'clone-must-fail', reads: [{ ...dependency! }],
    })).rejects.toMatchObject({ code: 'write_options_invalid', param: 'reads' });
    const otherClient = Ablo({
      schema,
      apiKey: 'sk_test_other_client',
      baseURL: 'https://api.example.test',
      transport: 'http',
      fetch: () => Promise.reject(new Error('cross-client row reached the network')),
    });
    await expect(otherClient.items.update({
      id: 'item-1', data: { status: 'done' },
      idempotencyKey: 'cross-client-must-fail', reads: [dependency!],
    })).rejects.toMatchObject({ code: 'write_options_invalid', param: 'reads' });
    await c.items.update({
      id: 'item-1', data: { status: 'done' },
      idempotencyKey: 'cross-target-update', reads: [dependency!],
    });

    expect(mutationBody).toMatchObject({
      reads: [{ model: 'items', id: 'item-2', readAt: 41 }],
    });
    expect(mutationBody).not.toHaveProperty('readAt');
  });

  it('carries a claim independently without adding an implicit read dependency', async () => {
    let mutationBody: Record<string, unknown> | undefined;
    let rowReads = 0;
    const c = Ablo({
      schema,
      apiKey: 'sk_test_claim_read_set',
      baseURL: 'https://api.example.test',
      transport: 'http',
      fetch: (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const path = new URL(url).pathname;
        const method = init?.method ?? 'GET';
        if (method === 'POST' && path.endsWith('/item-1/claim')) {
          return Promise.resolve(jsonResponse(claimAcquiredResponse(modelClaim({
            id: 'claim-read-set', model: 'items', entityId: 'item-1', fenceToken: 9,
          }))));
        }
        if (method === 'GET' && path.endsWith('/item-1')) {
          rowReads += 1;
          return Promise.resolve(jsonResponse(modelReadResponse({
            model: 'items', id: 'item-1',
            data: { id: 'item-1', title: 'Claimed', status: rowReads === 1 ? 'todo' : 'done' },
            stamp: rowReads === 1 ? 51 : 52,
          })));
        }
        if (method === 'PATCH' && path.endsWith('/item-1')) {
          mutationBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Promise.resolve(jsonResponse(confirmedCommitReceiptResponse({
            clientTxId: 'claimed-update',
            serverTxId: 'server-claimed-update',
            lastSyncId: 52,
          })));
        }
        return Promise.reject(new Error(`unexpected fetch: ${method} ${url}`));
      },
    });

    const held = await c.items.claim({ id: 'item-1' });
    await c.items.update({
      id: 'item-1', data: { status: 'done' }, claim: held,
      idempotencyKey: 'claimed-update',
    });

    expect(mutationBody).toMatchObject({
      claim: 'claim-read-set',
      fenceToken: 9,
    });
    expect(mutationBody).not.toHaveProperty('readAt');
    expect(mutationBody).not.toHaveProperty('reads');
  });

  it('rejects cloned rows and leaves idempotency identity explicit', async () => {
    const observedKeys: string[] = [];
    const rowStamp = 61;
    const c = Ablo({
      schema,
      apiKey: 'sk_test_execution_identity',
      baseURL: 'https://api.example.test',
      transport: 'http',
      fetch: (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const path = new URL(url).pathname;
        const method = init?.method ?? 'GET';
        if (method === 'GET' && path.endsWith('/item-1')) {
          return Promise.resolve(jsonResponse(modelReadResponse({
            model: 'items', id: 'item-1',
            data: { id: 'item-1', title: 'Stable', status: 'done' }, stamp: rowStamp,
          })));
        }
        if (method === 'PATCH' && path.endsWith('/item-1')) {
          const idempotencyKey = new Headers(init?.headers).get('Idempotency-Key');
          if (!idempotencyKey) return Promise.reject(new Error('missing Idempotency-Key'));
          observedKeys.push(idempotencyKey);
          return Promise.resolve(jsonResponse({
            object: 'commit_receipt', clientTxId: idempotencyKey,
            serverTxId: `server-${idempotencyKey}`, success: true, authority: TEST_AUTHORITY,
            status: 'confirmed', ...COMMIT_TIMES, lastSyncId: rowStamp, ops: 1,
          }));
        }
        return Promise.reject(new Error(`unexpected fetch: ${method} ${url}`));
      },
    });

    const run = async () => {
      const item = await c.items.get({ id: 'item-1' });
      if (!item) throw new Error('expected item read');
      const cloned = { ...item } as typeof item;
      await expect(
        c.items.update({
          id: 'item-1',
          data: { status: 'done' },
          reads: [cloned],
        }),
      ).rejects.toMatchObject({
        code: 'write_options_invalid',
        param: 'reads',
      });
      await c.items.update({
        id: 'item-1', data: { status: 'done' },
        reads: [item], idempotencyKey: 'turn-stable-1',
      });
      await c.items.update({
        id: 'item-1',
        data: { status: 'done' },
        idempotencyKey: 'explicit-second-operation',
      });
    };

    await run();

    expect(observedKeys).toEqual(['turn-stable-1', 'explicit-second-operation']);
  });

  it('narrows the TYPE to AbloHttpClient — stateful-only members are compile errors', () => {
    const c = makeViaAblo();
    // @ts-expect-error — `onChange` needs the stateful plane; absent on the HTTP type
    void c.items.onChange;
    // @ts-expect-error — local synced-pool reads have no HTTP analog
    void c.items.getAll;
    expect(Reflect.get(c.items, 'onChange')).toBeUndefined();
    expect(Reflect.get(c.items, 'getAll')).toBeUndefined();
  });

  it('decodes HTTP claim state into the public Claim shape', async () => {
    const c = Ablo({
      schema,
      apiKey: 'sk_test_claimshape',
      baseURL: 'https://api.example.test',
      transport: 'http',
      fetch: (input) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.includes('/v1/claims'))
          return Promise.reject(new Error(`unexpected fetch: ${url}`));
        return Promise.resolve(
          jsonResponse(
            claimListResponse({
              claims: [
                modelClaim({
                  id: 'claim-1',
                  model: 'items',
                  entityId: 'item-1',
                  actor: 'agent-2',
                  participantKind: 'agent',
                  description: 'editing',
                  status: 'active',
                  expiresAt: 1234,
                }),
              ],
            }),
          ),
        );
      },
    });

    // The server response carries the claim's `description`, which the client
    // surfaces as the always-present `description`.
    await expect(c.items.claim.state({ id: 'item-1' })).resolves.toEqual({
      object: 'claim',
      id: 'claim-1',
      status: 'active',
      description: 'editing',
      heldBy: 'agent-2',
      participantKind: 'agent',
      expiresAt: 1234,
      target: { type: 'items', id: 'item-1' },
    });
  });

  // One spelling on both transports: a contended claim WAITS — the same
  // sentence the socket client honors. Over HTTP the SDK heartbeats the
  // queued ticket until the line moves, then resolves to the same held claim.
  it('a contended HTTP claim waits its turn and resolves to the held claim', async () => {
    const calls: string[] = [];
    const c = Ablo({
      schema,
      apiKey: 'sk_test_queuedclaim',
      baseURL: 'https://api.example.test',
      transport: 'http',
      fetch: (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = init?.method ?? 'GET';
        const path = new URL(url).pathname;
        calls.push(`${method} ${path}`);
        if (method === 'POST' && path === '/api/v1/models/items/item-1/claim') {
          return Promise.resolve(
            jsonResponse(
              claimQueuedResponse({ id: 'claim-q1', position: 0, heldBy: 'agent-2' }),
              202,
            ),
          );
        }
        if (method === 'POST' && path === '/api/v1/claims/claim-q1/heartbeat') {
          const beats = calls.filter((c) => c.endsWith('/claims/claim-q1/heartbeat')).length;
          // First beat: still in line. Second: the holder released — granted.
          return Promise.resolve(
            jsonResponse(
              claimHeartbeatReply(
                beats === 1
                  ? { claimId: 'claim-q1', status: 'queued', position: 0 }
                  : { claimId: 'claim-q1', status: 'held', expiresAt: Date.now() + 60_000 },
              ),
            ),
          );
        }
        if (method === 'GET' && path === '/api/v1/claims/claim-q1') {
          return Promise.resolve(
            jsonResponse({
              object: 'claim',
              id: 'claim-q1',
              status: 'active',
              fenceToken: 7,
              expiresAt: Date.now() + 60_000,
            }),
          );
        }
        if (method === 'GET' && path === '/api/v1/models/items/item-1') {
          return Promise.resolve(
            jsonResponse(
              modelReadResponse({
                model: 'items',
                id: 'item-1',
                data: { id: 'item-1', title: 'Report', status: 'open' },
                stamp: 41,
              }),
            ),
          );
        }
        return Promise.reject(new Error(`unexpected fetch: ${method} ${path}`));
      },
    });

    const held = await c.items.claim({ id: 'item-1' });
    expect(held.id).toBe('claim-q1');
    expect(held.fenceToken).toBe(7);
    // The snapshot was read AFTER the grant, so it reflects what the previous
    // holder committed before releasing.
    expect(held.data).toEqual({ id: 'item-1', title: 'Report', status: 'open' });
    expect(calls.filter((c) => c.endsWith('/claims/claim-q1/heartbeat')).length).toBe(2);
  }, 10_000);

  it('maxQueueDepth rejects a deep line and leaves the queue', async () => {
    const calls: string[] = [];
    const c = Ablo({
      schema,
      apiKey: 'sk_test_deepline',
      baseURL: 'https://api.example.test',
      transport: 'http',
      fetch: (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = init?.method ?? 'GET';
        const path = new URL(url).pathname;
        calls.push(`${method} ${path}`);
        if (method === 'POST' && path === '/api/v1/models/items/item-1/claim') {
          return Promise.resolve(
            jsonResponse(claimQueuedResponse({ id: 'claim-q1', position: 5 }), 202),
          );
        }
        if (method === 'DELETE' && path === '/api/v1/claims/claim-q1') {
          return Promise.resolve(jsonResponse({ ok: true }));
        }
        return Promise.reject(new Error(`unexpected fetch: ${method} ${path}`));
      },
    });

    await expect(c.items.claim({ id: 'item-1', maxQueueDepth: 2 })).rejects.toMatchObject({
      code: 'queue_too_deep',
    });
    // Backpressure leaves the line rather than letting the slot TTL out over
    // the heads of the waiters behind it.
    expect(calls).toContain('DELETE /api/v1/claims/claim-q1');
  });

  it('waitTimeoutMs caps the wait with grant_timeout and leaves the queue', async () => {
    const calls: string[] = [];
    const c = Ablo({
      schema,
      apiKey: 'sk_test_waitcap',
      baseURL: 'https://api.example.test',
      transport: 'http',
      fetch: (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = init?.method ?? 'GET';
        const path = new URL(url).pathname;
        calls.push(`${method} ${path}`);
        if (method === 'POST' && path === '/api/v1/models/items/item-1/claim') {
          return Promise.resolve(
            jsonResponse(claimQueuedResponse({ id: 'claim-q1', position: 1 }), 202),
          );
        }
        if (method === 'POST' && path === '/api/v1/claims/claim-q1/heartbeat') {
          return Promise.resolve(
            jsonResponse(
              claimHeartbeatReply({ claimId: 'claim-q1', status: 'queued', position: 1 }),
            ),
          );
        }
        if (method === 'DELETE' && path === '/api/v1/claims/claim-q1') {
          return Promise.resolve(jsonResponse({ ok: true }));
        }
        return Promise.reject(new Error(`unexpected fetch: ${method} ${path}`));
      },
    });

    await expect(
      c.items.claim({ id: 'item-1', waitTimeoutMs: 500 }),
    ).rejects.toMatchObject({ code: 'grant_timeout' });
    expect(calls).toContain('DELETE /api/v1/claims/claim-q1');
  }, 10_000);

  it('an aborted signal ends the wait with claim_wait_aborted and leaves the queue', async () => {
    const calls: string[] = [];
    const c = Ablo({
      schema,
      apiKey: 'sk_test_abortwait',
      baseURL: 'https://api.example.test',
      transport: 'http',
      fetch: (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = init?.method ?? 'GET';
        const path = new URL(url).pathname;
        calls.push(`${method} ${path}`);
        if (method === 'POST' && path === '/api/v1/models/items/item-1/claim') {
          return Promise.resolve(
            jsonResponse(claimQueuedResponse({ id: 'claim-q1', position: 1 }), 202),
          );
        }
        if (method === 'POST' && path === '/api/v1/claims/claim-q1/heartbeat') {
          return Promise.resolve(
            jsonResponse(
              claimHeartbeatReply({ claimId: 'claim-q1', status: 'queued', position: 1 }),
            ),
          );
        }
        if (method === 'DELETE' && path === '/api/v1/claims/claim-q1') {
          return Promise.resolve(jsonResponse({ ok: true }));
        }
        return Promise.reject(new Error(`unexpected fetch: ${method} ${path}`));
      },
    });

    const controller = new AbortController();
    const wait = c.items.claim({ id: 'item-1', signal: controller.signal });
    const assertion = expect(wait).rejects.toMatchObject({ code: 'claim_wait_aborted' });
    controller.abort();
    await assertion;
    // The abort left the line, not just the promise — the slot is not parked
    // in the queue until its TTL over the waiters behind it.
    expect(calls).toContain('DELETE /api/v1/claims/claim-q1');
  }, 10_000);

  it('claims.retrieve polls a ticket by id and decodes the wire claim state', async () => {
    const c = Ablo({
      schema,
      apiKey: 'sk_test_claimpoll',
      baseURL: 'https://api.example.test',
      transport: 'http',
      fetch: (input) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.endsWith('/v1/claims/claim-q1'))
          return Promise.reject(new Error(`unexpected fetch: ${url}`));
        return Promise.resolve(
          jsonResponse({
            object: 'claim',
            id: 'claim-q1',
            status: 'active',
            fenceToken: 7,
            expiresAt: 1234,
          }),
        );
      },
    });

    // The lookup names a claim, so the PARAMETER stays `claimId`; the reply IS
    // the claim, so it answers `id` — the rule `claimRecordSchema.id` states.
    await expect(c.claims.retrieve({ claimId: 'claim-q1' })).resolves.toEqual({
      object: 'claim',
      id: 'claim-q1',
      status: 'active',
      fenceToken: 7,
      expiresAt: 1234,
    });
  });

  it('claims.heartbeatAll beats every held lease in one round trip', async () => {
    const c = Ablo({
      schema,
      apiKey: 'sk_test_beatall',
      baseURL: 'https://api.example.test',
      transport: 'http',
      fetch: (input) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.endsWith('/v1/claims/heartbeat'))
          return Promise.reject(new Error(`unexpected fetch: ${url}`));
        return Promise.resolve(
          jsonResponse({
            object: 'list',
            results: [
              { claimId: 'claim-a', status: 'held', expiresAt: 9999, queueDepth: 1 },
              { claimId: 'claim-b', status: 'queued', position: 0 },
            ],
          }),
        );
      },
    });

    await expect(c.claims.heartbeatAll({ ttl: '5m' })).resolves.toEqual([
      { claimId: 'claim-a', status: 'held', expiresAt: 9999, queueDepth: 1 },
      { claimId: 'claim-b', status: 'queued', position: 0 },
    ]);
  });

  it('the try-claim resolves null over HTTP when the server answers entity_claimed', async () => {
    const onStatus = jest.fn();
    const c = Ablo({
      schema,
      apiKey: 'sk_test_tryclaim',
      baseURL: 'https://api.example.test',
      transport: 'http',
      fetch: (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = init?.method ?? 'GET';
        if (method === 'POST' && new URL(url).pathname === '/api/v1/models/items/item-1/claim') {
          return Promise.resolve(
            jsonResponse(
              { error: { code: 'entity_claimed', message: 'Claimed by agent:other on items/item-1.' } },
              409,
            ),
          );
        }
        return Promise.reject(new Error(`unexpected fetch: ${method} ${url}`));
      },
    });

    await expect(
      c.items.claim({
        id: 'item-1',
        contention: { mode: 'skip', onStatus },
      }),
    ).resolves.toBeNull();
    expect(onStatus).toHaveBeenCalledWith({
      type: 'skipped',
      error: expect.objectContaining({ code: 'entity_claimed' }),
    });
  });

  it('claims.release gives a ticket back by id', async () => {
    const seen: string[] = [];
    const c = Ablo({
      schema,
      apiKey: 'sk_test_releaseticket',
      baseURL: 'https://api.example.test',
      transport: 'http',
      fetch: (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        seen.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
        return Promise.resolve(jsonResponse({ ok: true }));
      },
    });

    await expect(c.claims.release({ claimId: 'claim-q1' })).resolves.toBeUndefined();
    expect(seen).toEqual(['DELETE /api/v1/claims/claim-q1']);
  });
});

/**
 * A collection read is a page and a filter, and both used to be lossy on this
 * transport: the filter was rebuilt by walking the caller's object and skipping
 * any value that turned out to be an object, and the page state was parsed off
 * the envelope and then dropped. Between them, a caller could ask for three
 * statuses out of five hundred rows and receive twenty unfiltered ones with
 * nothing in the result saying so.
 */
describe('collection reads carry the whole filter and say where the page ends', () => {
  const listUrlFor = async (
    options: Parameters<ReturnType<typeof Ablo<typeof schema>>['items']['list']>[0],
  ): Promise<URL> => {
    let seen: URL | undefined;
    const c = Ablo({
      schema,
      apiKey: 'sk_test_list_filter',
      baseURL: 'https://api.example.test',
      transport: 'http',
      fetch: (input) => {
        const href =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        seen = new URL(href);
        return Promise.resolve(jsonResponse(modelListResponse({ model: 'items', data: [] })));
      },
    });
    await c.items.list(options);
    if (!seen) throw new Error('no request was made');
    return seen;
  };

  it('sends an IN filter instead of discarding it', async () => {
    const url = await listUrlFor({ where: { status: ['todo', 'doing'] } });
    expect(JSON.parse(url.searchParams.get('where') ?? 'null')).toEqual([
      ['status', 'IN', ['todo', 'doing']],
    ]);
  });

  it('sends tuple-form operators', async () => {
    const url = await listUrlFor({ where: [['title', 'ILIKE', '%draft%']] });
    expect(JSON.parse(url.searchParams.get('where') ?? 'null')).toEqual([
      ['title', 'ILIKE', '%draft%'],
    ]);
  });

  it('sends a plain equality filter as a clause too', async () => {
    const url = await listUrlFor({ where: { status: 'todo' } });
    expect(JSON.parse(url.searchParams.get('where') ?? 'null')).toEqual([['status', 'todo']]);
  });

  it('repeats equality clauses in the shorthand so an older server still filters', async () => {
    // A server that predates the `where` parameter skips it silently, and a
    // dropped filter reads as a wider result rather than an error. The operator
    // clauses are the only thing such a server loses, and it could not have
    // honoured those anyway.
    const url = await listUrlFor({ where: { status: 'todo', title: 'Draft' } });
    expect(url.searchParams.get('status')).toBe('todo');
    expect(url.searchParams.get('title')).toBe('Draft');
    expect(JSON.parse(url.searchParams.get('where') ?? 'null')).toEqual([
      ['status', 'todo'],
      ['title', 'Draft'],
    ]);
  });

  it('does not put a non-equality clause in the shorthand, which cannot express it', async () => {
    const url = await listUrlFor({ where: { status: ['todo', 'doing'] } });
    expect(url.searchParams.get('status')).toBeNull();
    const ilike = await listUrlFor({ where: [['title', 'ILIKE', '%draft%']] });
    expect(ilike.searchParams.get('title')).toBeNull();
  });

  it('sends the cursor as cursor', async () => {
    const url = await listUrlFor({ limit: 50, cursor: 'cur_abc' });
    expect(url.searchParams.get('cursor')).toBe('cur_abc');
    // The retired spelling is a server-side alias only; the SDK stopped sending it.
    expect(url.searchParams.get('starting_after')).toBeNull();
    expect(url.searchParams.get('limit')).toBe('50');
  });

  it('reports a truncated page on the result, which is still an array', async () => {
    const c = Ablo({
      schema,
      apiKey: 'sk_test_list_page',
      baseURL: 'https://api.example.test',
      transport: 'http',
      fetch: () =>
        Promise.resolve(jsonResponse(modelListResponse({
          model: 'items',
          data: [{ id: 'item-1', title: 'One', status: 'todo' }],
          hasMore: true,
          nextCursor: 'cur_next',
        }))),
    });

    const rows = await c.items.list();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows.hasMore).toBe(true);
    expect(rows.nextCursor).toBe('cur_next');
    // The page state rides along without changing what the array serializes to.
    expect(JSON.parse(JSON.stringify(rows))).toEqual([
      { id: 'item-1', title: 'One', status: 'todo' },
    ]);
  });

  it('reports the end of a collection', async () => {
    const c = Ablo({
      schema,
      apiKey: 'sk_test_list_end',
      baseURL: 'https://api.example.test',
      transport: 'http',
      fetch: () =>
        Promise.resolve(jsonResponse(modelListResponse({ model: 'items', data: [] }))),
    });
    const rows = await c.items.list();
    expect(rows.hasMore).toBe(false);
    expect(rows.nextCursor).toBeNull();
  });
});
