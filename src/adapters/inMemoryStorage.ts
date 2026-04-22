/**
 * In-memory storage adapter — replaces IndexedDB for Node.js / agent / test.
 *
 * Implements the same public API as ObjectStore (put, get, getAll, delete,
 * getAllFromIndex) but backed by Map<string, Record<string, unknown>>.
 *
 * No persistence — cleared on process restart. This is intentional:
 * the Node sync-server and agent workers get their state from the
 * server's delta stream, not from a local cache.
 */

export class InMemoryObjectStore {
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
    value: string,
  ): Promise<Record<string, unknown>[]> {
    const index = this.indexes.get(indexName);
    if (!index) return [];
    const ids = index.get(value);
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

  async batchPut(records: Record<string, unknown>[]): Promise<void> {
    for (const record of records) {
      await this.put(record);
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
