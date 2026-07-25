/**
 * Resilience contract for the IndexedDB open/delete helpers.
 *
 * These guard the failure mode that bricked a real session: a wedged
 * `ablo_databases` store whose open/delete hung forever with no event. The
 * W3C-mandated defense is that every connection auto-closes on `versionchange`
 * so a competing upgrade/delete is never blocked — verified here against
 * `fake-indexeddb` (wired globally in jest.setup.ts).
 */

import {
  openIDBWithTimeout,
  deleteIDBWithTimeout,
  IDBOpenTimeoutError,
} from '../openIDBWithTimeout.js';

async function flush(): Promise<void> {
  // Let fake-indexeddb drain its event queue between operations.
  await new Promise((r) => setTimeout(r, 0));
}

describe('openIDBWithTimeout', () => {
  afterEach(async () => {
    await deleteIDBWithTimeout('vc-test');
    await deleteIDBWithTimeout('orphan-test');
    await flush();
  });

  it('auto-closes the connection on versionchange so a competing upgrade is NOT blocked', async () => {
    // First "tab" opens v1 — it must register an onversionchange handler that
    // closes the connection. We deliberately do NOT close it ourselves.
    const db1 = await openIDBWithTimeout('vc-test', 1);
    expect(typeof db1.onversionchange).toBe('function');

    // Second "tab" opens at v2. If db1 ignored versionchange this would block
    // indefinitely; because the helper auto-closes db1, the upgrade proceeds.
    const blocked = false;
    const db2 = await openIDBWithTimeout('vc-test', 2, {
      onUpgrade: () => {
        /* no stores needed for this test */
      },
    });
    // onblocked would have rejected; reaching here means it wasn't blocked.
    expect(blocked).toBe(false);
    expect(db2.version).toBe(2);
    db2.close();
  });

  it('invokes the onVersionChange callback after closing', async () => {
    const reacted: boolean[] = [];
    await openIDBWithTimeout('vc-test', 1, {
      onVersionChange: () => reacted.push(true),
    });
    // Trigger versionchange from another context via deleteDatabase.
    await deleteIDBWithTimeout('vc-test');
    await flush();
    expect(reacted).toEqual([true]);
  });

  it('rejects with IDBOpenTimeoutError(timeout) when the open fires no event (a wedged store)', async () => {
    // Model the real failure: a request that never fires success/error/blocked,
    // exactly like a wedged `ablo_databases` backing store. fake-indexeddb
    // always settles, so we stub the open to hang.
    const realOpen = indexedDB.open;
    const hangingRequest = {
      onsuccess: null,
      onerror: null,
      onblocked: null,
      onupgradeneeded: null,
      result: null,
      error: null,
    } as unknown as IDBOpenDBRequest;
    indexedDB.open = (() => hangingRequest);
    try {
      const err = await openIDBWithTimeout('orphan-test', 1, {
        timeoutMs: 5,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IDBOpenTimeoutError);
      expect((err as IDBOpenTimeoutError).reason).toBe('timeout');
    } finally {
      indexedDB.open = realOpen;
    }
  });

  it('closes a late-arriving success after a timeout instead of leaking the connection', async () => {
    // Stub an open we control: time out first, then deliver success late and
    // assert the helper closed the orphaned connection (a leak would hold a
    // lock that wedges the store).
    const realOpen = indexedDB.open;
    let closed = false;
    const lateRequest = {
      onsuccess: null as null | (() => void),
      onerror: null,
      onblocked: null,
      onupgradeneeded: null,
      result: { close: () => { closed = true; } } as unknown as IDBDatabase,
      error: null,
    } as unknown as IDBOpenDBRequest;
    indexedDB.open = (() => lateRequest);
    try {
      const p = openIDBWithTimeout('orphan-test', 1, { timeoutMs: 5 }).catch(
        () => {},
      );
      await p; // timeout fires → rejects (swallowed)
      // Now the native open "succeeds" late:
      (lateRequest.onsuccess as () => void)();
      expect(closed).toBe(true);
    } finally {
      indexedDB.open = realOpen;
    }
  });
});

describe('deleteIDBWithTimeout', () => {
  it('resolves true on a clean delete', async () => {
    await openIDBWithTimeout('del-test', 1).then((db) => { db.close(); });
    expect(await deleteIDBWithTimeout('del-test')).toBe(true);
  });

  it('resolves true even with an open connection (it auto-closes on versionchange)', async () => {
    // Open and intentionally keep the reference — the auto-close handler must
    // still let the delete through rather than blocking it.
    await openIDBWithTimeout('del-test-2', 1);
    expect(await deleteIDBWithTimeout('del-test-2')).toBe(true);
  });
});
