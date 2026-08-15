/**
 * ablo.sessions.create — the resource-oriented convenience over the
 * server's TWO mint doors: `{ user }` → `/v1/ephemeral_keys` (`ek_`),
 * `{ agent }` → `/v1/capabilities` (`rk_`). Exercises the real wrapper with an
 * injected fetch that records the outgoing request and returns the matching
 * door's response shape (the server boundary is stubbed via the SDK's own
 * `fetch` DI, not our code).
 *
 * The routing itself is the regression under test: the user arm used to be
 * funneled through `/v1/capabilities`, a door that categorically rejects
 * `participantKind: 'user'` — the 2026-06-11 Pulse cascade.
 */

import { Ablo, type InternalAbloOptions } from '../../../Ablo.js';
import { defineSchema } from '@abloatai/transaction/schema/schema';
import { model } from '@abloatai/transaction/schema/model';
import { z } from 'zod';

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const schema = defineSchema({
  chats: model({ title: z.string() }, { typename: 'Chat' }),
});

interface RecordedRequest {
  url: string;
  method: string;
  authorization: string | null;
  body: Record<string, unknown>;
}

function makeRecordingFetch(): { fetch: typeof fetch; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    await Promise.resolve();
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization'),
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    if (init?.method === 'DELETE') {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => Promise.resolve({
          id: 'cap_123',
          deleted: true,
          activeSessionsClosed: 1,
        }),
      } as Response;
    }
    if (url.endsWith('/rotate')) {
      return {
        ok: true,
        status: 201,
        headers: new Headers(),
        json: () => Promise.resolve({
          capabilityId: 'cap_456',
          token: 'rk_test_rotated',
          expiresAt: '2026-01-02T00:15:00.000Z',
          organizationId: 'org_1',
          scope: {
            organizationId: 'org_1',
            syncGroups: ['org:org_1'],
            operations: ['chat.read', 'chat.update'],
            participantKind: 'agent',
            participantId: 'agent_7',
          },
          rotatedFrom: {
            capabilityId: 'cap_123',
            expiresAt: '2026-01-01T01:00:00.000Z',
          },
        }),
      } as Response;
    }
    // Each door answers with ITS response shape — flat ephemeral_key for the
    // user mint, capability envelope for the agent mint.
    const payload = url.endsWith('/v1/ephemeral_keys')
      ? {
          object: 'ephemeral_key',
          id: 'ek_row_123',
          token: 'ek_test_minted',
          expiresAt: '2026-01-01T00:15:00.000Z',
          organizationId: 'org_1',
          participantId: 'user_42',
          syncGroups: ['org:org_1', 'user:user_42'],
          operations: ['chat.read', 'chat.create', 'chat.update', 'chat.delete'],
        }
      : {
          capabilityId: 'cap_123',
          token: 'rk_test_minted',
          expiresAt: '2026-01-01T00:15:00.000Z',
          organizationId: 'org_1',
          scope: {
            organizationId: 'org_1',
            syncGroups: ['collection:d1'],
            operations: ['entry.update'],
            participantKind: 'agent',
            participantId: 'agent_7',
          },
          userMeta: { id: 'agent_7' },
        };
    return {
      ok: true,
      status: 201,
      statusText: 'Created',
      json: () => Promise.resolve(payload),
    } as unknown as Response;
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function makeEngine(opts: { apiKey: string | null; fetch?: typeof fetch }) {
  return Ablo({
    schema,
    baseURL: 'ws://localhost:1234',
    bootstrapBaseUrl: 'http://localhost:1234/api',
    apiKey: opts.apiKey,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    // jsdom defines `window`; sessions.create is a backend call, so opt past the
    // browser guard for the test (it would never run client-side in real use).
    dangerouslyAllowBrowser: true,
    inMemory: true,
    logger: silentLogger,
  } as InternalAbloOptions<typeof schema.models>);
}

