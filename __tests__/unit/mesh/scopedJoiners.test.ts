/**
 * `ablo.on.<model>.join(id, opts)` — model-scoped join shortcuts.
 *
 *   1. Single id, array of ids.
 *   2. Passes through `as`, `label`, `ttlSeconds`, `autoConnect`.
 *   3. Synthesizes an agent with a generated UUID when no `agent`
 *      or `label` is provided.
 *   4. Unknown model name at runtime returns undefined (and throws
 *      when you try to invoke `.join`).
 *   5. Repeated access returns the same joiner reference (useMemo-
 *      friendly).
 */

import { describe, it, expect } from '@jest/globals';
import { createMesh } from '../../../src/mesh';
import { defineSchema, mutable, z } from '../../../src/schema';

const schema = defineSchema({
  matters: mutable.lazy(
    { name: z.string() },
    { typename: 'Matter', tableName: 'matters', syncGroupFormat: 'matter:{id}' },
  ),
  documents: mutable.lazy(
    { title: z.string() },
    { typename: 'Document', tableName: 'documents', syncGroupFormat: 'doc:{id}' },
  ),
});

interface Captured {
  body: {
    allowedSyncGroups: string[];
    participantId: string;
    ttlSeconds: number;
    label?: string;
  };
  headers: Record<string, string>;
}

function mockResponse(body: unknown): Response {
  const json = JSON.stringify(body);
  return {
    ok: true,
    status: 201,
    headers: { get: () => null } as unknown as Headers,
    text: async () => json,
    json: async () => JSON.parse(json) as unknown,
  } as unknown as Response;
}

function makeMesh(captured: Captured[] = []) {
  const fakeFetch: typeof fetch = async (_url, init) => {
    const headers: Record<string, string> = {};
    if (init?.headers) Object.assign(headers, init.headers as Record<string, string>);
    captured.push({
      body: init?.body ? JSON.parse(init.body as string) : ({} as Captured['body']),
      headers,
    });
    return mockResponse({
      capabilityId: `cap_${captured.length}`,
      token: `tok_${captured.length}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      organizationId: 'org_test',
    });
  };
  return createMesh({
    schema,
    baseURL: 'https://sync.example.com',
    organizationId: 'org_test',
    apiKey: 'sk_test_abc',
    fetch: fakeFetch,
  });
}

describe('ablo.<model>.join — model-scoped shortcut at the top level', () => {
  it('desugars a single id into scope { matters: id }', async () => {
    const captured: Captured[] = [];
    const ablo = makeMesh(captured);
    await ablo.matters.join('m1', { label: 'DD Bot', autoConnect: false });
    expect(captured[0]!.body.allowedSyncGroups).toEqual(['matter:m1']);
    expect(captured[0]!.body.label).toBe('DD Bot');
  });

  it('accepts an array of ids', async () => {
    const captured: Captured[] = [];
    const ablo = makeMesh(captured);
    await ablo.documents.join(['d1', 'd2', 'd3'], {
      label: 'Reviewer',
      autoConnect: false,
    });
    expect(captured[0]!.body.allowedSyncGroups).toEqual([
      'doc:d1',
      'doc:d2',
      'doc:d3',
    ]);
  });

  it('auto-synthesizes an agent with a UUID id when none provided', async () => {
    const captured: Captured[] = [];
    const ablo = makeMesh(captured);
    await ablo.matters.join('m1', { autoConnect: false });
    // Participant id is `agent_<uuid>` — we don't care about the exact
    // UUID, just that it looks synthesized, not customer-supplied.
    expect(captured[0]!.body.participantId).toMatch(/^agent_[0-9a-f-]+$/i);
  });

  it('passes ttlSeconds and `as` through to the underlying join', async () => {
    const captured: Captured[] = [];
    const ablo = makeMesh(captured);
    await ablo.matters.join('m1', {
      label: 'DD Bot',
      ttlSeconds: '3h',
      as: { kind: 'agent', id: 'parent', capabilityToken: 'parent-cap' },
      autoConnect: false,
    });
    expect(captured[0]!.body.ttlSeconds).toBe(3 * 3600);
    expect(captured[0]!.headers.Authorization).toBe('Bearer parent-cap');
  });

  it('caches the joiner — same reference across repeated access', () => {
    const ablo = makeMesh();
    const a = ablo.matters;
    const b = ablo.matters;
    expect(a).toBe(b);
  });

  it('accepts `agent` pass-through for customers who hold their own agent object', async () => {
    const captured: Captured[] = [];
    const ablo = makeMesh(captured);
    const myAgent = { id: 'custom-id', label: 'My Agent', someField: 42 };
    await ablo.matters.join('m1', { agent: myAgent, autoConnect: false });
    expect(captured[0]!.body.participantId).toBe('custom-id');
  });

  it('returns undefined for unknown model names (JS-only safety net)', () => {
    const ablo = makeMesh();
    // TS would reject this; the runtime Proxy also guards it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const maybe = (ablo as any).nonexistent;
    expect(maybe).toBeUndefined();
  });

  it('admin fields still reachable alongside model joiners', async () => {
    const ablo = makeMesh();
    expect(typeof ablo.admin.capabilities.create).toBe('function');
    expect(typeof ablo.admin.roles.create).toBe('function');
    expect(typeof ablo.admin.members.create).toBe('function');
    expect(typeof ablo.admin.audit.list).toBe('function');
    expect(typeof ablo.join).toBe('function');
    expect(typeof ablo.describeJoin).toBe('function');
    expect(ablo.schema).toBe(schema);
  });

  it('schema models named `roles`/`members`/etc. do NOT collide with admin', async () => {
    // Admin resources live under `ablo.admin.*`, so common domain
    // names like `roles` at the top level of a customer schema are
    // fine. The client exposes both `ablo.roles.join(id)` (the model
    // joiner) and `ablo.admin.roles.create(...)` (the admin resource)
    // without conflict.
    const schemaWithRoles = defineSchema({
      roles: mutable.lazy(
        { name: z.string() },
        { typename: 'Role', tableName: 'roles', syncGroupFormat: 'role:{id}' },
      ),
    });
    const fakeFetch: typeof fetch = async () =>
      mockResponse({
        capabilityId: 'cap_1',
        token: 'tok_1',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        organizationId: 'org_test',
      });
    const ablo = createMesh({
      schema: schemaWithRoles,
      baseURL: 'https://x.example.com',
      organizationId: 'o',
      apiKey: 'k',
      fetch: fakeFetch,
    });
    // Both coexist.
    expect(typeof ablo.roles.join).toBe('function');
    expect(typeof ablo.admin.roles.create).toBe('function');
  });
});
