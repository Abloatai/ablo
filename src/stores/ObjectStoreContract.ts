/**
 * The shared interface for record-shaped object stores. Two implementations
 * satisfy it:
 *
 *   - {@link ObjectStore} — backed by IndexedDB, for durable persistence in
 *     the browser.
 *   - {@link InMemoryObjectStore} — backed by a Map, for tests and
 *     environments without IndexedDB.
 *
 * Both expose the same asynchronous surface — `put`, `get`, `getAll`,
 * `delete`, `getAllFromIndex`, `clear`, and `markAsClosing` — so callers
 * work against this interface and never branch on which concrete store they
 * hold. Because both implementations are checked against one interface, any
 * drift between them surfaces as a typecheck error at the store rather than
 * a silent failure in a caller.
 */
export interface ObjectStoreContract {
  /** Insert or update a record. The record must carry an `id` field. */
  put(data: Record<string, unknown>): Promise<void>;

  /** Look up a record by id. */
  get(id: string): Promise<Record<string, unknown> | undefined>;

  /** Read every record currently in the store. */
  getAll(): Promise<Record<string, unknown>[]>;

  /** Delete a record by id. No-op if absent. */
  delete(id: string): Promise<void>;

  /** Read every record matching an indexed value. */
  getAllFromIndex(
    indexName: string,
    value: IDBValidKey,
  ): Promise<Record<string, unknown>[]>;

  /** Remove every record. */
  clear(): Promise<void>;

  /**
   * Mark the store as closing so subsequent `put`/`get` calls
   * short-circuit to a rejection rather than racing the underlying
   * IDB connection close. No-op for in-memory stores.
   */
  markAsClosing(): void;
}
