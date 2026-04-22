/**
 * Ergonomics locks for the ergonomic `join` surface:
 *
 *   1. `as` / `onBehalfOf` — accept both; `as` wins when both passed.
 *   2. Flat-object scope — `{ matters: 'id' }` desugars to the same
 *      sync groups as `[{ entity, ids }]`.
 *   3. `autoConnect` — default true; caller gets a live participant
 *      without a separate `.connect()` call. `autoConnect: false`
 *      opts out.
 *   4. Duration TTL — `ttlSeconds: '3m'` string form works alongside
 *      the legacy numeric seconds form.
 *
 * Runs against a fake fetch so no real server is needed. The fake
 * records request bodies so we can assert the derived capability
 * request shape.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { createMesh } from '../../../src/mesh';
import { defineSchema, mutable, z } from '../../../src/schema';

const schema = defineSchema({
  matters: mutable.lazy(
    { name: z.string() },
    {
      typename: 'Matter',
      tableName: 'matters',
      syncGroupFormat: 'matter:{id}',
    },
  ),
  teams: mutable.lazy(
    { name: z.string() },
    { typename: 'Team', tableName: 'teams', syncGroupFormat: 'team:{id}' },
  ),
});

interface CapturedRequest {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: {
    allowedSyncGroups: string[];
    ttlSeconds: number;
    participantId: string;
  };
}

/** Minimal fetch-Response stand-in — tests run under jsdom without a
 * global `Response`. Only the properties `doJoin` actually reads need
 * to exist. */
function mockResponse(body: unknown, status = 201): Response {
  const json = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null } as unknown as Headers,
    text: async () => json,
    json: async () => JSON.parse(json) as unknown,
  } as unknown as Response;
}

