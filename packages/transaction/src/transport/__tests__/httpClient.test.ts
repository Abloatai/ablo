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
import { defineSchema, model, z } from '../../schema/index.js';
import {
  claimHeartbeatReply,
  claimListResponse,
  claimQueuedResponse,
  modelClaim,
  modelReadResponse,
} from '../../testing/fixtures/httpResponses.js';

const schema = defineSchema({
  tasks: model({ title: z.string(), status: z.string() }),
});

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
    const tasks = make().tasks;
    for (const m of ['get', 'list', 'create', 'update', 'delete'] as const) {
      expect(typeof Reflect.get(tasks, m)).toBe('function');
    }
    expect(typeof tasks.claim).toBe('function'); // claim is callable
    expect(typeof tasks.claim.release).toBe('function'); // …with .release
  });

  it('passes lifecycle and commit members through without exposing the protocol accessor', () => {
    const c = make();
    expect(c.commits).toBeDefined();
    expect(typeof c.ready).toBe('function');
    expect(typeof c.dispose).toBe('function');
    expect(Reflect.get(c, 'model')).toBeUndefined();
  });

  it('does NOT expose turn/task primitives on the type — the surface is ablo.<model> + claim', () => {
    const c = make();
    // Turns and the agent-work task resource were removed; coordination +
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
    const tasks = make().tasks;
    expect(Reflect.get(tasks, 'onChange')).toBeUndefined();
    expect(Reflect.get(tasks, 'getAll')).toBeUndefined();
    expect(Reflect.get(tasks, 'getCount')).toBeUndefined();
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
      expect(typeof Reflect.get(c.tasks, m)).toBe('function');
    }
    expect(typeof c.tasks.claim).toBe('function');
    expect(c.commits).toBeDefined();
    expect(typeof c.ready).toBe('function');
    expect(typeof c.dispose).toBe('function');
  });

  it('narrows the TYPE to AbloHttpClient — stateful-only members are compile errors', () => {
    const c = makeViaAblo();
    // @ts-expect-error — `onChange` needs the stateful plane; absent on the HTTP type
    void c.tasks.onChange;
    // @ts-expect-error — local synced-pool reads have no HTTP analog
    void c.tasks.getAll;
    expect(Reflect.get(c.tasks, 'onChange')).toBeUndefined();
    expect(Reflect.get(c.tasks, 'getAll')).toBeUndefined();
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
                  model: 'tasks',
                  entityId: 'task-1',
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
    await expect(c.tasks.claim.state({ id: 'task-1' })).resolves.toEqual({
      object: 'claim',
      id: 'claim-1',
      status: 'active',
      description: 'editing',
      heldBy: 'agent-2',
      participantKind: 'agent',
      expiresAt: 1234,
      target: { type: 'tasks', id: 'task-1' },
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
        if (method === 'POST' && path === '/api/v1/models/tasks/task-1/claim') {
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
        if (method === 'GET' && path === '/api/v1/models/tasks/task-1') {
          return Promise.resolve(
            jsonResponse(
              modelReadResponse({
                model: 'tasks',
                id: 'task-1',
                data: { id: 'task-1', title: 'Report', status: 'open' },
                stamp: 41,
              }),
            ),
          );
        }
        return Promise.reject(new Error(`unexpected fetch: ${method} ${path}`));
      },
    });

    const held = await c.tasks.claim({ id: 'task-1' });
    expect(held.id).toBe('claim-q1');
    expect(held.fenceToken).toBe(7);
    // The snapshot was read AFTER the grant, so it reflects what the previous
    // holder committed before releasing.
    expect(held.data).toEqual({ id: 'task-1', title: 'Report', status: 'open' });
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
        if (method === 'POST' && path === '/api/v1/models/tasks/task-1/claim') {
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

    await expect(c.tasks.claim({ id: 'task-1', maxQueueDepth: 2 })).rejects.toMatchObject({
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
        if (method === 'POST' && path === '/api/v1/models/tasks/task-1/claim') {
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
      c.tasks.claim({ id: 'task-1', waitTimeoutMs: 500 }),
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
        if (method === 'POST' && path === '/api/v1/models/tasks/task-1/claim') {
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
    const wait = c.tasks.claim({ id: 'task-1', signal: controller.signal });
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
    const c = Ablo({
      schema,
      apiKey: 'sk_test_tryclaim',
      baseURL: 'https://api.example.test',
      transport: 'http',
      fetch: (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = init?.method ?? 'GET';
        if (method === 'POST' && new URL(url).pathname === '/api/v1/models/tasks/task-1/claim') {
          return Promise.resolve(
            jsonResponse(
              { error: { code: 'entity_claimed', message: 'Claimed by agent:other on tasks/task-1.' } },
              409,
            ),
          );
        }
        return Promise.reject(new Error(`unexpected fetch: ${method} ${url}`));
      },
    });

    await expect(c.tasks.claim({ id: 'task-1', queue: false })).resolves.toBeNull();
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
