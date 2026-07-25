/**
 * Runs in-memory queries over a set of models — filtering by predicate,
 * sorting, paginating, and caching the results. A caller hands
 * {@link QueryProcessor} the candidate models and the query options, and it
 * returns a {@link QueryResult}. It keeps two caches: a string-keyed cache for
 * plain queries, and a structural-identity cache for predicate queries, whose
 * closures cannot be turned into a stable string key.
 */

import type { Model } from '../Model.js';
import type { ModelScope } from '../InstanceCache.js';

export interface QueryOptions<T extends Model> {
  predicate?: (model: T) => boolean;
  /** Stable key to distinguish different predicates for the same model type.
   *  Required when multiple predicate queries exist for the same model — without this,
   *  they share a cache key and thrash each other's cached result every render. */
  predicateKey?: string;
  scope?: ModelScope;
  orderBy?: keyof T;
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
  skipCache?: boolean;
}

export interface QueryResult<T extends Model> {
  data: T[];
  total: number;
  hasMore: boolean;
  fromCache?: boolean;
}

/**
 * Simple cache interface for query results
 */
interface QueryCache {
  get<T>(key: string): T | undefined;
  set(key: string, data: unknown): void;
  invalidate(pattern?: string): void;
  clear(): void;
  /** Number of entries currently cached. */
  readonly size: number;
}

/**
 * The default in-memory cache. It keeps a reverse index from model type to the
 * cache keys for that type, so invalidating one model type costs work
 * proportional to that type's keys rather than a scan of the whole cache. A
 * regex fallback still covers the rare pattern that is not a plain model-type
 * match.
 */
class BasicQueryCache implements QueryCache {
  private cache = new Map<string, unknown>();
  // Reverse index: model type -> set of cache keys for that type
  private modelTypeIndex = new Map<string, Set<string>>();

  get<T>(key: string): T | undefined {
    return this.cache.get(key) as T | undefined;
  }

  get size(): number {
    return this.cache.size;
  }

  set(key: string, data: unknown): void {
    this.cache.set(key, data);

    // Extract model type from cache key (format: "operation:ModelType:options")
    const modelType = this.extractModelType(key);
    if (modelType) {
      if (!this.modelTypeIndex.has(modelType)) {
        this.modelTypeIndex.set(modelType, new Set());
      }
      this.modelTypeIndex.get(modelType)!.add(key);
    }
  }

  /**
   * Optimized invalidation - O(k) where k = keys for model type
   * Supports both exact model type names and regex patterns (fallback)
   */
  invalidate(pattern?: string): void {
    if (!pattern) {
      this.cache.clear();
      this.modelTypeIndex.clear();
      return;
    }

    // Fast path: Check if pattern is a simple model type match like ".*ModelType.*"
    const modelType = /^\.\*(\w+)\.\*$/.exec(pattern)?.[1];
    if (modelType !== undefined) {
      const keysToDelete = this.modelTypeIndex.get(modelType);
      if (keysToDelete) {
        for (const key of keysToDelete) {
          this.cache.delete(key);
        }
        this.modelTypeIndex.delete(modelType);
      }
      return;
    }

    // Slow path fallback: regex matching for complex patterns
    // This should rarely be needed with proper model type patterns
    const regex = new RegExp(pattern);
    const keysToDelete: string[] = [];

    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        keysToDelete.push(key);
      }
    }

    // Batch delete to avoid iterator invalidation
    for (const key of keysToDelete) {
      this.cache.delete(key);
      // Clean up index
      const modelType = this.extractModelType(key);
      if (modelType) {
        this.modelTypeIndex.get(modelType)?.delete(key);
      }
    }
  }

  clear(): void {
    this.cache.clear();
    this.modelTypeIndex.clear();
  }

  /**
   * Extract model type from cache key
   * Cache key format: "operation:ModelType:options"
   */
  private extractModelType(key: string): string | null {
    // A missing second segment reads as undefined, so `?? null` yields null.
    return key.split(':')[1] ?? null;
  }
}

export class QueryProcessor {
  private cache: QueryCache;
  private enableCache: boolean;

  // Stable-reference cache for predicate queries. A string cache key cannot
  // capture a closure, so predicate queries use a separate identity-based
  // cache keyed on the deterministic part of the query (model name plus
  // serializable options). Each entry stores the previous result and a
  // fingerprint of its model ids; when the ids are unchanged, the processor
  // returns the previous array reference so observers do not re-render.
  private predicateResultCache = new Map<string, { ids: string; result: QueryResult<Model> }>();

  constructor(config: { enableCache?: boolean } = {}) {
    this.enableCache = config.enableCache ?? true;
    this.cache = new BasicQueryCache();
  }

