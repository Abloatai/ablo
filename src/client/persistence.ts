/**
 * Local persistence modes. `'memory'` (the default everywhere outside the
 * browser) keeps the local graph in process memory; `'indexeddb'` adds
 * offline queueing and a reload-surviving cache in the browser.
 */
export type AbloPersistence = 'memory' | 'indexeddb';

export interface PersistenceOptions {
  readonly persistence?: AbloPersistence | undefined;
  readonly inMemory?: boolean | undefined;
  readonly offline?: boolean | undefined;
}

export function shouldUseInMemoryPersistence(options: PersistenceOptions): boolean {
  if (typeof window === 'undefined') return true;
  if (options.persistence) return options.persistence === 'memory';
  if (typeof options.inMemory === 'boolean') return options.inMemory;
  if (options.offline === true) return false;
  return true;
}
