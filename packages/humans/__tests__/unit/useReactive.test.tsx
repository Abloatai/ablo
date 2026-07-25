/**
 * @jest-environment jsdom
 *
 * Regression tests for useReactive's subscription model.
 *
 * The hook was changed to stop tearing down + recreating its MobX reaction on
 * every render (the previous code keyed re-subscription on the inline-arrow
 * `compute` identity, which churns at virtually every call site). The reaction
 * is now created once and reads the latest `compute` via a ref, only
 * re-subscribing when a source swap actually changes the value.
 *
 * These tests lock in the behavior that change must preserve: value reactivity
 * across many host re-renders, structural-array identity stability, and correct
 * re-tracking when a memoized compute swaps its observable source.
 */

import { renderHook, act } from '@testing-library/react';
import { observable, runInAction } from 'mobx';

import { useReactive } from '../../src/useReactive.js';

describe('useReactive', () => {
  it('tracks a scalar observable and updates on change', () => {
    const store = observable({ count: 0 });
    const { result } = renderHook(() => useReactive(() => store.count));

    expect(result.current).toBe(0);
    act(() => {
      runInAction(() => {
        store.count = 5;
      });
    });
    expect(result.current).toBe(5);
  });

  it('keeps tracking across host re-renders that each pass a fresh compute', () => {
    // The core regression guard: the reaction is created once and never torn
    // down on re-render, yet observable changes must still propagate because the
    // reaction expression dereferences the latest compute through a ref.
    const store = observable({ count: 0 });
    const { result, rerender } = renderHook(() => useReactive(() => store.count));

    for (let i = 0; i < 5; i++) rerender();
    expect(result.current).toBe(0);

    act(() => {
      runInAction(() => {
        store.count = 9;
      });
    });
    expect(result.current).toBe(9);

    rerender();
    rerender();
    act(() => {
      runInAction(() => {
        store.count = 10;
      });
    });
    expect(result.current).toBe(10);
  });

  it('preserves array reference identity when contents are unchanged', () => {
    const store = observable({ items: [1, 2, 3] });
    const { result, rerender } = renderHook(() => useReactive(() => store.items.slice()));

    const first = result.current;
    expect(first).toEqual([1, 2, 3]);

    // A re-render recomputes a fresh `.slice()` array, but structural equality
    // (length + per-element Object.is) keeps the prior reference.
    rerender();
    expect(result.current).toBe(first);

    // A real content change yields a new reference.
    act(() => {
      runInAction(() => {
        store.items.push(4);
      });
    });
    expect(result.current).not.toBe(first);
    expect(result.current).toEqual([1, 2, 3, 4]);
  });

  it('re-tracks when a memoized compute swaps its observable source', () => {
    const a = observable({ v: 'a0' });
    const b = observable({ v: 'b0' });
    const computeA = () => a.v;
    const computeB = () => b.v;

    const { result, rerender } = renderHook(
      ({ compute }: { compute: () => string }) => useReactive(compute),
      { initialProps: { compute: computeA } },
    );
    expect(result.current).toBe('a0');

    // Swap the source: the value changes (a0 -> b0), which re-subscribes.
    rerender({ compute: computeB });
    expect(result.current).toBe('b0');

    // Changes to the NEW source propagate.
    act(() => {
      runInAction(() => {
        b.v = 'b1';
      });
    });
    expect(result.current).toBe('b1');

    // Changes to the OLD source no longer affect output.
    act(() => {
      runInAction(() => {
        a.v = 'aX';
      });
    });
    expect(result.current).toBe('b1');
  });
});