describe('ablo.sessions.create', () => {
  it('mints a scoped user session (ek_) via /v1/ephemeral_keys with the sk_ bearer', async () => {
    const { fetch: recordingFetch, calls } = makeRecordingFetch();
    const ablo = makeEngine({ apiKey: 'sk_test_backend', fetch: recordingFetch });

    const session = await ablo.sessions.create({
      user: { id: 'user_42' },
      can: { chats: ['read', 'create', 'update', 'delete'] },
      syncGroups: ['collection:d1'],
      ttlSeconds: 900,
      userMeta: { id: 'user_42', name: 'Ada' },
    });

    // Outgoing request: the USER door, authenticated by the ORIGINAL secret
    // key (control-plane rule — never an exchanged sync credential).
    expect(calls).toHaveLength(1);
    const mintCall = calls[0];
    if (!mintCall) throw new Error('expected an ephemeral-key mint request');
    expect(mintCall.url).toBe('http://localhost:1234/api/v1/ephemeral_keys');
    expect(mintCall.authorization).toBe('Bearer sk_test_backend');
    expect(mintCall.body).toMatchObject({
      user: { id: 'user_42' },
      syncGroups: ['collection:d1'],
      ttlSeconds: 900,
    });
    expect(mintCall.body.operations).toEqual([
      'chat.read',
      'chat.create',
      'chat.update',
      'chat.delete',
    ]);
    // And no participantKind field — the door itself encodes "user".
    expect(mintCall.body.participantKind).toBeUndefined();

    // Resource object reshaped from the flat ek_ response.
    expect(session).toMatchObject({
      object: 'session',
      id: 'ek_row_123',
      token: 'ek_test_minted',
      expiresAt: '2026-01-01T00:15:00.000Z',
      organizationId: 'org_1',
    });
    expect(session.scope).toEqual({
      organizationId: 'org_1',
      projectId: null,
      branchId: null,
      deliveryPartition: null,
      syncGroups: ['org:org_1', 'user:user_42'],
      operations: ['chat.read', 'chat.create', 'chat.update', 'chat.delete'],
      participantKind: 'user',
      participantId: 'user_42',
    });
    // userMeta echoes the caller's blob (the server has no view into it).
    expect(session.userMeta).toEqual({ id: 'user_42', name: 'Ada' });
  });

  it('mints a scoped agent session (rk_) — serializes `can` to the wire allowlist', async () => {
    const { fetch: recordingFetch, calls } = makeRecordingFetch();
    const ablo = makeEngine({ apiKey: 'sk_test_backend', fetch: recordingFetch });

    await ablo.sessions.create({
      agent: { id: 'agent_7' },
      // Typed off the schema's model names; serialized to `${typename}.${op}`.
      can: { chats: ['read', 'update'] },
    });

    const mintCall = calls[0];
    if (!mintCall) throw new Error('expected a capability mint request');
    expect(mintCall.url).toBe('http://localhost:1234/api/v1/capabilities');
    expect(mintCall.body).toMatchObject({
      participantKind: 'agent',
      participantId: 'agent_7',
      // The schema key the developer wrote (`chats`) is translated to the
      // lowercased wire TYPENAME (`typename: 'Chat'` → `chat.*`) — the
      // canonical alias the Hub gates on (see sessionMint's `modelTypenames`;
      // the server also honors schemaKey/tableName aliases via
      // capabilityScope.aliasesAllow, but the mint emits the typename form).
      operations: ['chat.read', 'chat.update'],
    });
  });

  it('uses the schema typename when the same session is minted over HTTP', async () => {
    const { fetch: recordingFetch, calls } = makeRecordingFetch();
    const ablo = Ablo({
      schema,
      baseURL: 'http://localhost:1234',
      apiKey: 'sk_test_backend',
      fetch: recordingFetch,
      dangerouslyAllowBrowser: true,
      transport: 'http',
    });

    await ablo.sessions.create({
      agent: { id: 'agent_7' },
      // The schema key intentionally differs from the server-facing typename.
      can: { chats: ['update'] },
    });

    const mintCall = calls[0];
    if (!mintCall) throw new Error('expected a capability mint request');
    expect(mintCall.url).toBe('http://localhost:1234/api/v1/capabilities');
    expect(mintCall.body).toMatchObject({
      // Read-your-writes is derived at the serializer, not left for the mint
      // route: a grant that can write a model can always read it back.
      operations: ['chat.update', 'chat.read'],
      participantKind: 'agent',
      participantId: 'agent_7',
    });
  });

  it('defaults ttl to 900s (15m) when omitted', async () => {
    const { fetch: recordingFetch, calls } = makeRecordingFetch();
    const ablo = makeEngine({ apiKey: 'sk_test_backend', fetch: recordingFetch });
    await ablo.sessions.create({
      user: { id: 'u' },
      can: { chats: ['read'] },
    });
    expect(calls[0]?.body.ttlSeconds).toBe(900);
  });

  it('refuses to mint without a secret key (never from the browser)', async () => {
    const ablo = makeEngine({ apiKey: null });
    await expect(
      ablo.sessions.create({
        user: { id: 'u' },
        can: { chats: ['read'] },
      }),
    ).rejects.toMatchObject({ code: 'apikey_missing' });
  });

  it('revokes a user or agent session by its returned resource id', async () => {
    const { fetch: recordingFetch, calls } = makeRecordingFetch();
    const ablo = makeEngine({
      apiKey: 'sk_test_backend',
      fetch: recordingFetch,
    });

    await expect(
      ablo.sessions.revoke({ id: 'cap_123' }),
    ).resolves.toMatchObject({
      id: 'cap_123',
      deleted: true,
      activeSessionsClosed: 1,
    });
    expect(calls[0]).toMatchObject({
      method: 'DELETE',
      url: 'http://localhost:1234/api/v1/capabilities/cap_123',
      authorization: 'Bearer sk_test_backend',
    });
  });

  it('rotates an agent session with an explicit overlap window', async () => {
    const { fetch: recordingFetch, calls } = makeRecordingFetch();
    const ablo = makeEngine({
      apiKey: 'sk_test_backend',
      fetch: recordingFetch,
    });

    await expect(
      ablo.sessions.rotate({
        id: 'cap_123',
        graceSeconds: 60,
        ttlSeconds: 900,
      }),
    ).resolves.toMatchObject({
      id: 'cap_456',
      token: 'rk_test_rotated',
      rotatedFrom: { id: 'cap_123' },
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'http://localhost:1234/api/v1/capabilities/cap_123/rotate',
      authorization: 'Bearer sk_test_backend',
      body: { graceSeconds: 60, ttlSeconds: 900 },
    });
  });
});
