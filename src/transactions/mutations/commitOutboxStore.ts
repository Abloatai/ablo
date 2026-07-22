/**
 * Narrow persistence port for crash-durable commit envelopes.
 *
 * Browser clients use {@link DatabaseCommitOutboxStore}. Agent/Node hosts can
 * inject a workflow-, SQLite-, or filesystem-backed implementation without
 * coupling MutationQueue to the browser database/cache implementation.
 */

import type {
  DurableWriteStore,
  PendingWrite,
} from './durableWriteStore.js';

/**
 * The exact subset of the browser `Database` that {@link DatabaseCommitOutboxStore}
 * drives. Typing the adapter to this narrow port instead of importing the
 * concrete `Database` class keeps the outbox store off the
 * `Database → DatabaseManager → ModelRegistry → BaseSyncedStore` import cycle;
 * the real `Database` still satisfies it structurally, so callers are unchanged.
 */
export interface CommitOutboxDatabase {
  sealTransactionRecord(
    record: PendingWrite,
    consumedRecordIds: readonly string[],
  ): Promise<unknown>;
  getPersistedTransactions(): Promise<readonly unknown[]>;
  removeTransaction(id: string): Promise<void>;
}

/** Strict IndexedDB adapter backed by Database's `__transactions` store. */
export class DatabaseCommitOutboxStore implements DurableWriteStore {
  constructor(private readonly database: CommitOutboxDatabase) {}

  async seal(
    envelope: PendingWrite,
    consumedRecordIds: readonly string[],
  ): Promise<void> {
    // This adapter deliberately has no duck-typed fallback. Reporting a
    // successful seal after a no-op or a non-atomic save/delete handoff would
    // authorize network dispatch without the durability this port promises.
    await this.database.sealTransactionRecord(envelope, consumedRecordIds);
  }

  async list(): Promise<readonly unknown[]> {
    return this.database.getPersistedTransactions();
  }

  async remove(envelopeRecordId: string): Promise<void> {
    await this.database.removeTransaction(envelopeRecordId);
  }
}
