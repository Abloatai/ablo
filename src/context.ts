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
    commit: () => Promise.resolve({ lastSyncId: 0, status: 'confirmed' as const }),
    executeCreate: () => Promise.resolve(),
    executeUpdate: () => Promise.resolve(null),
    executeDelete: () => Promise.resolve(),
    executeArchive: () => Promise.resolve(),
    executeUnarchive: () => Promise.resolve(),
  },
};
