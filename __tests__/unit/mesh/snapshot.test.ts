/**
 * `participant.snapshot({ model: [ids] })` — flat snapshot ergonomics.
 *
 * Replaces the `participant.context.capture(...)` soup with:
 *   - `snap.<model>[id]` — direct entity access
 *   - `snap.stamp` — opaque watermark for writes
 *   - `snap.signal` — AbortSignal, fires on any captured-entity delta
 *   - `snap.onChange(fn)` — callback form for non-abort consumers
 *
 * Reserved keys (`stamp` / `signal` / `onChange`) clash with models
 * named the same — the SDK throws a clear error at snapshot time.
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { SyncAgent } from '../../../src/agent/SyncAgent';

// Pull in the exported createSnapshot path via a thin proxy participant.
// Rather than going through the full createMesh → doJoin → fetch path,
// we synthesize a participant that only uses the snapshot implementation.
interface StubAgent {
  currentSyncId: number;
  queryCalls: Array<{ type: string; opts?: unknown }>;
  onHandlers: Array<{ type: string; handler: Function }>;
}

function makeStubAgent(entities: Record<string, Record<string, unknown>>): SyncAgent & StubAgent {
  const queryCalls: StubAgent['queryCalls'] = [];
  const onHandlers: StubAgent['onHandlers'] = [];
  const stub = {
    currentSyncId: 487,
    queryCalls,
    onHandlers,
    query: jest.fn((type: string, opts?: { where?: { id?: string } }) => {
      queryCalls.push({ type, opts });
      if (opts?.where?.id) {
        const bucket = entities[type];
        const match = bucket?.[opts.where.id];
        return match ? [match] : [];
      }
      return Object.values(entities[type] ?? {});
    }),
    on: jest.fn((type: string, handler: Function) => {
      onHandlers.push({ type, handler });
      return stub;
    }),
  };
  return stub as unknown as SyncAgent & StubAgent;
}

// Import the internal helper directly. The public path is
// `participant.snapshot(...)` but we test the unit in isolation.
import { createMesh } from '../../../src/mesh';
import { defineSchema, mutable, z } from '../../../src/schema';

const testSchema = defineSchema({
  clauses: mutable.lazy(
    { text: z.string() },
    { typename: 'Clause', tableName: 'clauses', syncGroupFormat: 'clause:{id}' },
  ),
});

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

describe('participant.snapshot', () => {
  it('returns flat per-model buckets + stamp + signal + onChange', async () => {
    const ablo = createMesh({
      schema: testSchema,
      baseURL: 'https://x.example.com',
      organizationId: 'o',
      apiKey: 'k',
      fetch: async () =>
        mockResponse({
          capabilityId: 'cap_1',
          token: 'tok_1',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          organizationId: 'o',
        }),
    });
    const participant = await ablo.clauses.join('c1', {
      label: 'smoke',
      autoConnect: false,
    });

    const snap = await participant.snapshot({ clauses: ['c1'] });

    expect(typeof snap.stamp).toBe('string');
    expect(snap.signal).toBeInstanceOf(AbortSignal);
    expect(typeof snap.onChange).toBe('function');
    // Per-model bucket is flat on the snapshot object.
    expect(snap.clauses).toBeDefined();
    expect(typeof snap.clauses).toBe('object');
  });

  it('reserved keys collide → throws clear error', async () => {
    // Need to construct a collision — defineSchema types would reject
    // a model named `stamp`, so drop to any at the boundary.
    const ablo = createMesh({
      schema: testSchema,
      baseURL: 'https://x.example.com',
      organizationId: 'o',
      apiKey: 'k',
      fetch: async () =>
        mockResponse({
          capabilityId: 'cap_1',
          token: 'tok_1',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          organizationId: 'o',
        }),
    });
    const participant = await ablo.clauses.join('c1', {
      label: 'smoke',
      autoConnect: false,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(
      participant.snapshot({ stamp: ['x1'] } as any),
    ).rejects.toThrow(/collides with a reserved snapshot field/);
  });
});
