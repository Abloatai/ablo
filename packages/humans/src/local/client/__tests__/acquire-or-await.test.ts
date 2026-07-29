/**
 * `ablo.<model>.claim({ id })` — the serialize-on-contention
 * primitive bound to the agent write boundary.
 *
 * Three behaviours, exercised through a real `createModelProxy` with a
 * fake `ModelCollaboration`. Acquisition goes through the server's fair FIFO
 * queue (`createClaim({ queue: true })`), which blocks until the lease is
 * ours — so there's no client-side `waitFor` dance. The proxy's only job is
 * to decide whether to RE-READ afterwards (a row can only have changed under
 * us if another participant held it while we waited):
 *   - free target        → acquire, no re-read.
 *   - held by another    → acquire via the queue, then re-read (rehydrate).
 *   - held by self        → acquire, no re-read (re-acquire is mine).
 */

import { ModelRegistry } from '../../ModelRegistry.js';
import { InstanceCache } from '../../InstanceCache.js';
import { Model } from '../../Model.js';
import { ModelScope, LoadStrategy } from '@abloatai/transaction/types';
import {
  createModelProxy,
  type ModelCollaboration,
} from '../createModelProxy.js';
import type { SyncClient } from '../../SyncClient.js';
import type { OnDemandLoader } from '../../sync/OnDemandLoader.js';
import type { Claim, Snapshot } from '@abloatai/transaction/types/streams';
import { AbloClaimedError } from '@abloatai/transaction/errors';

interface TaskRow { id: string; title: string }

const TaskModel = class extends Model {
  override getModelName(): string {
    return 'Task';
  }
};

function makeProxy(collaboration: ModelCollaboration, seedId?: string) {
  const registry = new ModelRegistry({
    validateOnRegister: false,
    allowLateReferences: true,
  });
  registry.registerModel('Task', TaskModel, {
    loadStrategy: LoadStrategy.instant,
  });
  const pool = new InstanceCache({ maxSize: 100 }, registry);
  if (seedId) {
    pool.add(
      Object.assign(new TaskModel({ id: seedId }), { title: 'seed' }),
      ModelScope.live,
    );
  }
  const fetchSpy = jest.fn(async () => []);
  const hydration: Pick<OnDemandLoader, 'fetch'> = { fetch: fetchSpy };
  const proxy = createModelProxy<TaskRow, Omit<TaskRow, 'id'>>(
    'tasks',
    'Task',
    pool,
    {} as SyncClient,
    registry,
    hydration,
    collaboration,
  );
  return { proxy, fetchSpy };
}

function fakeCollaboration(
  overrides?: Partial<ModelCollaboration>,
): ModelCollaboration {
  const signal = new AbortController().signal;
  return {
    createClaim: jest.fn(async () => ({
      object: 'claim' as const,
      id: 'lease-1',
      description: 'editing',
      target: { type: 'tasks', id: 't1' },
      release: jest.fn(async () => undefined),
      revoke: jest.fn(),
      [Symbol.asyncDispose]: async () => undefined,
    })),
    // The one cast here that cannot be typed away: `Snapshot` intersects
    // `{ stamp: number }` with a string index signature over model rows, so
    // `stamp` conflicts with the index and NO object literal satisfies the
    // type. The proxy reads `snapshot.stamp` and nothing else.
    createSnapshot: () =>
      ({ stamp: 1, signal, onChange: () => () => undefined }) as unknown as Snapshot,
    state: jest.fn(() => null),
    holders: jest.fn(() => []),
    queue: jest.fn(() => []),
    reorder: jest.fn(),
    waitFor: jest.fn(async () => undefined),
    selfParticipantId: 'me',
    ...overrides,
  };
}

function queuedClaim(id: string, heldBy: string, position: number): Claim {
  return {
    object: 'claim',
    id,
    status: 'queued',
    position,
    target: { type: 'tasks', id: 't1' },
    description: 'editing',
    heldBy,
    participantKind: 'agent',
    expiresAt: Date.now() + 60_000,
  };
}

function activeClaim(heldBy: string): Claim {
  return {
    object: 'claim',
    id: 'i1',
    status: 'active',
    target: { type: 'tasks', id: 't1' },
    description: 'editing',
    heldBy,
    participantKind: 'agent',
    expiresAt: Date.now() + 60_000,
  };
}

