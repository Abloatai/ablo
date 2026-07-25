/**
 * BaseSyncedStore — area-of-interest forwarding.
 *
 * The store exposes stable `enterScope`/`leaveScope`/`pinScope`/`unpinScope`
 * methods that resolve a participant scope to sync-group strings (through the
 * SAME resolver the claim path uses) and forward to the
 * SubscriptionManager. This pins:
 *   - resolution + forwarding reach the manager / transport,
 *   - the methods resolve safely while the connection is down (interest is
 *     recorded; the wire push fails soft and `resync` recovers it),
 *   - pin survives leave (prominence), mirroring the manager contract.
 *
 * Uses the `Object.create(prototype)` shell idiom (see
 * createConnectionManager.test.ts) to exercise the methods without the heavy
 * real constructor. Scopes are plain strings, so no schema is needed.
 */

import { BaseSyncedStore } from '../../src/local/BaseSyncedStore';
import { SubscriptionManager } from '../../src/local/sync/SubscriptionManager';
import type { SubscriptionTransport } from '../../src/local/sync/SubscriptionManager';

class FakeTransport implements SubscriptionTransport {
  readonly calls: string[][] = [];
  updateSubscription(
    syncGroups: readonly string[],
  ): Promise<{ syncGroups: string[] }> {
    this.calls.push([...syncGroups].sort());
    return Promise.resolve({ syncGroups: [...syncGroups] });
  }
}

/** The not-open connection: every push rejects, as the transport does. */
class ClosedTransport implements SubscriptionTransport {
  updateSubscription(): Promise<{ syncGroups: string[] }> {
    return Promise.reject(
      new Error('SyncWebSocket not connected — cannot send update_subscription'),
    );
  }
}

interface ScopeApi {
  areaOfInterest: SubscriptionManager;
  schema: undefined;
  enterScope: (scope: string) => Promise<void>;
  leaveScope: (scope: string) => Promise<void>;
  pinScope: (scope: string) => Promise<void>;
  unpinScope: (scope: string) => Promise<void>;
}

function makeShell(manager: SubscriptionManager): ScopeApi {
  const shell = Object.create(BaseSyncedStore.prototype) as ScopeApi;
  shell.areaOfInterest = manager;
  shell.schema = undefined;
  return shell;
}

function makeManager(transport: FakeTransport): SubscriptionManager {
  return new SubscriptionManager({
    transport,
    baseGroups: ['org:1'],
    warmTtlMs: 1_000,
    sweepIntervalMs: 0,
    now: () => 1_000,
    scheduler: () => () => undefined,
  });
}

describe('BaseSyncedStore — area-of-interest forwarding', () => {
  it('enterScope resolves the scope and subscribes through the transport', async () => {
    const transport = new FakeTransport();
    const shell = makeShell(makeManager(transport));

    await shell.enterScope('deck:a');

    expect(transport.calls).toEqual([['deck:a', 'org:1']]);
  });

  it('leaveScope warms the group (no unsubscribe round-trip)', async () => {
    const transport = new FakeTransport();
    const shell = makeShell(makeManager(transport));

    await shell.enterScope('deck:a'); // call #1
    await shell.leaveScope('deck:a'); // warm → no new call

    expect(transport.calls).toHaveLength(1);
  });

  it('pinScope keeps a group subscribed across leaveScope', async () => {
    const transport = new FakeTransport();
    const manager = makeManager(transport);
    const shell = makeShell(manager);

    await shell.enterScope('deck:a'); // call #1
    await shell.pinScope('deck:a');
    await shell.leaveScope('deck:a'); // pinned → still subscribed

    expect(transport.calls).toHaveLength(1);
    expect(manager.effectiveGroups().sort()).toEqual(['deck:a', 'org:1']);
  });

  it('all four methods resolve safely while the connection is down (pre-connect)', async () => {
    const manager = new SubscriptionManager({
      transport: new ClosedTransport(),
      warmTtlMs: 1_000,
      sweepIntervalMs: 0,
      now: () => 1_000,
      scheduler: () => () => undefined,
    });
    const shell = makeShell(manager);

    await expect(shell.enterScope('deck:a')).resolves.toBeUndefined();
    await expect(shell.leaveScope('deck:a')).resolves.toBeUndefined();
    await expect(shell.pinScope('deck:a')).resolves.toBeUndefined();
    await expect(shell.unpinScope('deck:a')).resolves.toBeUndefined();
  });
});
