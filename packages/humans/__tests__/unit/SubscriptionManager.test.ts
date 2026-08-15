/**
 * SubscriptionManager — hysteresis + prominence policy over the
 * `update_subscription` read primitive.
 *
 * The contract under test:
 *   - `enter` subscribes (base ∪ active).
 *   - `leave` does NOT unsubscribe immediately — the group stays WARM and
 *     in the effective set; only a sweep past the TTL drops it. This is the
 *     boundary hysteresis that suppresses re-bootstrap churn.
 *   - Re-entering a warm group before it expires costs ZERO round-trips.
 *   - `pin` (claim prominence) keeps a group across `leave` and never lets
 *     it expire while pinned.
 *   - Base groups are always present and never warm/expire.
 */

import { SubscriptionManager } from '../../src/local/sync/SubscriptionManager';
import type { SubscriptionTransport } from '../../src/local/sync/SubscriptionManager';

/** Records every update_subscription call (sorted for stable assertions). */
class FakeTransport implements SubscriptionTransport {
  readonly calls: string[][] = [];
  /** When true, simulate an offline socket — reject like `notConnectedError`. */
  offline = false;
  updateSubscription(
    syncGroups: readonly string[],
  ): Promise<{ syncGroups: string[] }> {
    if (this.offline) return Promise.reject(new Error('not connected'));
    this.calls.push([...syncGroups].sort());
    return Promise.resolve({ syncGroups: [...syncGroups] });
  }
}

/** No-op scheduler so the manager never arms a real timer; tests drive sweep(). */
const noScheduler = (): (() => void) => () => {/* no-op disposer: tests drive sweep() manually */};

function makeManager(transport: FakeTransport, clock: { t: number }) {
  return new SubscriptionManager({
    transport,
    baseGroups: ['org:1'],
    warmTtlMs: 1_000,
    sweepIntervalMs: 0, // disable auto-sweep; drive manually
    now: () => clock.t,
    scheduler: noScheduler,
  });
}

