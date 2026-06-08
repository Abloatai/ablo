/**
 * QueryView<T> — Incrementally maintained materialized view for a single query.
 *
 * Instead of scanning the full collection on every render, a QueryView
 * builds the result set once, then maintains it via handleAdded /
 * handleUpdated / handleRemoved calls from the ViewRegistry.
 *
 * `results` is a stable MobX observable array — components observe it
 * directly and receive granular updates (splice/push, never replacement).
 */

import { observable, runInAction, type IObservableArray } from 'mobx';
import { type Model, modelAsRow } from '../Model.js';
import { ModelScope } from '../types/index.js';
import type { ObjectPool } from '../ObjectPool.js';
import type { ViewRegistry } from './ViewRegistry.js';
import type { IncrementalView } from './query-utils.js';
import {
  compareValues,
  binaryInsertionIndex,
  findIndexById,
} from './query-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueryViewOptions<T> {
  where?: Partial<T>;
  filter?: (entity: T) => boolean;
  orderBy?: keyof T & string;
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
  /** Lifecycle filter — `live` (default), `archived`, or `all`. Named `state`
   *  (GitHub's open/closed/all precedent) so it doesn't collide with the
   *  sync-group `scope`. */
  state?: ModelScope;
}

// ---------------------------------------------------------------------------
// QueryView
// ---------------------------------------------------------------------------

export class QueryView<T extends Record<string, unknown>> implements IncrementalView {
  /** The full (unlimited) internal result set, kept sorted. */
  private _internal: IObservableArray<T>;

  /**
   * Public observable result set — windowed by offset/limit.
   * Components observe this directly.
   */
  readonly results: IObservableArray<T>;

  private readonly typename: string;
  private readonly pool: ObjectPool;
  private readonly registry: ViewRegistry;
  private readonly whereEntries: Array<[string, unknown]> | null;
  private readonly filterFn: ((entity: T) => boolean) | null;
  private readonly sortKey: string | null;
  private readonly sortDir: 1 | -1;
  private readonly limitN: number | undefined;
  private readonly offsetN: number;
  private readonly scope: ModelScope;

  /** FK-index optimization: if the where clause targets a single FK-indexed field. */
  private readonly fkField: string | null;
  private readonly fkValue: string | null;

  private disposed = false;

  constructor(
    typename: string,
    pool: ObjectPool,
    registry: ViewRegistry,
    options: QueryViewOptions<T> = {},
  ) {
    this.typename = typename;
    this.pool = pool;
    this.registry = registry;

    // Parse options
    this.whereEntries = options.where
      ? Object.entries(options.where).filter(([, v]) => v !== undefined)
      : null;

    this.filterFn = options.filter ?? null;
    this.sortKey = (options.orderBy as string) ?? null;
    this.sortDir = options.order === 'desc' ? -1 : 1;
    this.limitN = options.limit;
    this.offsetN = options.offset ?? 0;
    this.scope = options.state ?? ModelScope.live;

    // Check for FK-index optimization: single-field where with an indexed FK
    this.fkField = null;
    this.fkValue = null;
    if (
      this.whereEntries &&
      this.whereEntries.length === 1 &&
      typeof this.whereEntries[0][1] === 'string'
    ) {
      const [field, value] = this.whereEntries[0];
      if (pool.hasForeignKeyIndex(typename, field)) {
        this.fkField = field;
        this.fkValue = value as string;
      }
    }

    // Create observable arrays (shallow — models are already observable)
    this._internal = observable.array<T>([], { deep: false });
    this.results = observable.array<T>([], { deep: false });

    // Perform initial scan
    this.initialScan();

    // Register for incremental updates
    this.registry.register(
      typename,
      this,
    );
  }

  // -----------------------------------------------------------------------
  // Initial scan
  // -----------------------------------------------------------------------

