/**
 * AgentQueryView — MobX-free reactive query view for headless agents.
 *
 * Same incremental maintenance algorithm as QueryView (binary insertion
 * sort, where/filter/orderBy/limit) but uses plain arrays + callback
 * listeners instead of MobX observables. Runs in Node.js without any
 * browser or framework dependencies.
 *
 * Shares core logic with QueryView via query-utils.ts.
 */

import {
  compareValues,
  binaryInsertionIndex,
  matchesWhere,
  findIndexById,
} from '../core/query-utils';

// ── Types ─────────────────────────────────────────────────────────────────

export interface AgentQueryViewOptions<T> {
  where?: Partial<T>;
  filter?: (entity: T) => boolean;
  orderBy?: keyof T & string;
  order?: 'asc' | 'desc';
  limit?: number;
}

type Listener<T> = (results: readonly T[]) => void;

// ── AgentQueryView ────────────────────────────────────────────────────────

export class AgentQueryView<T extends Record<string, unknown>> {
  private _results: T[] = [];
  private readonly _listeners = new Set<Listener<T>>();

  private readonly whereEntries: Array<[string, unknown]> | null;
  private readonly filterFn: ((entity: T) => boolean) | null;
  private readonly sortKey: string | null;
  private readonly sortDir: 1 | -1;
  private readonly limitN: number | undefined;

  constructor(options: AgentQueryViewOptions<T> = {}) {
    this.whereEntries = options.where
      ? Object.entries(options.where).filter(([, v]) => v !== undefined)
      : null;
    this.filterFn = options.filter ?? null;
    this.sortKey = (options.orderBy as string) ?? null;
    this.sortDir = options.order === 'desc' ? -1 : 1;
    this.limitN = options.limit;
  }

  /** Current results (readonly snapshot). */
  get results(): readonly T[] {
    return this.limitN !== undefined
      ? this._results.slice(0, this.limitN)
      : this._results;
  }

  /** Subscribe to result changes. Returns an unsubscribe function. */
  subscribe(listener: Listener<T>): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  // ── Incremental update handlers (called by AgentViewRegistry) ─────────

  handleAdded(entity: T): void {
    if (!this.matchesFilter(entity)) return;
    this.insertSorted(entity);
    this.notify();
  }

  handleUpdated(entity: T): void {
    const id = entity['id'] as string | undefined;
    const idx = id !== undefined ? findIndexById(this._results, id) : -1;
    const matchesNow = this.matchesFilter(entity);

    if (idx >= 0 && matchesNow) {
      // Was in view, still matches — re-sort if needed
      if (this.sortKey) {
        this._results.splice(idx, 1);
        this.insertSorted(entity);
      } else {
        // Update in place
        this._results[idx] = entity;
      }
    } else if (idx >= 0 && !matchesNow) {
      // Was in view, no longer matches
      this._results.splice(idx, 1);
    } else if (idx < 0 && matchesNow) {
      // Wasn't in view, now matches
      this.insertSorted(entity);
    } else {
      return; // No change
    }

    this.notify();
  }

  handleRemoved(id: string): void {
    const idx = findIndexById(this._results, id);
    if (idx < 0) return;
    this._results.splice(idx, 1);
    this.notify();
  }

  // ── Internal ────────────────────────────────────────────────────────

  private matchesFilter(entity: T): boolean {
    if (this.whereEntries) {
      for (const [key, value] of this.whereEntries) {
        if (entity[key] !== value) return false;
      }
    }
    if (this.filterFn && !this.filterFn(entity)) return false;
    return true;
  }

  private insertSorted(entity: T): void {
    if (this.sortKey) {
      const idx = binaryInsertionIndex(
        this._results,
        entity,
        this.sortKey,
        this.sortDir,
      );
      this._results.splice(idx, 0, entity);
    } else {
      this._results.push(entity);
    }
  }

  private notify(): void {
    const snapshot = this.results;
    for (const listener of this._listeners) {
      try {
        listener(snapshot);
      } catch { /* ignore listener errors */ }
    }
  }
}