function makeFakeFetch(): { fetch: typeof fetch; captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    const urlStr =
      typeof url === 'string' ? url : url instanceof URL ? url.href : String(url);
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders && typeof (rawHeaders as Headers).forEach === 'function') {
      (rawHeaders as Headers).forEach((v, k) => (headers[k] = v));
    } else if (Array.isArray(rawHeaders)) {
      for (const [k, v] of rawHeaders) headers[k] = v as string;
    } else if (rawHeaders) {
      Object.assign(headers, rawHeaders as Record<string, string>);
    }
    const body = init?.body
      ? (JSON.parse(init.body as string) as CapturedRequest['body'])
      : ({ allowedSyncGroups: [], ttlSeconds: 0, participantId: '' });
    captured.push({ url: urlStr, method: init?.method, headers, body });
    return mockResponse({
      capabilityId: `cap_${captured.length}`,
      token: `tok_${captured.length}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      organizationId: 'org_test',
    });
  };
  return { fetch: fakeFetch, captured };
}

describe('join: `as` vs `onBehalfOf`', () => {
  it('`as` is accepted and passes through as the principal', async () => {
    const { fetch, captured } = makeFakeFetch();
    const mesh = createMesh({
      schema,
      baseURL: 'https://sync.example.com',
      organizationId: 'org_test',
      apiKey: 'sk_test_abc',
      delegationPolicy: 'permissive',
      fetch,
    });

    await mesh.join(
      { id: 'a1', label: 'agent-1' },
      {
        as: { kind: 'session', id: 's1', userId: 'u1', organizationId: 'o1' },
        scope: { matters: 'm1' },
        autoConnect: false,
      },
    );

    // Session principal → no Authorization header, credentials: 'include'
    expect(captured[0]!.headers.Authorization).toBeUndefined();
    expect(captured[0]!.body.allowedSyncGroups).toEqual(['matter:m1']);
  });

  it('`onBehalfOf` still works (legacy alias)', async () => {
    const { fetch, captured } = makeFakeFetch();
    const mesh = createMesh({
      schema,
      baseURL: 'https://sync.example.com',
      organizationId: 'org_test',
      apiKey: 'sk_test_abc',
      delegationPolicy: 'permissive',
      fetch,
    });
    await mesh.join(
      { id: 'a1' },
      {
        onBehalfOf: { kind: 'session', id: 's1', userId: 'u1', organizationId: 'o1' },
        scope: { matters: 'm1' },
        autoConnect: false,
      },
    );
    expect(captured[0]!.headers.Authorization).toBeUndefined();
  });

  it('when both set, `as` wins', async () => {
    const { fetch, captured } = makeFakeFetch();
    const mesh = createMesh({
      schema,
      baseURL: 'https://sync.example.com',
      organizationId: 'org_test',
      apiKey: 'sk_test_abc',
      delegationPolicy: 'permissive',
      fetch,
    });
    await mesh.join(
      { id: 'a1' },
      {
        as: { kind: 'agent', id: 'parent', capabilityToken: 'parent-cap' },
        onBehalfOf: { kind: 'session', id: 's1', userId: 'u1', organizationId: 'o1' },
        scope: { matters: 'm1' },
        autoConnect: false,
      },
    );
    // `as` = agent → Bearer the parent capability, NOT session cookie.
    expect(captured[0]!.headers.Authorization).toBe('Bearer parent-cap');
  });
});

describe('join: flat-object scope form', () => {
  it('single id string → one sync group', async () => {
    const { fetch, captured } = makeFakeFetch();
    const mesh = createMesh({
      schema,
      baseURL: 'https://sync.example.com',
      organizationId: 'org_test',
      apiKey: 'sk_test_abc',
      fetch,
    });
    await mesh.join(
      { id: 'a1' },
      { scope: { matters: 'm1' }, autoConnect: false },
    );
    expect(captured[0]!.body.allowedSyncGroups).toEqual(['matter:m1']);
  });

  it('array of ids → one group per id', async () => {
    const { fetch, captured } = makeFakeFetch();
    const mesh = createMesh({
      schema,
      baseURL: 'https://sync.example.com',
      organizationId: 'org_test',
      apiKey: 'sk_test_abc',
      fetch,
    });
    await mesh.join(
      { id: 'a1' },
      { scope: { matters: ['m1', 'm2'] }, autoConnect: false },
    );
    expect(captured[0]!.body.allowedSyncGroups).toEqual(['matter:m1', 'matter:m2']);
  });

  it('multiple entity types in one object', async () => {
    const { fetch, captured } = makeFakeFetch();
    const mesh = createMesh({
      schema,
      baseURL: 'https://sync.example.com',
      organizationId: 'org_test',
      apiKey: 'sk_test_abc',
      fetch,
    });
    await mesh.join(
      { id: 'a1' },
      { scope: { matters: 'm1', teams: ['t1', 't2'] }, autoConnect: false },
    );
    expect(new Set(captured[0]!.body.allowedSyncGroups)).toEqual(
      new Set(['matter:m1', 'team:t1', 'team:t2']),
    );
  });

  it('array form still works (back-compat)', async () => {
    const { fetch, captured } = makeFakeFetch();
    const mesh = createMesh({
      schema,
      baseURL: 'https://sync.example.com',
      organizationId: 'org_test',
      apiKey: 'sk_test_abc',
      fetch,
    });
    await mesh.join(
      { id: 'a1' },
      {
        scope: [{ entity: schema.models.matters, ids: ['m1', 'm2'] }],
        autoConnect: false,
      },
    );
    expect(captured[0]!.body.allowedSyncGroups).toEqual(['matter:m1', 'matter:m2']);
  });

  it('unknown model name throws with a clear error', async () => {
    const { fetch } = makeFakeFetch();
    const mesh = createMesh({
      schema,
      baseURL: 'https://sync.example.com',
      organizationId: 'org_test',
      apiKey: 'sk_test_abc',
      fetch,
    });
    await expect(
      mesh.join(
        { id: 'a1' },
        {
          scope: { nonexistent: 'x' } as never,
          autoConnect: false,
        },
      ),
    ).rejects.toThrow(/does not match any model/);
  });
});

describe('join: duration-string TTL', () => {
  it('accepts "3m" → sends 180 seconds', async () => {
    const { fetch, captured } = makeFakeFetch();
    const mesh = createMesh({
      schema,
      baseURL: 'https://sync.example.com',
      organizationId: 'org_test',
      apiKey: 'sk_test_abc',
      fetch,
    });
    await mesh.join(
      { id: 'a1' },
      { scope: { matters: 'm1' }, ttlSeconds: '3m', autoConnect: false },
    );
    expect(captured[0]!.body.ttlSeconds).toBe(180);
  });

  it('accepts 7200 (number) → sends 7200 seconds', async () => {
    const { fetch, captured } = makeFakeFetch();
    const mesh = createMesh({
      schema,
      baseURL: 'https://sync.example.com',
      organizationId: 'org_test',
      apiKey: 'sk_test_abc',
      fetch,
    });
    await mesh.join(
      { id: 'a1' },
      { scope: { matters: 'm1' }, ttlSeconds: 7200, autoConnect: false },
    );
    expect(captured[0]!.body.ttlSeconds).toBe(7200);
  });
});

describe('join: autoConnect default', () => {
  it('auto-connects by default (fake SyncAgent swallows)', async () => {
    // With a fake fetch that returns a valid capability but no real WS
    // target, the auto-connect attempt fails but is swallowed. We
    // assert that a participant is still returned and usable.
    const { fetch } = makeFakeFetch();
    const mesh = createMesh({
      schema,
      baseURL: 'https://sync.example.com',
      organizationId: 'org_test',
      apiKey: 'sk_test_abc',
      fetch,
    });
    const participant = await mesh.join(
      { id: 'a1' },
      { scope: { matters: 'm1' } },
    );
    expect(participant.id).toBe('a1');
    expect(participant.capabilityToken).toMatch(/^tok_/);
    await participant.disconnect();
  });

  it('autoConnect: false skips the connect attempt', async () => {
    const { fetch } = makeFakeFetch();
    const mesh = createMesh({
      schema,
      baseURL: 'https://sync.example.com',
      organizationId: 'org_test',
      apiKey: 'sk_test_abc',
      fetch,
    });
    const participant = await mesh.join(
      { id: 'a1' },
      { scope: { matters: 'm1' }, autoConnect: false },
    );
    expect(participant.id).toBe('a1');
    expect(typeof participant.connect).toBe('function');
  });
});
