/**
 * query-utils — Pure query helpers shared between QueryView (MobX) and
 * AgentQueryView (headless). One source of truth for sort, filter, and
 * binary insertion logic.
 *
 * No MobX, no ObjectPool, no Model — just arrays and values.
 */

/**
 * The incremental-update contract that both QueryView and
 * AgentQueryView satisfy. Their respective registries (ViewRegistry,
 * AgentViewRegistry) store views as this base type so they can
 * dispatch to many views with different `T` parameters from one Set
 * — `View<T>` is invariant in T, so without this shared base the
 * registries would have to widen via `unknown as View<Record<...>>`
 * at every register/unregister/notify call.
 */
export interface IncrementalView {
  handleAdded(entity: Record<string, unknown>): void;
  handleUpdated(entity: Record<string, unknown>): void;
  handleRemoved(id: string): void;
}

/** Compare two values for sorting, null-safe. Returns -1 | 0 | 1. */
export function compareValues(a: unknown, b: unknown, dir: 1 | -1): number {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return ((a as number) < (b as number) ? -1 : 1) * dir;
}

/**
 * Binary search for the correct insertion index in a sorted array.
 * Returns the index at which `item` should be inserted.
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
 * Check whether an entity matches a declarative `where` clause.
 * Every key in `where` must exactly match the entity's value.
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
    if (arr[i]['id'] === id) return i;
  }
  return -1;
}
