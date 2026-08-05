/**
 * Module-level accessor for the sync engine's runtime context.
 *
 * The context is set once, during initialization, by {@link initRuntime}.
 * Code throughout the package reaches its shared dependencies — logger,
 * observability, online-status detector, configuration, and the mutation
 * executor — through {@link getContext} instead of receiving them through every
 * constructor.
 */

import type { RuntimeContext } from './RuntimeContext.js';
import {
  noopLogger,
  noopObservability,
  browserOnlineStatus,
  defaultSessionErrorDetector,
  emptyConfig,
} from './RuntimeContext.js';

let _context: RuntimeContext | null = null;

/**
 * Install the caller-provided runtime dependencies. Must be called before any
 * operation that reaches {@link getContext}.
 */
export function initRuntime(context: RuntimeContext): void {
  _context = context;
}

/**
 * Get the current sync engine context.
 * Returns a safe fallback with no-op implementations if not yet initialized,
 * so SDK files can import at module load time without crashing.
 */
export function getContext(): RuntimeContext {
  if (!_context) {
    return _fallback;
  }
  return _context;
}

/**
 * The module-global runtime as an instance-shaped value — the bridge for code
 * that is not yet constructed with its client's own `RuntimeContext`.
 *
 * Every member reads {@link getContext} at call time, so a context installed
 * after construction is still picked up (tests construct first and
 * `initRuntime` later). Classes take `runtime` as a constructor option with
 * this as the default; a client that threads its own instance is isolated
 * from other clients in the same process, a construction that doesn't is
 * last-writer-wins exactly as before. Retired reference by reference as
 * construction moves behind `humans()` (docs/plans/package-split.md).
 */
export const globalRuntime: RuntimeContext = {
  get logger() { return getContext().logger; },
  get observability() { return getContext().observability; },
  get analytics() { return getContext().analytics; },
  get sessionErrorDetector() { return getContext().sessionErrorDetector; },
  get onlineStatus() { return getContext().onlineStatus; },
  get modelDebugLogger() { return getContext().modelDebugLogger; },
  get mutationExecutor() { return getContext().mutationExecutor; },
  get config() { return getContext().config; },
  getModelMetadata: (name) => getContext().getModelMetadata(name),
};

/**
 * Check if the sync engine has been initialized.
 */
export function isRuntimeInitialized(): boolean {
  return _context !== null;
}

/**
 * Reset context (for testing or cleanup).
 */
export function resetRuntime(): void {
  _context = null;
}

/** Fallback context with no-op implementations */
const _fallback: RuntimeContext = {
  logger: noopLogger,
  observability: noopObservability,
  onlineStatus: browserOnlineStatus,
  sessionErrorDetector: defaultSessionErrorDetector,
  config: emptyConfig,
  getModelMetadata: () => undefined,
  mutationExecutor: {
    commit: () => Promise.resolve({
      status: 'confirmed' as const,
      statusAt: '1970-01-01T00:00:00.000Z',
      lastSyncId: 0,
    }),
    executeCreate: () => Promise.resolve(),
    executeUpdate: () => Promise.resolve(null),
    executeDelete: () => Promise.resolve(),
    executeArchive: () => Promise.resolve(),
    executeUnarchive: () => Promise.resolve(),
  },
};
