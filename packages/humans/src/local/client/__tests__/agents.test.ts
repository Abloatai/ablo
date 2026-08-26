/**
 * ablo.agents.create — the in-process "mint + connected client" convenience.
 *
 * The axis is token-vs-client, NOT human-vs-agent: `sessions.create` stays the
 * token-handoff primitive ({ user } → ek_, { agent } → rk_) you ship to a
 * browser or a separate worker; `agents.create` mints a scoped rk_ AND binds a
 * live client to it in the process that holds the sk_ (the serverless /
 * orchestrator case). It reuses the SAME mint door as `sessions.create`
 * ({ agent } → /v1/capabilities) via the shared `buildMintContext`, so the two
 * can never drift on how a token is minted or how `can` serializes.
 *
 * NOTE: this suite shares the package's vitest harness, which currently cannot
 * load on a tree mid-`sync/participants` refactor (BaseSyncedStore imports a
 * module that refactor has moved). Assertions below are written against the
 * live `sessionMint.ts` source (`ns = typename ?? key`, then `.toLowerCase()`),
 * so they are correct-by-construction once the suite loads again.
 */

import { Ablo, type Ablo as AbloClient, type InternalAbloOptions } from '../../../Ablo.js';
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
  // No typename override: the `can` key already IS the wire token → `records.*`.
  records: model({ title: z.string() }, {}),
  // Typename override: `can` is keyed by the schema key (`entryDetail`) but the
  // capability must be scoped by the lowercased TYPENAME (`entrydetail`), else
  // the Hub denies it (`capability_scope_denied`). Proves the mapping carries
  // through `agents.create`, not just `sessions.create`.
  entryDetail: model({ text: z.string() }, { typename: 'EntryDetail' }),
});

interface RecordedRequest {
  url: string;
  authorization: string | null;
  body: Record<string, unknown>;
}

