/**
 * Shared contract for record-shaped object stores.
 *
 * The SDK has two implementations:
 *   - {@link ObjectStore} — IndexedDB-backed (browser persistence)
 *   - {@link InMemoryObjectStore} — Map-backed (tests, SSR fallback)
 *
 * Both expose the same async surface: `put` / `get` / `getAll` /
 * `delete` / `getAllFromIndex` / `clear` / `markAsClosing`.
 * Callers depend on this interface so they don't have to
 * branch on which concrete class they got from `Database.getStore` —
 * the bootstrap, hydration, transaction-persistence, and reconciler
 * paths all consume the contract.
 *
 * Centralizing the types here means a future drift between the two
 * stores trips a typecheck error at the implementor, not silently in
 * a caller. This replaced ad-hoc `as unknown as ReturnType<...>`
 * casts in `Database.ts` that bridged the two classes.
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
