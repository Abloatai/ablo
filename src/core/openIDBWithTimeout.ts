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
  constructor(
    public readonly dbName: string,
    public readonly reason: 'blocked' | 'timeout',
    message: string,
  ) {
    super(message);
    this.name = 'IDBOpenTimeoutError';
  }
}

export interface OpenIDBOptions {
  /** Called inside `onupgradeneeded` — mirrors `IDBOpenDBRequest.onupgradeneeded`. */
  onUpgrade?: (request: IDBOpenDBRequest, event: IDBVersionChangeEvent) => void;
  /** Max milliseconds to wait for the open request to resolve. Default 10_000. */
  timeoutMs?: number;
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

    request.onsuccess = () => settle(() => resolve(request.result));
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
