/**
 * ModelData — the generic record shape for model payloads.
 *
 * Lives in its own dependency-free leaf so BOTH `BaseSyncedStore` and
 * `SyncClient` can import it without importing each other. (The alias
 * used to live in BaseSyncedStore.ts, which made SyncClient.ts and
 * BaseSyncedStore.ts a mutual type cycle: the store needs the SyncClient
 * class type, and SyncClient needed this alias back from the store.)
 * `BaseSyncedStore` re-exports it, so existing importers are unchanged.
 */

/** Generic record type for model data */
export type ModelData = Record<string, unknown>;
