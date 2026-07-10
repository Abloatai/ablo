/**
 * An in-memory {@link ObjectStoreContract} implementation for runtimes
 * without IndexedDB, such as Node processes, agents, and tests. It keeps
 * records in a map and maintains simple secondary indexes, satisfying the
 * same contract the IndexedDB-backed store implements — so if the two ever
 * diverge, the mismatch becomes a typecheck error here rather than a silent
 * failure at a call site.
 *
 * Nothing is persisted; the data is cleared on process restart. That is
 * deliberate: server-side runtimes and agent workers rebuild their state from
 * the server's delta stream rather than from a local cache.
 */

import type { ObjectStoreContract } from '../stores/ObjectStoreContract.js';

export class InMemoryObjectStore implements ObjectStoreContract {
  private data = new Map<string, Record<string, unknown>>();
  private indexes = new Map<string, Map<string, Set<string>>>();

  constructor(
    public readonly modelName: string,
    public readonly storeName: string,
    indexNames: string[] = [],
  ) {
    for (const name of indexNames) {
      this.indexes.set(name, new Map());
    }
  }

  async put(record: Record<string, unknown>): Promise<void> {
    const id = record.id as string;
    if (!id) return;

    // Remove from old index entries if updating
    const existing = this.data.get(id);
    if (existing) {
      this.removeFromIndexes(id, existing);
    }

    this.data.set(id, { ...record });
    this.addToIndexes(id, record);
  }

  async get(id: string): Promise<Record<string, unknown> | undefined> {
    return this.data.get(id);
  }

  async getAll(): Promise<Record<string, unknown>[]> {
    return [...this.data.values()];
  }

  async delete(id: string): Promise<void> {
    const existing = this.data.get(id);
    if (existing) {
      this.removeFromIndexes(id, existing);
      this.data.delete(id);
    }
  }

  async getAllFromIndex(
    indexName: string,
    value: IDBValidKey,
  ): Promise<Record<string, unknown>[]> {
    const index = this.indexes.get(indexName);
    if (!index) return [];
    // The in-memory index stores values as strings (it doesn't support
    // the full IDB key range — Date / BufferSource / arrays). For the
    // overwhelmingly-common case of string FK ids, coercing through
    // String() preserves the existing behavior while satisfying the
    // shared `ObjectStoreContract` signature.
    const ids = index.get(String(value));
    if (!ids) return [];
    return [...ids]
      .map((id) => this.data.get(id))
      .filter((r): r is Record<string, unknown> => r != null);
  }

  async clear(): Promise<void> {
    this.data.clear();
    for (const index of this.indexes.values()) {
      index.clear();
    }
  }

  /** No-op — in-memory stores don't need closing. */
  markAsClosing(): void {}

  private addToIndexes(id: string, record: Record<string, unknown>): void {
    for (const [indexName, indexMap] of this.indexes) {
      const value = record[indexName];
      if (value != null) {
        const key = String(value);
        if (!indexMap.has(key)) indexMap.set(key, new Set());
        indexMap.get(key)!.add(id);
      }
    }
  }

  private removeFromIndexes(id: string, record: Record<string, unknown>): void {
    for (const [indexName, indexMap] of this.indexes) {
      const value = record[indexName];
      if (value != null) {
        const key = String(value);
        indexMap.get(key)?.delete(id);
      }
    }
  }
}
