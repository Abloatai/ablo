'use client';

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { reaction } from 'mobx';
import { equalSnapshots, snapshotValue } from './snapshot.js';

interface ObservationOptions<T> {
  equals?: (a: T, b: T) => boolean;
  subscribe?: (listener: () => void) => () => void;
  serverSnapshot?: () => T;
}

/**
 * Each render's computation has its own observation. A suspended render cannot
 * replace the computation used by the committed tree's subscription. Reactions
 * start only on subscription, so abandoned renders retain no store observers.
 */
export function useReactive<T>(compute: () => T, options: ObservationOptions<T> = {}): T {
  const { equals = equalSnapshots, subscribe, serverSnapshot = compute } = options;
  const committed = useRef<{ value: T } | null>(null);
  const observation = useMemo(() => {
    let cached = committed.current;
    let server: { value: T } | null = null;
    const failed = Symbol('selector error');
    const read = (): T => {
      const next = snapshotValue(compute());
      if (cached === null || !equals(cached.value, next)) cached = { value: next };
      return cached.value;
    };
    return {
      read,
      readServer: (): T => {
        server ??= { value: snapshotValue(serverSnapshot()) };
        return server.value;
      },
      subscribe: (notify: () => void): (() => void) => {
        const stop = reaction(
          () => {
            // Notify React of selector failures; React re-reads and delivers the
            // exception to its error boundary instead of MobX swallowing it.
            try { return read(); } catch { return failed; }
          },
          () => { notify(); },
        );
        let stopExternal: (() => void) | undefined;
        try { stopExternal = subscribe?.(notify); } catch (error) { stop(); throw error; }
        return () => { stop(); stopExternal?.(); };
      },
    };
  }, [compute, equals, subscribe, serverSnapshot]);
  // read() recomputes from the actual store, including React's consistency
  // checks between render and commit, while equal snapshots retain identity.
  const value = useSyncExternalStore(observation.subscribe, observation.read, observation.readServer);
  useEffect(() => { committed.current = { value }; }, [value]);
  return value;
}
