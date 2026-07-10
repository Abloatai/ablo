/**
 * React testing helpers for this package. They wire the package's
 * `SyncProvider` into `@testing-library/react` so you can test components
 * and hooks built on `useModel`, `useModels`, and `useMutations` against a
 * mock store, with no live server.
 */

import * as React from 'react';

import { SyncProvider, type SyncStoreContract } from '../../react/context.js';
import { MockSyncStore, createMockSyncStore } from '../mocks/MockSyncStore.js';

export interface TestWrapperOptions {
  /** Mock sync store. If omitted, a new MockSyncStore is created. */
  store?: SyncStoreContract;
  /** Organization ID. Default: "test-org-id". */
  organizationId?: string;
}

/**
 * Builds a wrapper component for `@testing-library/react`'s `renderHook`
 * and `render`. It wraps the children in the package's `SyncProvider`,
 * backed by a mock store, so the hooks and components under test can read
 * from it. Pass your own store to seed specific data, or let one be created.
 *
 * @example
 * import { renderHook } from '@testing-library/react';
 * import { createReactTestWrapper, createMockSyncStore } from '@abloatai/ablo/testing';
 *
 * const mockStore = createMockSyncStore();
 * mockStore.setModels(Task, [task1, task2]);
 *
 * const { result } = renderHook(
 *   () => useModels(Task),
 *   { wrapper: createReactTestWrapper({ store: mockStore }) }
 * );
 */
export function createReactTestWrapper(
  options: TestWrapperOptions = {}
): React.FC<{ children: React.ReactNode }> {
  const store = options.store ?? createMockSyncStore();
  const organizationId = options.organizationId ?? 'test-org-id';

  const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
    React.createElement(SyncProvider, { store, organizationId }, children);

  return Wrapper;
}

/**
 * A drop-in replacement for `@testing-library/react`'s `renderHook` that
 * wraps the hook in the package's `SyncProvider` and a mock store for you,
 * so you don't build the wrapper by hand.
 *
 * `@testing-library/react` is loaded lazily, so projects that don't use
 * these helpers never have to install it.
 *
 * @example
 * import { renderSyncHook, createMockSyncStore } from '@abloatai/ablo/testing';
 *
 * const mockStore = createMockSyncStore();
 * mockStore.addModel(Task, myTask);
 *
 * const { result } = renderSyncHook(
 *   () => useModel(Task, myTask.id),
 *   { store: mockStore }
 * );
 * expect(result.current?.id).toBe(myTask.id);
 */
export function renderSyncHook<TProps, TResult>(
  callback: (props: TProps) => TResult,
  options: TestWrapperOptions & { initialProps?: TProps } = {}
): {
  result: { current: TResult };
  rerender: (props?: TProps) => void;
  unmount: () => void;
} {
  // Load @testing-library/react lazily so projects that never call these
  // helpers don't have to install it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const rtl = require('@testing-library/react') as typeof import('@testing-library/react');
  return rtl.renderHook(callback, {
    wrapper: createReactTestWrapper(options),
    initialProps: options.initialProps,
  });
}

/**
 * Re-export MockSyncStore for convenience.
 */
export { MockSyncStore, createMockSyncStore };
