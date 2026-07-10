/**
 * Small, self-contained helpers for sorting, filtering, and binary insertion.
 * The incrementally-updated views that implement {@link IncrementalView} rely on
 * these for their ordering and matching, so keeping the rules in one place
 * ensures every view sorts and filters identically. The functions here work on
 * plain arrays and values — they hold no reference to models, pools, or the
 * reactivity system.
 */

/**
 * The interface a live view implements to receive incremental updates: one call
 * when an entity is added, one when it changes, and one when it is removed. A
 * view registry holds its views under this non-generic base type so it can keep
 * views over different entity shapes in a single collection and notify them
 * uniformly. Because a generic `View<T>` is invariant in `T`, this shared base
 * is what lets the registry store and dispatch to them without unsafe casts.
 */
export interface IncrementalView {
  handleAdded(entity: Record<string, unknown>): void;
  handleUpdated(entity: Record<string, unknown>): void;
  handleRemoved(id: string): void;
}

/**
 * Compares two values for sorting, tolerating `null` and `undefined`, which
 * always sort last regardless of direction. `dir` is 1 for ascending or -1 for
 * descending. Returns -1, 0, or 1.
 */
export function compareValues(a: unknown, b: unknown, dir: 1 | -1): number {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return ((a as number) < (b as number) ? -1 : 1) * dir;
}

/**
 * Finds, by binary search, the index at which `item` should be inserted to keep
 * an array ordered. The array must already be sorted by `sortKey` in direction
 * `dir`, using the same rule as {@link compareValues}. Returns that insertion
 * index.
 */
export function binaryInsertionIndex<T>(
  arr: ArrayLike<T>,
  item: T,
  sortKey: string,
  dir: 1 | -1,
): number {
  let lo = 0;
  let hi = arr.length;
  const itemVal = (item as Record<string, unknown>)[sortKey];

  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const midVal = (arr[mid] as Record<string, unknown>)[sortKey];
    if (compareValues(midVal, itemVal, dir) <= 0) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * Returns true when an entity satisfies a declarative `where` filter: every key
 * present in `where` must equal the entity's value for that key. A key whose
 * filter value is `undefined` is skipped, so a partially-filled filter matches
 * on only its defined keys.
 */
export function matchesWhere<T extends Record<string, unknown>>(
  entity: T,
  where: Partial<T>,
): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue;
    if (entity[key] !== value) return false;
  }
  return true;
}

/**
 * Find the index of an entity by id in an array. Returns -1 if not found.
 */
export function findIndexById<T extends Record<string, unknown>>(
  arr: ArrayLike<T>,
  id: string,
): number {
  for (let i = 0; i < arr.length; i++) {
    if (arr[i]?.id === id) return i;
  }
  return -1;
}
