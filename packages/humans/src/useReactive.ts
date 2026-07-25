'use client';

import { useCallback, useRef } from 'react';
import { useSyncExternalStore } from 'react';
import { reaction } from 'mobx';

/**
 * Subscribe a React component to a MobX computation with a cached snapshot.
 * This is the framework-level reactive primitive owned by @ablo/humans;
 * store/model hooks are layered above it.
 */
export function useReactive<T>(
  compute: () => T,
  equals: (a: T, b: T) => boolean = defaultEquals,
): T {
  const computeRef = useRef(compute);
  const equalsRef = useRef(equals);
  const snapshotRef = useRef<{ value: T } | null>(null);
  const versionRef = useRef(0);

  equalsRef.current = equals;
  if (snapshotRef.current === null) {
    snapshotRef.current = { value: compute() };
  } else if (computeRef.current !== compute) {
    const next = compute();
    if (!equals(snapshotRef.current.value, next)) {
      snapshotRef.current = { value: next };
      versionRef.current++;
    }
  }
  computeRef.current = compute;

  const subscribe = useCallback((onChange: () => void) => reaction(
    () => computeRef.current(),
    (next) => {
      const current = snapshotRef.current!.value;
      if (!equalsRef.current(current, next)) {
        snapshotRef.current = { value: next };
        onChange();
      }
    },
  ), [versionRef.current]);
  const getSnapshot = useCallback(() => snapshotRef.current!.value, []);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function defaultEquals<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((value, index) => Object.is(value, b[index]));
}