describe('SubscriptionManager', () => {
  it('enter subscribes to base ∪ active', async () => {
    const transport = new FakeTransport();
    const clock = { t: 1_000 };
    const m = makeManager(transport, clock);

    await m.enter('collection:a');

    expect(transport.calls).toEqual([['collection:a', 'org:1']]);
    expect(m.effectiveGroups().sort()).toEqual(['collection:a', 'org:1']);
  });

  it('leave keeps the group warm — no unsubscribe round-trip', async () => {
    const transport = new FakeTransport();
    const clock = { t: 1_000 };
    const m = makeManager(transport, clock);

    await m.enter('collection:a'); // call #1
    await m.leave('collection:a'); // still in effective set (warm) → no new call

    expect(transport.calls).toHaveLength(1);
    expect(m.effectiveGroups().sort()).toEqual(['collection:a', 'org:1']);
  });

  it('sweep past the TTL drops the warm group', async () => {
    const transport = new FakeTransport();
    const clock = { t: 1_000 };
    const m = makeManager(transport, clock);

    await m.enter('collection:a'); // call #1
    await m.leave('collection:a'); // warm until t=2_000

    clock.t = 2_001; // past the warm TTL
    await m.sweep(); // call #2 — drops collection:a

    expect(transport.calls).toEqual([
      ['collection:a', 'org:1'],
      ['org:1'],
    ]);
    expect(m.effectiveGroups()).toEqual(['org:1']);
  });

  it('re-entering a warm group before expiry costs zero round-trips', async () => {
    const transport = new FakeTransport();
    const clock = { t: 1_000 };
    const m = makeManager(transport, clock);

    await m.enter('collection:a'); // call #1
    await m.leave('collection:a'); // warm
    clock.t = 1_500; // still inside the window
    await m.enter('collection:a'); // back in view — effective set unchanged

    expect(transport.calls).toHaveLength(1);

    // And a later sweep does NOT drop it — it's active again, not warm.
    clock.t = 3_000;
    await m.sweep();
    expect(transport.calls).toHaveLength(1);
    expect(m.effectiveGroups().sort()).toEqual(['collection:a', 'org:1']);
  });

  it('pin keeps a group across leave and never expires while pinned', async () => {
    const transport = new FakeTransport();
    const clock = { t: 1_000 };
    const m = makeManager(transport, clock);

    await m.enter('collection:a'); // call #1
    await m.pin('collection:a'); // prominence (active claim) — no change to set
    await m.leave('collection:a'); // pinned → not warmed, stays subscribed

    clock.t = 1_000_000; // far past any TTL
    await m.sweep(); // pinned group survives

    expect(transport.calls).toHaveLength(1);
    expect(m.effectiveGroups().sort()).toEqual(['collection:a', 'org:1']);
  });

  it('unpinning an out-of-view group warms it, then sweep drops it', async () => {
    const transport = new FakeTransport();
    const clock = { t: 1_000 };
    const m = makeManager(transport, clock);

    await m.enter('collection:a');
    await m.pin('collection:a');
    await m.leave('collection:a'); // still present via pin
    expect(transport.calls).toHaveLength(1);

    await m.unpin('collection:a'); // not active → goes warm (hysteresis), no call yet
    expect(transport.calls).toHaveLength(1);

    clock.t = 2_001; // past warm TTL from unpin
    await m.sweep(); // drops it now
    expect(transport.calls).toEqual([
      ['collection:a', 'org:1'],
      ['org:1'],
    ]);
  });

  it('soft-fails when the transport is offline — enter never rejects', async () => {
    const transport = new FakeTransport();
    const clock = { t: 1_000 };
    const m = makeManager(transport, clock);

    transport.offline = true;
    // Must resolve, not reject — interest is soft state.
    await expect(m.enter('collection:a')).resolves.toBeUndefined();
    expect(transport.calls).toHaveLength(0); // nothing landed
    expect(m.effectiveGroups()).toEqual([]); // lastSent unchanged
  });

  it('resync re-pushes the current desired set after reconnect (interest changed while offline)', async () => {
    const transport = new FakeTransport();
    const clock = { t: 1_000 };
    const m = makeManager(transport, clock);

    await m.enter('collection:a'); // online → call #1 = [collection:a, org:1]
    expect(transport.calls).toHaveLength(1);

    // Go offline, then navigate collection:a → collection:b while disconnected.
    transport.offline = true;
    await m.leave('collection:a');
    await m.enter('collection:b');
    expect(transport.calls).toHaveLength(1); // nothing sent while offline

    // Reconnect: the new socket's URL carried the stale set; resync()
    // re-pushes the now-current desired set so collection:b actually subscribes.
    transport.offline = false;
    await m.resync();

    expect(transport.calls).toHaveLength(2);
    // collection:a is warm (left at t=1_000, TTL 1_000 → still < 2_000), so the
    // re-push includes base + the still-warm collection:a + the active collection:b.
    expect(transport.calls[1]).toEqual(['collection:a', 'collection:b', 'org:1']);

    // After the warm TTL lapses, a sweep drops collection:a, leaving collection:b.
    clock.t = 2_001;
    await m.sweep();
    expect(transport.calls[2]).toEqual(['collection:b', 'org:1']);
  });

  it('evicts the least-recently-warmed group immediately when maxWarm is exceeded', async () => {
    const transport = new FakeTransport();
    const clock = { t: 1_000 };
    const m = new SubscriptionManager({
      transport,
      baseGroups: ['org:1'],
      warmTtlMs: 1_000,
      maxWarm: 2, // cap warm set at 2
      sweepIntervalMs: 0,
      now: () => clock.t,
      scheduler: () => () => {/* no-op disposer */},
    });

    await m.enter('collection:a');
    await m.enter('collection:b');
    await m.enter('collection:c');

    await m.leave('collection:a'); // warm {a}
    await m.leave('collection:b'); // warm {a,b}
    await m.leave('collection:c'); // warm {a,b,c} → over cap → evict a

    // collection:a was dropped immediately (not waiting for its TTL); b and c stay.
    expect(m.effectiveGroups().sort()).toEqual(['collection:b', 'collection:c', 'org:1']);
  });

  it('refreshes LRU recency on re-warm — a touched group survives eviction', async () => {
    const transport = new FakeTransport();
    const clock = { t: 1_000 };
    const m = new SubscriptionManager({
      transport,
      baseGroups: ['org:1'],
      warmTtlMs: 10_000,
      maxWarm: 2,
      sweepIntervalMs: 0,
      now: () => clock.t,
      scheduler: () => () => {/* no-op disposer */},
    });

    await m.enter('collection:a');
    await m.enter('collection:b');
    await m.leave('collection:a'); // warm {a}
    await m.leave('collection:b'); // warm {a,b}

    // Touch a: re-enter then re-leave → a becomes most-recently-warmed.
    await m.enter('collection:a'); // warm {b}, a active
    await m.leave('collection:a'); // warm {b,a}  (a now newest)

    await m.enter('collection:c');
    await m.leave('collection:c'); // warm {b,a,c} → evict oldest = b (a was refreshed)

    const groups = m.effectiveGroups().sort();
    expect(groups).toContain('collection:a'); // survived — refreshed
    expect(groups).toContain('collection:c');
    expect(groups).not.toContain('collection:b'); // evicted — least recent
  });

  it('base groups are always present and survive every sweep', async () => {
    const transport = new FakeTransport();
    const clock = { t: 1_000 };
    const m = makeManager(transport, clock);

    await m.enter('collection:a');
    await m.leave('collection:a');
    clock.t = 10_000;
    await m.sweep();

    expect(m.effectiveGroups()).toEqual(['org:1']);
  });
});
