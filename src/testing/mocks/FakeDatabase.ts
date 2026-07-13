import type { Database } from '../../Database.js';

/**
 * Overrides for {@link fakeDatabase}. Everything is typechecked against
 * Database's public surface except `getPersistedTransactions`, which widens to
 * `unknown[]`: persisted rows are untrusted input (the DurableWriteStore port
 * documents this), and restore-path tests feed deliberately corrupt rows.
 */
export type FakeDatabaseOverrides = Omit<
  Partial<Database>,
  'getPersistedTransactions'
> & {
  getPersistedTransactions?: () => Promise<unknown[]>;
};

/**
 * A Database double that implements ONLY the given members — no real
 * prototype behind it, so a code path reaching for anything else fails
 * loudly instead of silently running real IndexedDB logic. The bare `as`
 * is a single narrowing assert (Database is assignable to the overrides
 * type), so every override stays typechecked against the real surface.
 */
export function fakeDatabase(overrides: FakeDatabaseOverrides): Database {
  return overrides as Database;
}
