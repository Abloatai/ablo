export type PersistedMutationRecord = Record<string, unknown>;

export interface MutationPersistencePort {
  saveTransaction(transaction: PersistedMutationRecord): Promise<void>;
  removeTransaction(id: string): Promise<void>;
  getPersistedTransactions(): Promise<PersistedMutationRecord[]>;
}
