/**
 * React test helpers for the sync engine SDK.
 *
 * These helpers wire the SDK's SyncProvider into @testing-library/react
 * so consumers can test components and hooks that use useModel/useModels/useMutations.
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
 * Create a wrapper component for @testing-library/react's renderHook/render.
 * Wraps children in the SDK's SyncProvider with a mock store.
 *
 * @example
 * import { renderHook } from '@testing-library/react';
 * import { createReactTestWrapper, createMockSyncStore } from '@ablo/sync-engine/testing';
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
 * Drop-in replacement for @testing-library/react's `renderHook` that
 * automatically provides the SDK's SyncProvider with a mock store.
 *
 * Note: This helper lazy-loads @testing-library/react to avoid forcing
 * consumers without React tests to install it.
 *
 * @example
 * import { renderSyncHook, createMockSyncStore } from '@ablo/sync-engine/testing';
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
  // Lazy-load @testing-library/react so the SDK doesn't force consumers
  // to install it unless they actually use these helpers.
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
