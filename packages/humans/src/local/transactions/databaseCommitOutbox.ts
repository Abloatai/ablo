import type {
  DurableWriteStore,
} from '@ablo/transaction/durableWrites';
import type { PendingWrite } from '@ablo/transaction/transactions/settlement/pendingWrite';

export interface CommitOutboxDatabase {
  sealTransactionRecord(
    record: PendingWrite,
    consumedRecordIds: readonly string[],
  ): Promise<unknown>;
  getPersistedTransactions(): Promise<readonly unknown[]>;
  removeTransaction(id: string): Promise<void>;
}

/** IndexedDB-backed durable commit adapter owned by the human materialiser. */
export class DatabaseCommitOutboxStore implements DurableWriteStore {
  constructor(private readonly database: CommitOutboxDatabase) {}

  async seal(
    envelope: PendingWrite,
    consumedRecordIds: readonly string[],
  ): Promise<void> {
    await this.database.sealTransactionRecord(envelope, consumedRecordIds);
  }

  list(): Promise<readonly unknown[]> {
    return this.database.getPersistedTransactions();
  }

  remove(envelopeRecordId: string): Promise<void> {
    return this.database.removeTransaction(envelopeRecordId);
  }
}