  /**
   * Process query with filtering, sorting, and pagination
   */
  processQuery<T extends Model>(
    models: T[],
    modelName: string,
    options: QueryOptions<T> = {}
  ): QueryResult<T> {
    // Generate cache key
    const cacheKey = this.generateCacheKey('query', modelName, options);

    // Check string-based cache (non-predicate queries only)
    if (!options.predicate && !options.skipCache && this.enableCache) {
      const cached = this.cache.get<QueryResult<T>>(cacheKey);
      if (cached) {
        return { ...cached, fromCache: true };
      }
    }

    // Apply predicate filter
    let filtered = options.predicate ? models.filter(options.predicate) : models;

    // Sort models
    if (options.orderBy) {
      filtered = this.sortModels(filtered, options.orderBy, options.order);
    }

    const total = filtered.length;

    // Apply pagination
    const offset = options.offset || 0;
    const limit = options.limit || filtered.length;
    const data = filtered.slice(offset, offset + limit);

    const result: QueryResult<T> = {
      data,
      total,
      hasMore: offset + limit < total,
      fromCache: false,
    };

    // For predicate queries: compare by structural identity. Return the
    // previous array reference when the model ids are unchanged, so observers
    // don't re-render on a structurally identical result.
    if (options.predicate && this.enableCache) {
      const ids = data.map((m) => m.id).join(',');
      const cached = this.predicateResultCache.get(cacheKey);

      if (cached && cached.ids === ids) {
        // Structural match — return previous reference for stability
        return { ...(cached.result as QueryResult<T>), fromCache: true };
      }

      // New result — store for future comparison
      this.predicateResultCache.set(cacheKey, { ids, result });
    }

    // For non-predicate queries: use the string-based cache.
    if (!options.predicate && this.enableCache) {
      this.cache.set(cacheKey, result);
    }

    return result;
  }

  /**
   * Sort models by field
   */
  private sortModels<T extends Model>(
    models: T[],
    field: keyof T,
    order: 'asc' | 'desc' = 'asc'
  ): T[] {
    return [...models].sort((a, b) => {
      const aVal = a[field];
      const bVal = b[field];

      if (aVal === bVal) return 0;
      if (aVal === null || aVal === undefined) return 1;
      if (bVal === null || bVal === undefined) return -1;

      const comparison = aVal < bVal ? -1 : 1;
      return order === 'asc' ? comparison : -comparison;
    });
  }

  /**
   * Find first matching model with predicate
   */
  findFirst<T extends Model>(
    models: Generator<T, void, unknown>,
    predicate: (model: T) => boolean
  ): T | undefined {
    for (const model of models) {
      if (predicate(model)) {
        return model;
      }
    }
    return undefined;
  }

  /**
   * Count models with optional predicate
   */
  countModels<T extends Model>(
    models: Generator<T, void, unknown>,
    predicate?: (model: T) => boolean
  ): number {
    let count = 0;

    for (const model of models) {
      if (!predicate || predicate(model)) {
        count++;
      }
    }

    return count;
  }

  /**
   * Generate a deterministic cache key from query parameters.
   * Functions (predicates) are excluded from the key — predicate queries use
   * the structural identity cache (predicateResultCache) instead of the
   * string-based cache.
   */
  private generateCacheKey<T extends Model>(
    operation: string,
    modelName: string,
    options: QueryOptions<T>
  ): string {
    const serializableOptions: Record<string, unknown> = {};
    let hasPredicate = false;

    for (const [key, value] of Object.entries(options)) {
      if (typeof value === 'function') {
        hasPredicate = true;
        // Mark that this query has a predicate, but use a stable marker
        // (not Math.random). The actual caching for predicate queries
        // is handled by predicateResultCache using ID comparison.
        serializableOptions[key] = `__predicate__`;
      } else {
        serializableOptions[key] = value;
      }
    }

    const sortedOptions = JSON.stringify(
      serializableOptions,
      Object.keys(serializableOptions).sort()
    );
    const key = `${operation}:${modelName}:${sortedOptions}`;
    return hasPredicate ? `pred:${key}` : key;
  }

  /**
   * Invalidate cache by pattern
   */
  invalidateCache(pattern?: string): void {
    this.cache.invalidate(pattern);
    // Also invalidate predicate result cache for this model type
    if (pattern) {
      const modelType = /^\.\*(\w+)\.\*$/.exec(pattern)?.[1];
      if (modelType !== undefined) {
        for (const key of this.predicateResultCache.keys()) {
          if (key.includes(modelType)) {
            this.predicateResultCache.delete(key);
          }
        }
      }
    } else {
      this.predicateResultCache.clear();
    }
  }

  /**
   * Clear all cache
   */
  clearCache(): void {
    this.cache.clear();
    this.predicateResultCache.clear();
  }

  /**
   * Get cache stats for debugging
   */
  getCacheStats(): { size: number; enabled: boolean } {
    return {
      size: this.cache.size,
      enabled: this.enableCache,
    };
  }
}
