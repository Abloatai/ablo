/**
 * The error raised when opening an IndexedDB database does not complete in a
 * bounded time. {@link openIDBWithTimeout} throws it in two situations: another
 * browser tab is holding an older version of the database open and blocking the
 * upgrade (`reason: 'blocked'`), or the open request produced no result at all
 * within the timeout (`reason: 'timeout'`).
 *
 * The native open request can otherwise hang indefinitely — when a blocking tab
 * never closes its connection, neither the success nor the error callback fires,
 * and any code awaiting the open waits forever. Turning that into a thrown error
 * lets the surrounding application show a recoverable failure instead of an
 * unbreakable spinner.
 */
export class IDBOpenTimeoutError extends Error {
  /**
   * A stable identifier for this failure, independent of the message text. When
   * this error is wrapped into an {@link AbloError} by `toAbloError`, the string
   * code is preserved, so error handlers can recognize a wedged-storage failure
   * and offer a recovery path rather than matching on the message.
   */
  readonly code = 'storage_open_timeout';

  constructor(
    public readonly dbName: string,
    public readonly reason: 'blocked' | 'timeout',
    message: string,
  ) {
    super(message);
    this.name = 'IDBOpenTimeoutError';
  }
}

/**
 * Returns true when a caught value is the storage-open-timeout failure. It
 * detects the failure by its stable `code`, so it still matches after the error
 * has been wrapped into an {@link AbloError} or another error type.
 */
export function isStorageOpenTimeout(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'storage_open_timeout'
  );
}

export interface OpenIDBOptions {
  /** Called inside `onupgradeneeded` — mirrors `IDBOpenDBRequest.onupgradeneeded`. */
  onUpgrade?: (request: IDBOpenDBRequest, event: IDBVersionChangeEvent) => void;
  /** Max milliseconds to wait for the open request to resolve. Default 10_000. */
  timeoutMs?: number;
  /**
   * Called when another context — a new tab, a page reload after a deploy, or
   * this package's own {@link deleteIDBWithTimeout} recovery — needs to upgrade
   * or delete the database and fires a `versionchange` event on this connection.
   * The connection is always closed first, which is what lets the other
   * context's upgrade or delete proceed instead of blocking on this one. Provide
   * this callback to react after that close, for example to prompt the user to
   * reload. Any error it throws is ignored.
   */
  onVersionChange?: () => void;
}

export function openIDBWithTimeout(
  name: string,
  version: number | undefined,
  options: OpenIDBOptions = {},
): Promise<IDBDatabase> {
  const timeoutMs = options.timeoutMs ?? 10_000;

  return new Promise((resolve, reject) => {
    const request = version === undefined
      ? indexedDB.open(name)
      : indexedDB.open(name, version);
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    if (options.onUpgrade) {
      request.onupgradeneeded = (event) => {
        options.onUpgrade!(request, event);
      };
    }

    request.onsuccess = () => {
      // If we already timed out or were blocked and rejected, this is a late
      // success: the native open eventually completed after we gave up. The
      // resulting connection is orphaned — nothing up the stack holds it, so
      // nothing will close it. A leaked open connection holds an IndexedDB lock
      // that wedges every later open or delete of this database name, so close
      // it here to keep a timed-out attempt from poisoning the store.
      if (settled) {
        try {
          request.result.close();
        } catch {
          // Best-effort — a half-open connection may already be unusable.
        }
        return;
      }
      const db = request.result;
      // Required resilience handler per the IndexedDB specification: close this
      // connection as soon as any other context wants to upgrade or delete the
      // database. Without it, a connection that ignores `versionchange` blocks
      // the other context's request indefinitely — a common cause of a database
      // that stays wedged across reloads. Closing here makes the store release
      // itself.
      db.onversionchange = () => {
        try {
          db.close();
        } catch {
          // Already closing/closed — nothing to do.
        }
        try {
          options.onVersionChange?.();
        } catch {
          // A consumer reaction must never break the close.
        }
      };
      settle(() => { resolve(db); });
    };
    request.onerror = () => { settle(() => { reject(request.error); }); };

    // The critical handler: another tab is blocking us. Native API leaves
    // the request pending indefinitely; we fail fast with a clear error so
    // the UI can tell the user to close other tabs.
    request.onblocked = () => {
      settle(() =>
        { reject(
          new IDBOpenTimeoutError(
            name,
            'blocked',
            `IndexedDB \"${name}\" open blocked — another tab is holding an ` +
              `older version. Close other Ablo tabs and reload.`,
          ),
        ); },
      );
    };

    // Catch-all timeout: even without `onblocked`, some browsers in some
    // storage states hang without firing any event. Bounded wait →
    // deterministic error.
    const timer = setTimeout(() => {
      settle(() =>
        { reject(
          new IDBOpenTimeoutError(
            name,
            'timeout',
            `IndexedDB \"${name}\" open did not resolve within ${timeoutMs}ms. ` +
              `Storage may be in a bad state — clearing site data and reloading ` +
              `usually fixes this.`,
          ),
        ); },
      );
    }, timeoutMs);
  });
}

/**
 * Deletes an IndexedDB database within a bounded time — the delete counterpart
 * to {@link openIDBWithTimeout}. It is used to recover from a wedged backing
 * store: when opening a database times out, the caller can delete it and start
 * fresh, which is safe for any database whose contents can be rebuilt on the
 * next load.
 *
 * Like an open request, a native delete can hang indefinitely — it fires a
 * blocked event and waits when another connection still holds the database, and
 * on a truly stuck store it fires no event at all. Both cases become a bounded,
 * resolved result here, so the caller never spins.
 *
 * Resolves to `true` on a clean delete and `false` when the delete was blocked
 * or timed out. Either way the caller can decide whether to retry the open; a
 * delete that did nothing leaves the store no worse off.
 */
export function deleteIDBWithTimeout(
  name: string,
  timeoutMs = 5_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => { settle(true); };
    request.onerror = () => { settle(false); };
    request.onblocked = () => { settle(false); };
    const timer = setTimeout(() => { settle(false); }, timeoutMs);
  });
}
