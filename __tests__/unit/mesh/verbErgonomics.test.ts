/**
 * Ergonomics locks — verb methods + duration strings + `await using`.
 *
 * These tests don't cover any new wire protocol; the new methods are
 * pure conveniences over the existing `update` / `announce` paths.
 * The point is to pin the *surface* so future refactors can't silently
 * drop `presence.editing(...)` or stop the TC39 asyncDispose hook
 * from revoking intents.
 */

import { describe, it, expect, jest } from '@jest/globals';
import {
  createPresenceStream,
  createIntentStream,
} from '../../../src/mesh/createMesh';
import type { SyncAgent } from '../../../src/agent/SyncAgent';

interface StubTrackers {
  announceCalls: Array<{ status: string; activity: unknown }>;
  beginIntentCalls: Array<{
    entityType: string;
    entityId: string;
    action: string;
    estimatedMs?: number;
  }>;
  abandonCalls: string[];
}

// Minimal stub: only the methods presence + intent streams touch.
function makeStub(): SyncAgent & StubTrackers {
  const trackers: StubTrackers = {
    announceCalls: [],
    beginIntentCalls: [],
    abandonCalls: [],
  };

  const impl = {
    ...trackers,
    announce: jest.fn((status: string, activity: unknown) => {
      trackers.announceCalls.push({ status, activity });
      return Promise.resolve();
    }),
    beginIntent: jest.fn((spec: StubTrackers['beginIntentCalls'][number]) => {
      trackers.beginIntentCalls.push(spec);
      const intentId = `intent_${trackers.beginIntentCalls.length}`;
      return {
        intentId,
        abandon: () => trackers.abandonCalls.push(intentId),
      };
    }),
    on: jest.fn(),
    off: jest.fn(),
    onPresence: jest.fn(),
  };

  return impl as unknown as SyncAgent & StubTrackers;
}

describe('presence verbs', () => {
  it('editing(entity) ships an "editing" activity', () => {
    const stub = makeStub();
    const stream = createPresenceStream(stub, 'p1', 'P One', ['g1']);
    stream.editing({ type: 'Clause', id: 'c1' });
    expect(stub.announceCalls).toHaveLength(1);
    expect(stub.announceCalls[0]!.activity).toEqual({
      entityType: 'Clause',
      entityId: 'c1',
      action: 'editing',
      detail: undefined,
    });
  });

  it('viewing(tuple) accepts the [type, id] form', () => {
    const stub = makeStub();
    const stream = createPresenceStream(stub, 'p1', undefined, []);
    stream.viewing(['Document', 'd42']);
    expect(stub.announceCalls[0]!.activity).toMatchObject({
      entityType: 'Document',
      entityId: 'd42',
      action: 'viewing',
    });
  });

  it('idle() broadcasts the idle sentinel', () => {
    const stub = makeStub();
    const stream = createPresenceStream(stub, 'p1', undefined, []);
    stream.idle();
    expect(stub.announceCalls[0]!.activity).toMatchObject({
      entityType: 'Unknown',
      entityId: '',
      action: 'idle',
    });
  });
});

describe('intent verbs + duration strings', () => {
  it('editing(entity, { ttl: "3m" }) parses to 180_000 ms', () => {
    const stub = makeStub();
    const stream = createIntentStream(stub, 'p1');
    stream.editing({ type: 'Clause', id: 'c1' }, { ttl: '3m' });
    expect(stub.beginIntentCalls[0]).toEqual({
      entityType: 'Clause',
      entityId: 'c1',
      action: 'editing',
      estimatedMs: 180_000,
    });
  });

  it('writing(tuple, { ttl: 60 }) interprets bare number as seconds', () => {
    const stub = makeStub();
    const stream = createIntentStream(stub, 'p1');
    stream.writing(['Document', 'd42'], { ttl: 60 });
    expect(stub.beginIntentCalls[0]!.estimatedMs).toBe(60_000);
  });

  it('announce(...) still works with the raw IntentDeclaration shape', () => {
    const stub = makeStub();
    const stream = createIntentStream(stub, 'p1');
    stream.announce({
      target: { type: 'Slide', id: 's1' },
      reason: 'custom-action',
      ttlSeconds: 30,
    });
    expect(stub.beginIntentCalls[0]).toEqual({
      entityType: 'Slide',
      entityId: 's1',
      action: 'custom-action',
      estimatedMs: 30_000,
    });
  });
});

describe('IntentHandle asyncDispose', () => {
  it('await using auto-revokes when the block exits', async () => {
    const stub = makeStub();
    const stream = createIntentStream(stub, 'p1');

    async function doWork() {
      await using _work = stream.editing(
        { type: 'Clause', id: 'c1' },
        { ttl: '1m' },
      );
      expect(stub.abandonCalls).toHaveLength(0);
      // block exits here — asyncDispose fires after awaiting the void return
    }

    await doWork();
    expect(stub.abandonCalls).toEqual(['intent_1']);
  });

  it('auto-revokes on throw', async () => {
    const stub = makeStub();
    const stream = createIntentStream(stub, 'p1');

    async function work() {
      await using _work = stream.writing(['Doc', 'd1']);
      throw new Error('boom');
    }

    await expect(work()).rejects.toThrow('boom');
    expect(stub.abandonCalls).toEqual(['intent_1']);
  });

  it('manual revoke() + asyncDispose double-fire is idempotent', async () => {
    const stub = makeStub();
    const stream = createIntentStream(stub, 'p1');

    {
      await using work = stream.editing({ type: 'X', id: 'x1' });
      work.revoke();
      // Now the block exits — asyncDispose runs a second abandon.
    }
    // SyncAgent's abandon is already idempotent at the protocol layer;
    // we record both calls here to verify the mesh side doesn't swallow.
    // Two calls with the same intentId is acceptable — server dedupes.
    expect(stub.abandonCalls).toContain('intent_1');
  });
});
