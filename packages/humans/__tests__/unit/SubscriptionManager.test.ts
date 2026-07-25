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

    await m.enter('deck:a');

    expect(transport.calls).toEqual([['deck:a', 'org:1']]);
    expect(m.effectiveGroups().sort()).toEqual(['deck:a', 'org:1']);
  });

  it('leave keeps the group warm — no unsubscribe round-trip', async () => {
    const transport = new FakeTransport();
    const clock = { t: 1_000 };
    const m = makeManager(transport, clock);

    await m.enter('deck:a'); // call #1
    await m.leave('deck:a'); // still in effective set (warm) → no new call

    expect(transport.calls).toHaveLength(1);
    expect(m.effectiveGroups().sort()).toEqual(['deck:a', 'org:1']);
  });

  it('sweep past the TTL drops the warm group', async () => {
    const transport = new FakeTransport();
    const clock = { t: 1_000 };
    const m = makeManager(transport, clock);

    await m.enter('deck:a'); // call #1
    await m.leave('deck:a'); // warm until t=2_000

    clock.t = 2_001; // past the warm TTL
    await m.sweep(); // call #2 — drops deck:a

    expect(transport.calls).toEqual([
      ['deck:a', 'org:1'],
      ['org:1'],
    ]);
    expect(m.effectiveGroups()).toEqual(['org:1']);
  });

  it('re-entering a warm group before expiry costs zero round-trips', async () => {
    const transport = new FakeTransport();
    const clock = { t: 1_000 };
    const m = makeManager(transport, clock);

    await m.enter('deck:a'); // call #1
    await m.leave('deck:a'); // warm
    clock.t = 1_500; // still inside the window
    await m.enter('deck:a'); // back in view — effective set unchanged

    expect(transport.calls).toHaveLength(1);

    // And a later sweep does NOT drop it — it's active again, not warm.
    clock.t = 3_000;
    await m.sweep();
    expect(transport.calls).toHaveLength(1);
    expect(m.effectiveGroups().sort()).toEqual(['deck:a', 'org:1']);
  });

  it('pin keeps a group across leave and never expires while pinned', async () => {
    const transport = new FakeTransport();
    const clock = { t: 1_000 };
    const m = makeManager(transport, clock);

    await m.enter('deck:a'); // call #1
    await m.pin('deck:a'); // prominence (active claim) — no change to set
    await m.leave('deck:a'); // pinned → not warmed, stays subscribed

    clock.t = 1_000_000; // far past any TTL
    await m.sweep(); // pinned group survives

    expect(transport.calls).toHaveLength(1);
    expect(m.effectiveGroups().sort()).toEqual(['deck:a', 'org:1']);
  });

  it('unpinning an out-of-view group warms it, then sweep drops it', async () => {
    const transport = new FakeTransport();
    const clock = { t: 1_000 };
    const m = makeManager(transport, clock);

    await m.enter('deck:a');
    await m.pin('deck:a');
    await m.leave('deck:a'); // still present via pin
    expect(transport.calls).toHaveLength(1);

    await m.unpin('deck:a'); // not active → goes warm (hysteresis), no call yet
    expect(transport.calls).toHaveLength(1);

    clock.t = 2_001; // past warm TTL from unpin
    await m.sweep(); // drops it now
    expect(transport.calls).toEqual([
      ['deck:a', 'org:1'],
      ['org:1'],
    ]);
  });

  it('soft-fails when the transport is offline — enter never rejects', async () => {
    const transport = new FakeTransport();
    const clock = { t: 1_000 };
    const m = makeManager(transport, clock);

    transport.offline = true;
    // Must resolve, not reject — interest is soft state.
    await expect(m.enter('deck:a')).resolves.toBeUndefined();
    expect(transport.calls).toHaveLength(0); // nothing landed
    expect(m.effectiveGroups()).toEqual([]); // lastSent unchanged
  });

  it('resync re-pushes the current desired set after reconnect (interest changed while offline)', async () => {
    const transport = new FakeTransport();
    const clock = { t: 1_000 };
    const m = makeManager(transport, clock);

    await m.enter('deck:a'); // online → call #1 = [deck:a, org:1]
    expect(transport.calls).toHaveLength(1);

    // Go offline, then navigate deck:a → deck:b while disconnected.
    transport.offline = true;
    await m.leave('deck:a');
    await m.enter('deck:b');
    expect(transport.calls).toHaveLength(1); // nothing sent while offline

    // Reconnect: the new socket's URL carried the stale set; resync()
    // re-pushes the now-current desired set so deck:b actually subscribes.
    transport.offline = false;
    await m.resync();

    expect(transport.calls).toHaveLength(2);
    // deck:a is warm (left at t=1_000, TTL 1_000 → still < 2_000), so the
    // re-push includes base + the still-warm deck:a + the active deck:b.
    expect(transport.calls[1]).toEqual(['deck:a', 'deck:b', 'org:1']);

    // After the warm TTL lapses, a sweep drops deck:a, leaving deck:b.
    clock.t = 2_001;
    await m.sweep();
    expect(transport.calls[2]).toEqual(['deck:b', 'org:1']);
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

    await m.enter('deck:a');
    await m.enter('deck:b');
    await m.enter('deck:c');

    await m.leave('deck:a'); // warm {a}
    await m.leave('deck:b'); // warm {a,b}
    await m.leave('deck:c'); // warm {a,b,c} → over cap → evict a

    // deck:a was dropped immediately (not waiting for its TTL); b and c stay.
    expect(m.effectiveGroups().sort()).toEqual(['deck:b', 'deck:c', 'org:1']);
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

    await m.enter('deck:a');
    await m.enter('deck:b');
    await m.leave('deck:a'); // warm {a}
    await m.leave('deck:b'); // warm {a,b}

    // Touch a: re-enter then re-leave → a becomes most-recently-warmed.
    await m.enter('deck:a'); // warm {b}, a active
    await m.leave('deck:a'); // warm {b,a}  (a now newest)

    await m.enter('deck:c');
    await m.leave('deck:c'); // warm {b,a,c} → evict oldest = b (a was refreshed)

    const groups = m.effectiveGroups().sort();
    expect(groups).toContain('deck:a'); // survived — refreshed
    expect(groups).toContain('deck:c');
    expect(groups).not.toContain('deck:b'); // evicted — least recent
  });

  it('base groups are always present and survive every sweep', async () => {
    const transport = new FakeTransport();
    const clock = { t: 1_000 };
    const m = makeManager(transport, clock);

    await m.enter('deck:a');
    await m.leave('deck:a');
    clock.t = 10_000;
    await m.sweep();

    expect(m.effectiveGroups()).toEqual(['org:1']);
  });
});
