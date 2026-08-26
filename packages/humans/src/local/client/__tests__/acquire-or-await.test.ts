/**
 * `ablo.<model>.claim({ id })` — the serialize-on-contention
 * primitive bound to the agent write boundary.
 *
 * Exercised through a real `createModelOperations` with a fake `ModelCollaboration`.
 * Acquisition goes through the server's fair FIFO queue
 * (`createClaim({ queue: true })`), which blocks until the lease is ours — so
 * there's no client-side `waitFor` dance.
 *
 * The snapshot is re-read on GRANT, never on contention (ADR 0035). Whoever
 * wins the lease re-reads, because that snapshot is the premise an expensive
 * step is about to be spent against.
 *
 * This used to be conditional: the proxy peeked at local presence and skipped
 * the re-read when nothing had held the row, reasoning that only a prior holder
 * could have moved it. That reasoning covers a writer who passed Ablo's
 * chokepoint, and every writer who did is either a holder or refused by the
 * default conflict policy. It does not cover the third writer: a row Ablo reads
 * through the WAL is written by the customer's own application, cron, or psql
 * session, which took no claim and raised no presence. For those rows "nobody
 * contended" was never evidence the row had not changed, and the claimant spent
 * a model call against a stale premise with nothing to warn it.
 */

import { ModelRegistry } from '../../ModelRegistry.js';
import { InstanceCache } from '../../InstanceCache.js';
import { Model } from '../../Model.js';
import { ModelScope, LoadStrategy } from '@abloatai/transaction/types';
import {
  createModelOperations,
  type ModelCollaboration,
} from '../createModelOperations.js';
import type { SyncClient } from '../../SyncClient.js';
import type { OnDemandLoader } from '../../sync/OnDemandLoader.js';
import type { Claim } from '@abloatai/transaction/types/streams';
import { AbloClaimedError } from '@abloatai/transaction/errors';

interface ItemRow { id: string; title: string }

const ItemModel = class extends Model {
  override getModelName(): string {
    return 'Item';
  }
};

function makeProxy(collaboration: ModelCollaboration, seedId?: string) {
  const registry = new ModelRegistry({
    validateOnRegister: false,
    allowLateReferences: true,
  });
  registry.registerModel('Item', ItemModel, {
    loadStrategy: LoadStrategy.instant,
  });
  const pool = new InstanceCache({ maxSize: 100 }, registry);
  if (seedId) {
    pool.add(
      Object.assign(new ItemModel({ id: seedId }), { title: 'seed' }),
      ModelScope.live,
    );
  }
  const fetchSpy = jest.fn(async () => []);
  const hydration: Pick<OnDemandLoader, 'fetch'> = { fetch: fetchSpy };
  const proxy = createModelOperations<ItemRow, Omit<ItemRow, 'id'>>(
    'items',
    'Item',
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
  return {
    createClaim: jest.fn(async () => ({
      object: 'claim' as const,
      id: 'lease-1',
      description: 'editing',
      target: { type: 'items', id: 't1' },
      release: jest.fn(async () => undefined),
      revoke: jest.fn(),
      [Symbol.asyncDispose]: async () => undefined,
    })),
    currentReadAt: () => 1,
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
    target: { type: 'items', id: 't1' },
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
    target: { type: 'items', id: 't1' },
    description: 'editing',
    heldBy,
    participantKind: 'agent',
    expiresAt: Date.now() + 60_000,
  };
}

describe('ModelOperations.claim', () => {
  it('re-reads after the grant even when the target was free', async () => {
    const collab = fakeCollaboration({ state: jest.fn(() => null) });
    const { proxy, fetchSpy } = makeProxy(collab, 't1');

    await proxy.claim({ id: 't1' });

    expect(collab.createClaim).toHaveBeenCalledTimes(1);
    // Always acquires via the server queue (blocks there if contended).
    expect(collab.createClaim).toHaveBeenCalledWith(
      expect.objectContaining({ queue: true }),
    );
    // A free target says no other CLAIMANT moved the row. It says nothing about
    // a write that landed straight in the customer's database, which took no
    // claim — so the seeded row can still be behind. Re-read rather than trust.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
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

  it('re-reads after the grant even when the row was already held by self', async () => {
    const collab = fakeCollaboration({
      state: jest.fn(() => activeClaim('me')),
    });
    const { proxy, fetchSpy } = makeProxy(collab, 't1');

    await proxy.claim({ id: 't1' });

    expect(collab.createClaim).toHaveBeenCalledTimes(1);
    // Holding the lease excludes other claimants; it does not stop a write
    // landing directly in the customer's database. A re-acquire is a fresh
    // premise for fresh work, so it reads.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(collab.waitFor).not.toHaveBeenCalled();
  });

  it('does not consult local presence to decide whether to re-read', async () => {
    const state = jest.fn(() => null);
    const collab = fakeCollaboration({ state });
    const { proxy } = makeProxy(collab, 't1');

    await proxy.claim({ id: 't1' });

    // The presence peek existed ONLY to gate the re-read, and its own comment
    // said so. With the read unconditional it has no caller left, and a
    // restored peek would be a restored gate — which is how this regresses.
    expect(state).not.toHaveBeenCalled();
  });

  it('keeps disjoint grants on one row distinct and releases by claim id', async () => {
    const releaseTitle = jest.fn(async () => undefined);
    const releaseStatus = jest.fn(async () => undefined);
    let next = 0;
    const createClaim = jest.fn(async () => {
      const title = next++ === 0;
      return {
        object: 'claim' as const,
        id: title ? 'lease-title' : 'lease-status',
        description: title ? 'editing title' : 'editing status',
        target: {
          type: 'items',
          id: 't1',
          field: title ? 'title' : 'status',
        },
        release: title ? releaseTitle : releaseStatus,
        revoke: jest.fn(),
        [Symbol.asyncDispose]: async () => undefined,
      };
    });
    const collab = fakeCollaboration({ createClaim });
    const { proxy } = makeProxy(collab, 't1');

    const title = await proxy.claim({
      id: 't1',
      field: 'title',
      description: 'editing title',
    });
    const status = await proxy.claim({
      id: 't1',
      field: 'status',
      description: 'editing status',
    });

    expect(proxy.claim.list({ id: 't1' }).data.map((claim) => claim.id)).toEqual([
      'lease-title',
      'lease-status',
    ]);

    await proxy.claim.release(title);
    expect(releaseTitle).toHaveBeenCalledTimes(1);
    expect(releaseStatus).not.toHaveBeenCalled();
    expect(proxy.claim.list({ id: 't1' }).data.map((claim) => claim.id)).toEqual([
      status.id,
    ]);

    await proxy.claim.release({ id: 't1' });
    expect(releaseStatus).toHaveBeenCalledTimes(1);
    expect(proxy.claim.list({ id: 't1' }).data).toEqual([]);
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
    expect(reorder).toHaveBeenCalledWith({ model: 'item', id: 't1' }, order);
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
 * which is why both workspace through one function.
 */
describe('claim.list', () => {
  const holder = (id: string, field: string, actor: string): Claim =>
    ({
      object: 'claim',
      id,
      status: 'active',
      target: { type: 'items', id: 't1', field },
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
