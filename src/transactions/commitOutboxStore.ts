/**
 * Narrow persistence port for crash-durable commit envelopes.
 *
 * Browser clients use {@link DatabaseCommitOutboxStore}. Agent/Node hosts can
 * inject a workflow-, SQLite-, or filesystem-backed implementation without
 * coupling TransactionQueue to the browser database/cache implementation.
 */

import type { Database } from '../Database.js';
import type { DurableCommitEnvelope } from './commitEnvelope.js';
import type { DurableHttpCommitEnvelope } from './httpCommitEnvelope.js';

export type CommitOutboxRecord =
  | DurableCommitEnvelope
  | DurableHttpCommitEnvelope;

export interface CommitOutboxStore {
  /**
   * Atomically reserve an envelope and consume the staged records it owns.
   * Implementations must be scoped to one logical participant + server plane,
   * reject same-id/different-request seals, and let only one envelope claim a
   * staged record.
   */
  seal(
    envelope: CommitOutboxRecord,
    consumedRecordIds: readonly string[],
  ): Promise<void>;
  /** Load unacknowledged records. Implementations may return untrusted data. */
  list(): Promise<readonly unknown[]>;
  /** Remove one definitively settled envelope. */
  remove(envelopeRecordId: string): Promise<void>;
}

/** Strict IndexedDB adapter backed by Database's `__transactions` store. */
export class DatabaseCommitOutboxStore implements CommitOutboxStore {
  constructor(private readonly database: Database) {}

  async seal(
    envelope: CommitOutboxRecord,
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