describe('ModelOperations.claim', () => {
  it('acquires through the queue when the target is free (no rehydrate)', async () => {
    const collab = fakeCollaboration({ state: jest.fn(() => null) });
    const { proxy, fetchSpy } = makeProxy(collab, 't1');

    await proxy.claim({ id: 't1' });

    expect(collab.createClaim).toHaveBeenCalledTimes(1);
    // Always acquires via the server queue (blocks there if contended).
    expect(collab.createClaim).toHaveBeenCalledWith(
      expect.objectContaining({ queue: true }),
    );
    // Free target can't have changed under us → no re-read (seeded row).
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(collab.waitFor).not.toHaveBeenCalled();
  });

  it('acquires via the queue then rehydrates when held by another', async () => {
    const collab = fakeCollaboration({
      state: jest.fn(() => activeClaim('agent:other')),
    });
    const { proxy, fetchSpy } = makeProxy(collab, 't1');

    await proxy.claim({ id: 't1' });

    expect(collab.createClaim).toHaveBeenCalledWith(
      expect.objectContaining({ queue: true }),
    );
    // Contended → re-read after the grant; the prior holder may have committed.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // No client-side wait dance — the queue does the serializing.
    expect(collab.waitFor).not.toHaveBeenCalled();

    // Ordering: acquired before re-reading.
    const acquireOrder = (collab.createClaim as ReturnType<typeof jest.fn>).mock
      .invocationCallOrder[0];
    const rereadOrder = (fetchSpy as ReturnType<typeof jest.fn>).mock
      .invocationCallOrder[0];
    if (acquireOrder === undefined || rereadOrder === undefined) {
      throw new Error('expected both createClaim and fetch to have been invoked');
    }
    expect(acquireOrder).toBeLessThan(rereadOrder);
  });

  it('acquires without re-reading when already held by self', async () => {
    const collab = fakeCollaboration({
      state: jest.fn(() => activeClaim('me')),
    });
    const { proxy, fetchSpy } = makeProxy(collab, 't1');

    await proxy.claim({ id: 't1' });

    expect(collab.createClaim).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled(); // mine → unchanged
    expect(collab.waitFor).not.toHaveBeenCalled();
  });
});

describe('ModelOperations.reorder', () => {
  it('delegates to collaboration.reorder with the model-derived target + order', () => {
    const reorder = jest.fn();
    const collab = fakeCollaboration({ reorder });
    const { proxy } = makeProxy(collab, 't1');

    // Whole claims, because that is what a caller has: the doc on `reorder`
    // says the order is "taken from `queue(target)`", and what comes back from
    // there is the full record. Partials only typechecked behind a cast, which
    // is the same thing as not checking that this call is possible.
    const order: Claim[] = [
      queuedClaim('i-high', 'agent:high', 0),
      queuedClaim('i-low', 'agent:low', 1),
    ];

    proxy.claim.reorder({ id: 't1', order });

    expect(reorder).toHaveBeenCalledTimes(1);
    // Coordination targets speak the WIRE dialect (lowercased typename),
    // matching the commit plane — the schema key never reaches the lease
    // store (see the claims-journey dialect fix, 2026-06-10).
    expect(reorder).toHaveBeenCalledWith({ model: 'task', id: 't1' }, order);
  });
});

describe('ModelOperations.claim — the try-claim (queue: false)', () => {
  it('resolves null instead of throwing when held by another — an expected outcome', async () => {
    const held = activeClaim('agent:other');
    const collab = fakeCollaboration({
      state: jest.fn(() => ({
        ...held,
        description: 'pricing table, about two minutes',
        target: {
          ...held.target,
          meta: { description: 'pricing table, about two minutes' },
        },
      })),
      createClaim: jest.fn(() =>
        Promise.reject(
          new AbloClaimedError('held by the observed participant', {
            code: 'claim_conflict',
          }),
        ),
      ),
    });
    const { proxy } = makeProxy(collab, 't1');

    // The Web Locks `ifAvailable` convention: not acquiring is conditional
    // logic, not an error — dedup reads `if (!claim) return`, no try/catch.
    // Who holds it, and why, stays readable via `claim.state({ id })`.
    await expect(proxy.claim({ id: 't1', queue: false })).resolves.toBeNull();
    // Local presence is diagnostic only. Admission still goes to the server so
    // stale snapshots cannot manufacture a false decline.
    expect(collab.createClaim).toHaveBeenCalledWith(
      expect.objectContaining({ queue: false }),
    );
  });

  it('acquires without queuing when the target is free', async () => {
    const collab = fakeCollaboration({ state: jest.fn(() => null) });
    const { proxy } = makeProxy(collab, 't1');

    await proxy.claim({ id: 't1', queue: false });

    // Acquires, but NOT through the FIFO queue (queue: false).
    expect(collab.createClaim).toHaveBeenCalledWith(
      expect.objectContaining({ queue: false }),
    );
  });

  it('resolves null when the server sees a holder missing from local state', async () => {
    const collab = fakeCollaboration({
      state: jest.fn(() => null),
      createClaim: jest.fn(() =>
        Promise.reject(
          new AbloClaimedError('held on another instance', {
            code: 'claim_conflict',
          }),
        ),
      ),
    });
    const { proxy } = makeProxy(collab, 't1');

    await expect(proxy.claim({ id: 't1', queue: false })).resolves.toBeNull();
    expect(collab.createClaim).toHaveBeenCalledWith(
      expect.objectContaining({ queue: false }),
    );
  });
});

