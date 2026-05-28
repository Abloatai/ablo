export type AbloPersistence = 'volatile' | 'indexeddb';

export interface PersistenceOptions {
  readonly persistence?: AbloPersistence | undefined;
  readonly inMemory?: boolean | undefined;
  readonly offline?: boolean | undefined;
}

export function shouldUseInMemoryPersistence(options: PersistenceOptions): boolean {
  if (typeof window === 'undefined') return true;
  if (options.persistence) return options.persistence === 'volatile';
  if (typeof options.inMemory === 'boolean') return options.inMemory;
  if (options.offline === true) return false;
  return true;
}
