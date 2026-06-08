/**
 * Wrap `indexedDB.open()` with a timeout + loud `onblocked` surfacing so the
 * request can never silently hang the app.
 *
 * The native `IDBOpenDBRequest` has a nasty failure mode: if another tab is
 * holding an older schema version, the request fires `onblocked` and then
 * waits forever for that tab to close the DB. Neither `onsuccess` nor
 * `onerror` fires — the promise wrapping it never settles and every caller
 * above sits indefinitely.
 *
 * This helper converts that into a real error after a bounded wait, which
 * flows up through `engine.ready()` → `SyncEngineProvider.handleError()` →
 * the error skeleton with a retry button. A visible error is strictly better
 * than a forever-spinner the user can only escape by closing the tab.
 */
export class IDBOpenTimeoutError extends Error {
  /**
   * Stable, transport-independent code. `toAbloError` preserves a string
   * `.code`, so this survives the wrap into `AbloError` and reaches the
   * provider's `onError` intact — letting the app distinguish a wedged-storage
   * failure (show a recovery screen) from any other bootstrap error without a
   * brittle message match.
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

/** True for the wedged-IndexedDB failure, after it has been wrapped anywhere. */
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
   * Called when another context (a new tab, a fresh deploy, or our own
   * `deleteIDBWithTimeout` self-heal) fires `versionchange` on this connection.
   * By default the connection is `close()`d immediately — the W3C/MDN-mandated
   * behavior that lets the other context's upgrade/delete proceed instead of
   * blocking forever. Provide this to ALSO react (e.g. prompt a reload) AFTER
   * the close. Throwing here is swallowed.
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
        options.onUpgrade!(request, event as IDBVersionChangeEvent);
      };
    }

    request.onsuccess = () => {
      // If we ALREADY timed out (or blocked) and rejected, this is a late
      // success: the native open eventually completed after we gave up. The
      // resulting connection is orphaned — nobody up the stack holds it, so
      // nobody will `.close()` it. A leaked open connection holds an IndexedDB
      // lock that wedges every subsequent open/delete of this DB name (the
      // exact "ablo_databases open/delete hangs forever with no event" failure
      // mode). Close it here so a timed-out attempt can't poison the store.
      if (settled) {
        try {
          request.result.close();
        } catch {
          // Best-effort — a half-open connection may already be unusable.
        }
        return;
      }
      const db = request.result;
      // MANDATORY resilience handler (W3C IndexedDB / MDN): close this
      // connection the instant any other context wants to upgrade or delete the
      // DB. Without it, an open connection that ignores `versionchange` blocks
      // the other context's request indefinitely — the root cause of a wedged
      // `ablo_databases` that survives reloads (an interrupted transaction's
      // connection never closes, so every later open/delete hangs with no
      // event). Auto-closing here makes the store self-releasing.
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
      settle(() => resolve(db));
    };
    request.onerror = () => settle(() => reject(request.error));

    // The critical handler: another tab is blocking us. Native API leaves
    // the request pending indefinitely; we fail fast with a clear error so
    // the UI can tell the user to close other tabs.
    request.onblocked = () => {
      settle(() =>
        reject(
          new IDBOpenTimeoutError(
            name,
            'blocked',
            `IndexedDB \"${name}\" open blocked — another tab is holding an ` +
              `older version. Close other Ablo tabs and reload.`,
          ),
        ),
      );
    };

    // Catch-all timeout: even without `onblocked`, some browsers in some
    // storage states hang without firing any event. Bounded wait →
    // deterministic error.
    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new IDBOpenTimeoutError(
            name,
            'timeout',
            `IndexedDB \"${name}\" open did not resolve within ${timeoutMs}ms. ` +
              `Storage may be in a bad state — clearing site data and reloading ` +
              `usually fixes this.`,
          ),
        ),
      );
    }, timeoutMs);
  });
}

/**
 * Bounded `indexedDB.deleteDatabase()` — the delete counterpart of
 * `openIDBWithTimeout`. Used by the meta-DB self-heal: when opening
 * `ablo_databases` times out (a wedged backing store), we attempt to delete it
 * and re-create from scratch. The registry it holds is rebuildable from the
 * server on the next bootstrap, so dropping it is safe.
 *
 * Like `open`, `deleteDatabase` can hang indefinitely: if another live
 * connection holds the DB it fires `onblocked` and waits, and on a truly stuck
 * store it fires *no* event at all. Both become a bounded rejection here so the
 * caller can fall through to surfacing a real error instead of spinning.
 *
 * Resolves `true` on a clean delete, `false` if it was blocked or timed out
 * (caller decides whether to retry the open regardless — a no-op delete still
 * leaves us no worse off).
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
    request.onsuccess = () => settle(true);
    request.onerror = () => settle(false);
    request.onblocked = () => settle(false);
    const timer = setTimeout(() => settle(false), timeoutMs);
  });
}
