export type AbloPersistence = 'memory' | 'indexeddb';

export interface PersistenceOptions {
  readonly persistence?: AbloPersistence;
  readonly inMemory?: boolean;
  readonly offline?: boolean;
}

export function shouldUseInMemoryPersistence(
  options: PersistenceOptions,
): boolean {
  if (typeof window === 'undefined') return true;
  if (options.persistence) return options.persistence === 'memory';
  if (typeof options.inMemory === 'boolean') return options.inMemory;
  return options.offline !== true;
}