function makeRecordingFetch(): { fetch: typeof fetch; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      authorization: headers.get('authorization'),
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    // agents.create only ever hits the agent door — the capability envelope.
    const payload = {
      capabilityId: 'cap_abc',
      token: 'rk_test_minted',
      expiresAt: '2026-01-01T00:15:00.000Z',
      organizationId: 'org_1',
      scope: {
        organizationId: 'org_1',
        syncGroups: ['org:org_1'],
        operations: (init?.body
          ? (JSON.parse(String(init.body)).operations as string[])
          : []) ?? [],
        participantKind: 'agent',
        participantId: 'draft-7',
      },
      userMeta: { id: 'draft-7' },
    };
    return {
      ok: true,
      status: 201,
      statusText: 'Created',
      json: async () => payload,
    } as unknown as Response;
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function makeEngine(opts: { apiKey: string | null; fetch?: typeof fetch }): AbloClient<typeof schema.models> {
  return Ablo({
    schema,
    baseURL: 'ws://localhost:1234',
    bootstrapBaseUrl: 'http://localhost:1234/api',
    apiKey: opts.apiKey,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    dangerouslyAllowBrowser: true,
    inMemory: true,
    logger: silentLogger,
  } as InternalAbloOptions<typeof schema.models>);
}

describe('ablo.agents.create', () => {
  it('mints a scoped rk_ via /v1/capabilities with the sk_ bearer and the agent id as participant', async () => {
    const { fetch: recordingFetch, calls } = makeRecordingFetch();
    const ablo = makeEngine({ apiKey: 'sk_test_backend', fetch: recordingFetch });

    const agent = await ablo.agents.create({
      id: 'draft-7',
      onBehalfOf: { user: { id: 'user-42' } },
      can: { records: ['read', 'update'] },
    });

    // Exactly ONE mint up front (fail-fast on a bad key); the child client is
    // lazy and does not connect or re-mint during create().
    expect(calls).toHaveLength(1);
    const mintCall = calls[0];
    if (!mintCall) throw new Error('expected a capability mint request');
    expect(mintCall.url).toBe('http://localhost:1234/api/v1/capabilities');
    expect(mintCall.authorization).toBe('Bearer sk_test_backend');
    expect(mintCall.body).toMatchObject({
      participantKind: 'agent',
      participantId: 'draft-7',
      onBehalfOf: { user: { id: 'user-42' } },
      // No typename override on `records` → key === wire token.
      operations: ['records.read', 'records.update'],
    });

    await agent.dispose();
  });

  it('returns a CONNECTED client (the ablo.<model>.<verb> surface), not a raw token', async () => {
    const { fetch: recordingFetch } = makeRecordingFetch();
    const ablo = makeEngine({ apiKey: 'sk_test_backend', fetch: recordingFetch });

    const agent = await ablo.agents.create({ id: 'draft-7', can: { records: ['update'] } });

    // It's a full client, not an AbloSession: the model surface + lifecycle are present.
    expect(typeof agent.records.update).toBe('function');
    expect(typeof agent.records.claim).toBe('function');
    expect(typeof agent.dispose).toBe('function');
    // A distinct engine from the parent (its own rk_ / connection).
    expect(agent).not.toBe(ablo);

    await agent.dispose();
  });

  it('auto-generates a distinct uuid when `id` is omitted — same name, independent participants', async () => {
    const { fetch: recordingFetch, calls } = makeRecordingFetch();
    const ablo = makeEngine({ apiKey: 'sk_test_backend', fetch: recordingFetch });

    const a = await ablo.agents.create({ name: 'drafter', can: { records: ['update'] } });
    const b = await ablo.agents.create({ name: 'drafter', can: { records: ['update'] } });

    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const mintA = calls[0];
    const mintB = calls[1];
    if (!mintA || !mintB) throw new Error('expected two capability mint requests');
    const idA = mintA.body.participantId as string;
    const idB = mintB.body.participantId as string;
    // Shared name, but two DISTINCT uuid participants → they queue, never collapse.
    expect(idA).toMatch(UUID);
    expect(idB).toMatch(UUID);
    expect(idA).not.toBe(idB);
    expect(idA).not.toBe('drafter');

    await a.dispose();
    await b.dispose();
  });

  it('carries `name` as userMeta.name, independent of the participant id', async () => {
    const { fetch: recordingFetch, calls } = makeRecordingFetch();
    const ablo = makeEngine({ apiKey: 'sk_test_backend', fetch: recordingFetch });

    const agent = await ablo.agents.create({ name: 'researcher', can: { records: ['read'] } });

    const mintCall = calls[0];
    if (!mintCall) throw new Error('expected a capability mint request');
    expect(mintCall.body.userMeta).toMatchObject({ name: 'researcher' });
    // `name` is a label, NOT the identity — the wire id is a uuid, not 'researcher'.
    expect(mintCall.body.participantId).not.toBe('researcher');

    await agent.dispose();
  });

  it('translates a `can` key to the lowercased typename the Hub gates on', async () => {
    const { fetch: recordingFetch, calls } = makeRecordingFetch();
    const ablo = makeEngine({ apiKey: 'sk_test_backend', fetch: recordingFetch });

    const agent = await ablo.agents.create({
      name: 'layer-bot',
      can: { entryDetail: ['update'] },
    });

    // `entryDetail` (schema key) → typename `EntryDetail` → wire token `entrydetail`,
    // plus the read the write implies.
    expect(calls[0]?.body).toMatchObject({
      operations: ['entrydetail.update', 'entrydetail.read'],
    });

    await agent.dispose();
  });

  it('refuses to mint without a secret key (never from the browser)', async () => {
    const ablo = makeEngine({ apiKey: null });
    await expect(
      ablo.agents.create({ id: 'draft-7', can: { records: ['update'] } }),
    ).rejects.toMatchObject({ code: 'apikey_missing' });
  });
});