/**
 * `claim.list({ id })` — every holder of a row, not just one.
 *
 * A row claimed in parts has several holders at once, and `claim.state`
 * answers with one of them. A UI that draws a rail per claimed block reads
 * this instead; the two must never describe the same holding differently,
 * which is why both project through one function.
 */
describe('claim.list', () => {
  const holder = (id: string, field: string, actor: string): Claim =>
    ({
      object: 'claim',
      id,
      status: 'active',
      target: { type: 'tasks', id: 't1', field },
      description: `working on ${field}`,
      heldBy: actor,
      participantKind: 'agent',
      expiresAt: Date.now() + 60_000,
    });

  it('returns every holder of a row, where state returns one', () => {
    const holders = [
      holder('c-3', 'title', 'agent:a'),
      holder('c-7', 'body', 'agent:b'),
    ];
    const collab = fakeCollaboration({
      holders: jest.fn(() => holders),
      state: jest.fn(() => holders[0] ?? null),
    });
    const { proxy } = makeProxy(collab, 't1');

    const listed = proxy.claim.list({ id: 't1' });
    expect(listed.object).toBe('list');
    expect(listed.data).toHaveLength(2);
    expect(listed.data.map((c) => c.heldBy)).toEqual(['agent:a', 'agent:b']);

    // The narrower read still answers, with one of them — the two agree on
    // that holding rather than describing it differently.
    expect(proxy.claim.state({ id: 't1' })?.id).toBe('c-3');
  });

  it('carries meta through both projections — the peer\u2019s and its own', async () => {
    // The coordinator writes a beat's `details` into `meta.progress` on the
    // holder's record. It reached ModelClaim and stopped before the claim
    // state object, so the channel had a setter and no getter.
    //
    // Two projections, because a holder reading its own row does not go
    // through the peer one: `state` synthesizes the self-claim (the server
    // excludes a holder's own presence frames). A UI written against a peer's
    // meta would otherwise read nothing the moment the claim turned out to be
    // its own.
    const beating = {
      ...holder('c-3', 'title', 'agent:a'),
      meta: { progress: { phase: 'writing', done: 2, of: 5 } },
    };
    const peerCollab = fakeCollaboration({
      holders: jest.fn(() => [beating]),
      state: jest.fn(() => beating),
    });
    const peer = makeProxy(peerCollab, 't1').proxy;
    expect(peer.claim.state({ id: 't1' })?.meta).toEqual({
      progress: { phase: 'writing', done: 2, of: 5 },
    });
    expect(peer.claim.list({ id: 't1' }).data[0]?.meta).toEqual({
      progress: { phase: 'writing', done: 2, of: 5 },
    });

    // The self-claim path REBUILDS the object, so this is the half that can
    // silently drop a member.
    const ownCollab = fakeCollaboration({ state: jest.fn(() => null) });
    const own = makeProxy(ownCollab, 't1').proxy;
    await own.claim({ id: 't1', meta: { phase: 'reading' } });

    expect(own.claim.state({ id: 't1' })?.meta).toEqual({ phase: 'reading' });
    expect(own.claim.list({ id: 't1' }).data[0]?.meta).toEqual({ phase: 'reading' });
  });

  it('is an empty list when the row is free', () => {
    const collab = fakeCollaboration({
      holders: jest.fn(() => []),
      state: jest.fn(() => null),
    });
    const { proxy } = makeProxy(collab, 't1');

    expect(proxy.claim.list({ id: 't1' }).data).toEqual([]);
    expect(proxy.claim.state({ id: 't1' })).toBeNull();
  });
});