  private initialScan(): void {
    let candidates: Model[];

    if (this.fkField && this.fkValue) {
      // O(1) FK-index lookup
      candidates = this.pool.getByForeignKey(
        this.typename,
        this.fkField,
        this.fkValue,
      );
    } else {
      candidates = this.pool.getByTypeName(this.typename, this.scope);
    }

    const matching: T[] = [];
    for (const model of candidates) {
      const entity = modelAsRow<T>(model);
      if (this.matchesFilter(entity)) {
        matching.push(entity);
      }
    }

    // Sort
    if (this.sortKey) {
      const key = this.sortKey;
      const dir = this.sortDir;
      matching.sort((a, b) =>
        compareValues(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
          dir,
        ),
      );
    }

    runInAction(() => {
      this._internal.replace(matching);
      this.syncWindow();
    });
  }

  // -----------------------------------------------------------------------
  // Incremental update handlers (called by ViewRegistry)
  // -----------------------------------------------------------------------

  handleAdded(model: Record<string, unknown>): void {
    if (this.disposed) return;
    const entity = model as T;
    const passesFilter = this.matchesFilter(entity);
    if (!passesFilter) return;

    runInAction(() => {
      this.insertSorted(entity);
      this.syncWindow();
    });
  }

  handleUpdated(model: Record<string, unknown>): void {
    if (this.disposed) return;
    const entity = model as T;
    const id = (entity as Record<string, unknown>)['id'] as string | undefined;
    const idx = id !== undefined ? this.findIndexById(id) : -1;
    const matchesNow = this.matchesFilter(entity);

    runInAction(() => {
      if (idx >= 0 && matchesNow) {
        // Was in view and still matches.
        // Models are plain objects (not MobX-observable), so we must notify
        // observers that the data changed. Splice-in-place triggers the
        // observable array to fire, which causes useQuery consumers to
        // re-render with fresh property values.
        this._internal.splice(idx, 1);
        this.insertSorted(entity);
      } else if (idx >= 0 && !matchesNow) {
        // Was in view but no longer matches — remove
        this._internal.splice(idx, 1);
      } else if (idx < 0 && matchesNow) {
        // Wasn't in view but now matches — add
        this.insertSorted(entity);
      }
      this.syncWindow();
    });
  }

  handleRemoved(modelId: string): void {
    if (this.disposed) return;
    const idx = this.findIndexById(modelId);
    if (idx < 0) return;

    runInAction(() => {
      this._internal.splice(idx, 1);
      this.syncWindow();
    });
  }

  // -----------------------------------------------------------------------
  // Dispose
  // -----------------------------------------------------------------------

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.registry.unregister(
      this.typename,
      this,
    );
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Check whether an entity passes both `where` and `filter`. */
  private matchesFilter(entity: T): boolean {
    // Note: scope is tracked per-entry in the ObjectPool, not on the model.
    // The initial scan handles scope via getByTypeName(typename, scope).
    // Incremental notifications from the pool are scope-appropriate since
    // add/upsert/remove reflect the pool's authoritative scope tracking.

    // Where clause: declarative field matching
    if (this.whereEntries) {
      for (const [key, value] of this.whereEntries) {
        if ((entity as Record<string, unknown>)[key] !== value) return false;
      }
    }

    // Arbitrary predicate
    if (this.filterFn) {
      if (!this.filterFn(entity)) return false;
    }

    return true;
  }

  /** Insert entity into _internal at the correct sorted position. */
  private insertSorted(entity: T): void {
    if (this.sortKey) {
      const idx = binaryInsertionIndex(
        this._internal,
        entity,
        this.sortKey,
        this.sortDir,
      );
      this._internal.splice(idx, 0, entity);
    } else {
      this._internal.push(entity);
    }
  }

  /** Find index of entity by id in _internal. */
  private findIndexById(id: string): number {
    return findIndexById(this._internal, id);
  }

  /**
   * Synchronize the public `results` array with the windowed slice of
   * `_internal`. Mutates in place to keep the reference stable.
   */
  private syncWindow(): void {
    const start = this.offsetN;
    const end =
      this.limitN !== undefined ? start + this.limitN : this._internal.length;
    const windowed = this._internal.slice(start, end);

    // Minimal diff: only splice if contents differ
    if (
      windowed.length === this.results.length &&
      windowed.every((item, i) => this.results[i] === item)
    ) {
      return; // no change
    }

    this.results.replace(windowed);
  }
}
