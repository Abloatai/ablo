/**
 * Stripe-shaped browser flow — `new Ablo({ schema, capabilityToken })`.
 *
 * Asserts:
 *   1. Constructing with `capabilityToken` skips the mint POST on
 *      `join(...)` — zero server round-trips.
 *   2. `participant.refresh()` throws with an actionable message when
 *      no `onTokenRefresh` callback is provided.
 *   3. `onTokenRefresh` is called and its return value becomes the
 *      participant's next token.
 *   4. Sub-agent spawn via `participant.join(...)` still hits the
 *      mint endpoint (attenuation is server-mediated).
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
});

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

describe('capabilityToken — Stripe-shaped browser flow', () => {
  it('join() skips the mint POST when capabilityToken is pre-set', async () => {
    const fetchSpy = jest.fn<typeof fetch>();
    const ablo = createMesh({
      schema,
      baseURL: 'https://sync.example.com',
      capabilityToken: 'pre-minted-biscuit',
      fetch: fetchSpy as unknown as typeof fetch,
    });

    const participant = await ablo.matters.join('m1', {
      label: 'DD Bot',
      autoConnect: false,
    });

    // Zero fetches — the browser path never hits the capability endpoint.
    expect(fetchSpy).not.toHaveBeenCalled();
    // Participant holds the supplied token verbatim.
    expect(participant.capabilityToken).toBe('pre-minted-biscuit');
  });

  it('refresh() throws when no onTokenRefresh callback is provided', async () => {
    const ablo = createMesh({
      schema,
      baseURL: 'https://sync.example.com',
      capabilityToken: 'pre-minted-biscuit',
      fetch: async () => mockResponse({}),
    });
    const participant = await ablo.matters.join('m1', {
      label: 'test',
      autoConnect: false,
    });
    await expect(participant.refresh()).rejects.toThrow(
      /constructed with a pre-minted/,
    );
  });

  it('refresh() uses onTokenRefresh to fetch a new token', async () => {
    let callCount = 0;
    const onTokenRefresh = jest.fn(async () => {
      callCount += 1;
      return `rotated-biscuit-${callCount}`;
    });

    const ablo = createMesh({
      schema,
      baseURL: 'https://sync.example.com',
      capabilityToken: 'initial-biscuit',
      onTokenRefresh,
      fetch: async () => mockResponse({}),
    });

    const participant = await ablo.matters.join('m1', {
      label: 'test',
      autoConnect: false,
    });

    expect(participant.capabilityToken).toBe('initial-biscuit');

    await participant.refresh();

    expect(onTokenRefresh).toHaveBeenCalledTimes(1);
    expect(participant.capabilityToken).toBe('rotated-biscuit-1');
  });

  it('sub-agent spawn still goes through the mint endpoint', async () => {
    // When a child is spawned via `participant.join(...)`, the SDK
    // attenuates from the parent's token — that requires a server
    // round-trip even in the browser flow. Confirm the fetch hits
    // `/api/auth/capability`.
    const urls: string[] = [];
    const fakeFetch: typeof fetch = async (url) => {
      const s = typeof url === 'string' ? url : String(url);
      urls.push(s);
      return mockResponse({
        capabilityId: 'cap_child_1',
        token: 'child-token',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        organizationId: 'org_test',
      });
    };
    const ablo = createMesh({
      schema,
      baseURL: 'https://sync.example.com',
      capabilityToken: 'parent-biscuit',
      fetch: fakeFetch,
    });
    const parent = await ablo.matters.join('m1', {
      label: 'parent',
      autoConnect: false,
    });
    await parent.join(
      { label: 'child' },
      { scope: { matters: 'm1' }, autoConnect: false },
    );
    expect(urls.some((u) => u.includes('/api/auth/capability'))).toBe(true);
  });
});
