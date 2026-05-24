/**
 * Module-level context accessor
 *
 * Set once during SDK initialization via `initSyncEngine(context)`.
 * All internal SDK files access dependencies through `getContext()`.
 * This avoids threading context through every constructor.
 */

import type { SyncEngineContext } from './SyncEngineContext.js';
import {
  noopLogger,
  noopObservability,
  browserOnlineStatus,
  defaultSessionErrorDetector,
  emptyConfig,
} from './SyncEngineContext.js';

let _context: SyncEngineContext | null = null;

/**
 * Initialize the sync engine with application-provided dependencies.
 * Must be called before any sync engine operations.
 */
export function initSyncEngine(context: SyncEngineContext): void {
  _context = context;
}

/**
 * Get the current sync engine context.
 * Returns a safe fallback with no-op implementations if not yet initialized,
 * so SDK files can import at module load time without crashing.
 */
export function getContext(): SyncEngineContext {
  if (!_context) {
    return _fallback;
  }
  return _context;
}

/**
 * Check if the sync engine has been initialized.
 */
export function isSyncEngineInitialized(): boolean {
  return _context !== null;
}

/**
 * Reset context (for testing or cleanup).
 */
export function resetSyncEngine(): void {
  _context = null;
}

/** Fallback context with no-op implementations */
const _fallback: SyncEngineContext = {
  logger: noopLogger,
  observability: noopObservability,
  onlineStatus: browserOnlineStatus,
  sessionErrorDetector: defaultSessionErrorDetector,
  config: emptyConfig,
  mutationExecutor: {
    commit: () => Promise.resolve({ lastSyncId: 0 }),
    executeCreate: () => Promise.resolve(),
    executeUpdate: () => Promise.resolve(null),
    executeDelete: () => Promise.resolve(),
    executeArchive: () => Promise.resolve(),
    executeUnarchive: () => Promise.resolve(),
  },
  mutationDispatcher: {
    dispatch: () => Promise.resolve(),
  },
};
