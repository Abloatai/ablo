'use client';

import { useCallback, useRef } from 'react';
import { useSyncExternalStore } from 'react';
import { reaction } from 'mobx';

/**
 * Subscribe a component to a reactive computation and re-render when
 * the result changes. Concurrent-render safe, referentially stable
 * across renders when the value is unchanged.
 *
 * Thin wrapper over React's `useSyncExternalStore` + MobX `reaction`
 * that hides the three-arg ceremony and the "cached snapshot" rule
 * those primitives impose. Consumers write domain code:
 *
 *   const count = useReactive(() => store.tasks.length);
 *   const todos = useReactive(() => store.tasks.findMany({ status: 'todo' }));
 *   const title = useReactive(() => store.user.name ?? 'Guest');
 *
 * and get values that track MobX observables transparently. No
 * subscribe callbacks, no getSnapshot identity contract, no React
 * concurrent-mode mechanics to reason about.
 *
 * ## Equality
 *
 * The default `equals` is structural for arrays (length + element
 * identity) and `Object.is` for everything else — matches what 99%
 * of UI code expects from a reactive read. Pass a custom `equals`
 * for bespoke shapes (deep objects, tuples, etc.).
 *
 * ## Why not raw useSyncExternalStore?
 *
 * `useSyncExternalStore` is React's low-level primitive for library
 * authors. It leaks concurrent-mode internals (tearing protection,
 * commit-phase subscription) into consumer code and enforces a
 * "getSnapshot must return a cached reference" contract that's easy
 * to violate — violating it causes React error #185 (infinite render
 * loop). This helper lives once and enforces the contract so every
 * caller writes the domain-level code, not the primitive.
 */
export function useReactive<T>(
  compute: () => T,
  equals: (a: T, b: T) => boolean = defaultEquals,
): T {
  // Late-binding refs so the subscribe callback stays stable across
  // re-renders — otherwise React would re-subscribe every render,
  // which both churns the MobX reaction and leaks listeners.
  const computeRef = useRef(compute);
  computeRef.current = compute;
  const equalsRef = useRef(equals);
  equalsRef.current = equals;

  // Cached snapshot — referentially stable between reaction fires.
  // Lazy-initialized on first render so SSR and strict-mode double-
  // mount don't compute twice.
  const snapshotRef = useRef<{ value: T } | null>(null);
  if (snapshotRef.current === null) {
    snapshotRef.current = { value: compute() };
  }

  const subscribe = useCallback((onChange: () => void): (() => void) => {
    return reaction(
      () => computeRef.current(),
      (next) => {
        const current = snapshotRef.current!.value;
        if (!equalsRef.current(current, next)) {
          snapshotRef.current = { value: next };
          onChange();
        }
      },
    );
  }, []);

  const getSnapshot = useCallback((): T => snapshotRef.current!.value, []);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Default equality: structural for arrays, `Object.is` otherwise.
 * Covers the common cases (collection reads, scalar reads) without
 * requiring callers to think about reference identity.
 */
function defaultEquals<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!Object.is(a[i], b[i])) return false;
    }
    return true;
  }
  return false;
}
