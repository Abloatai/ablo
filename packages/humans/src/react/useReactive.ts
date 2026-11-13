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
 * Each computation has its own observation. A suspended render cannot replace
 * the computation used by the committed tree's subscription. Reactions start
 * only on subscription, so abandoned renders retain no store observers.
 * Pass a stable `compute` (module-level or `useCallback`): a new function
 * identity starts a new observation, re-subscribing and re-snapshotting.
 */
export function useReactive<T>(compute: () => T, options: ObservationOptions<T> = {}): T {
  const { equals = equalSnapshots, subscribe, serverSnapshot = compute } = options;
  const committed = useRef<{ value: T } | null>(null);
  const observation = useMemo(() => {
    let cached = committed.current;
    // True while the live reaction has the cache up to date with every observable
    // the selector read. Renders then reuse it instead of re-snapshotting.
    let current = false;
    let server: { value: T } | null = null;
    const failed = Symbol('selector error');
    const fresh = (): T => {
      const next = snapshotValue(compute());
      if (cached === null || !equals(cached.value, next)) cached = { value: next };
      return cached.value;
    };
    return {
      read: (): T => (current && cached !== null ? cached.value : fresh()),
      readServer: (): T => {
        server ??= { value: snapshotValue(serverSnapshot()) };
        return server.value;
      },
      subscribe: (notify: () => void): (() => void) => {
        const stop = reaction(
          () => {
            // Notify React of selector failures; React re-reads and delivers the
            // exception to its error boundary instead of MobX swallowing it.
            try { const value = fresh(); current = true; return value; } catch { current = false; return failed; }
          },
          () => { notify(); },
        );
        // External changes are invisible to MobX, so the next read recomputes.
        const external = () => { current = false; notify(); };
        let stopExternal: (() => void) | undefined;
        try { stopExternal = subscribe?.(external); } catch (error) { stop(); current = false; throw error; }
        return () => { stop(); current = false; stopExternal?.(); };
      },
    };
  }, [compute, equals, subscribe, serverSnapshot]);
  // Unsubscribed reads (render before commit) recompute from the store. While
  // subscribed, the reaction refreshes the snapshot on each tracked change, so
  // React's per-render getSnapshot calls return the cached, identity-stable value.
  const value = useSyncExternalStore(observation.subscribe, observation.read, observation.readServer);
  useEffect(() => { committed.current = { value }; }, [value]);
  return value;
}
