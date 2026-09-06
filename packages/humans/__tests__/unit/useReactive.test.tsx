/** @jest-environment jsdom */

import { renderHook, render, fireEvent, act } from '@testing-library/react';
import { observable, onBecomeObserved, onBecomeUnobserved, runInAction } from 'mobx';

import { Component, type ReactNode, Suspense, startTransition, useLayoutEffect, useState } from 'react';

import { renderToString } from 'react-dom/server';

import { useReactive } from '../../src/react/useReactive.js';

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
  it('sees a mutation between render and subscription', () => {
    const store = observable({ count: 0 });
    const { result } = renderHook(() => {
      useLayoutEffect(() => { runInAction(() => { store.count = 1; }); }, []);
      return useReactive(() => store.count);
    });
    expect(result.current).toBe(1);
  });

  it('detaches nested snapshot data and keeps unchanged selections stable', () => {
    const store = observable({ item: { title: 'Before' }, unrelated: 0 });
    const { result, rerender } = renderHook(() => useReactive(() => ({ item: store.item })));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    act(() => { runInAction(() => { store.unrelated++; }); });
    expect(result.current).toBe(first);
    act(() => { runInAction(() => { store.item.title = 'After'; }); });
    expect(first.item.title).toBe('Before');
    expect(result.current.item.title).toBe('After');
    expect(Object.isFrozen(result.current.item)).toBe(true);
  });

  it('does not let an abandoned render retarget the visible subscription', async () => {
    const a = observable({ value: 0 });
    const b = observable({ value: 0 });
    const selectA = () => a.value;
    const selectB = () => b.value;
    const pending = new Promise<void>(() => { /* Keep the transition suspended. */ });
    function Value({ source }: { source: 'a' | 'b' }) {
      const value = useReactive(source === 'a' ? selectA : selectB);
      // React Suspense deliberately uses a thrown promise to abandon this render.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      if (source === 'b') throw pending;
      return <span>{source}:{value}</span>;
    }
    function App() {
      const [source, setSource] = useState<'a' | 'b'>('a');
      return <><button onClick={() => { startTransition(() => { setSource('b'); }); }}>Switch</button>
        <Suspense fallback="Loading"><Value source={source} /></Suspense></>;
    }
    const view = render(<App />);
    await act(async () => {
      fireEvent.click(view.getByRole('button'));
      await Promise.resolve(); // Let the transition attempt its suspended render.
    });
    expect(view.getByText('a:0')).toBeTruthy();
    act(() => { runInAction(() => { a.value = 1; }); });
    expect(view.getByText('a:1')).toBeTruthy();
  });

  it('retargets equal-valued sources and releases observers on unmount', () => {
    const a = observable({ value: 0 });
    const b = observable({ value: 0 });
    const released = jest.fn();
    const stopWatching = onBecomeUnobserved(b, 'value', released);
    const { result, rerender, unmount } = renderHook(
      ({ source }) => useReactive(() => source.value), { initialProps: { source: a } },
    );
    rerender({ source: b });
    act(() => { runInAction(() => { a.value = 1; }); });
    expect(result.current).toBe(0);
    act(() => { runInAction(() => { b.value = 2; }); });
    expect(result.current).toBe(2);
    released.mockClear();
    unmount();
    expect(released).toHaveBeenCalledTimes(1);
    stopWatching();
  });

  it('does not retain store observers during server rendering', () => {
    const store = observable({ value: 42 });
    const observed = jest.fn();
    const stop = onBecomeObserved(store, 'value', observed);
    function Value() { return <span>{useReactive(() => store.value)}</span>; }
    expect(renderToString(<Value />)).toContain('42');
    expect(observed).not.toHaveBeenCalled();
    stop();
  });

  it('delivers selector failures to the React error boundary', () => {
    const store = observable({ fail: false });
    class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
      override state = { error: null as Error | null };
      static getDerivedStateFromError(error: Error) { return { error }; }
      override render() { return this.state.error ? <span>{this.state.error.message}</span> : this.props.children; }
    }
    function Value() {
      const value = useReactive(() => {
        if (store.fail) throw new Error('Selection failed');
        return 'Ready';
      });
      return <span>{value}</span>;
    }
    const view = render(<Boundary><Value /></Boundary>, { onCaughtError: () => undefined });
    expect(view.getByText('Ready')).toBeTruthy();
    act(() => { runInAction(() => { store.fail = true; }); });
    expect(view.getByText('Selection failed')).toBeTruthy();
  });

});
