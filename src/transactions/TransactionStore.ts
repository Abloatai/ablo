/**
 * An in-memory index of transactions by id, with a secondary index by status.
 * The status index keeps the queue's hot paths — such as `getByStatus('pending')`
 * on every batch and coalesce decision — proportional to the number of
 * transactions in that status rather than the total across all statuses.
 * {@link TransactionQueue} owns an instance and routes every status change
 * through {@link updateStatus}, which keeps the two indexes consistent.
 */

import type { Transaction } from './commitPayload.js';

export class TransactionStore {
  private transactions = new Map<string, Transaction>();
  private byStatus = new Map<string, Set<string>>();

  add(transaction: Transaction): void {
    this.transactions.set(transaction.id, transaction);

    if (!this.byStatus.has(transaction.status)) {
      this.byStatus.set(transaction.status, new Set());
    }
    this.byStatus.get(transaction.status)!.add(transaction.id);
  }

  get(id: string): Transaction | undefined {
    return this.transactions.get(id);
  }

  updateStatus(id: string, newStatus: Transaction['status']): void {
    const tx = this.transactions.get(id);
    if (!tx) return;

    this.byStatus.get(tx.status)?.delete(id);
    tx.status = newStatus;

    if (!this.byStatus.has(newStatus)) {
      this.byStatus.set(newStatus, new Set());
    }
    this.byStatus.get(newStatus)!.add(id);
  }

  getByStatus(status: Transaction['status']): Transaction[] {
    const ids = this.byStatus.get(status) || new Set();
    return Array.from(ids)
      .map((id) => this.transactions.get(id)!)
      .filter(Boolean);
  }

  remove(id: string): void {
    const tx = this.transactions.get(id);
    if (!tx) return;

    this.transactions.delete(id);
    this.byStatus.get(tx.status)?.delete(id);
  }

  clear(): void {
    this.transactions.clear();
    this.byStatus.clear();
  }

  getAll(): Transaction[] {
    return Array.from(this.transactions.values());
  }
}
