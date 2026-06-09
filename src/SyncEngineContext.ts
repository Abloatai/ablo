/**
 * SyncEngineContext — Runtime dependency container
 *
 * All SDK classes receive this context at construction time.
 * It bundles every injectable dependency so constructors stay clean.
 */

import type {
  SyncLogger,
  SyncObservabilityProvider,
  SyncAnalytics,
  SessionErrorDetector,
  OnlineStatusProvider,
  ModelDebugLoggerContract,
  MutationExecutor,
  MutationDispatcher,
  SyncEngineConfig,
  BreadcrumbLevel,
  SyncBreadcrumbCategory,
  SpanAttributes,
} from './interfaces/index.js';
import { SyncSessionError } from './errors.js';

export interface SyncEngineContext {
  /** Structured logger */
  logger: SyncLogger;

  /** Error tracking & performance monitoring */
  observability: SyncObservabilityProvider;

  /** Product analytics (optional) */
  analytics?: SyncAnalytics;

  /** Session error detection for auth redirect decisions */
  sessionErrorDetector: SessionErrorDetector;

  /** Network connectivity detection */
  onlineStatus: OnlineStatusProvider;

  /** Model operation debug logging (optional, dev-only) */
  modelDebugLogger?: ModelDebugLoggerContract;

  /** Backend mutation transport (GraphQL, REST, etc.) */
  mutationExecutor: MutationExecutor;

  /** Offline mutation replay dispatcher */
  mutationDispatcher: MutationDispatcher;

  /** Application-specific sync configuration */
  config: SyncEngineConfig;
}

// ─────────────────────────────────────────────
// No-op defaults for optional dependencies
// ─────────────────────────────────────────────

/** No-op logger — silently discards all log calls */
export const noopLogger: SyncLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** No-op observability — silently discards all observability calls */
export const noopObservability: SyncObservabilityProvider = {
  setContext() {},
  setConnectionState() {},
  breadcrumb() {},
  captureRollback() {},
  captureTransactionFailure() {},
  captureBootstrapFailure() {},
  captureReconciliation() {},
  captureDeltaRetryExhausted() {},
  captureWebSocketError() {},
  captureOfflineFlushFailure() {},
  captureSelfHealing() {},
  captureCommitZeroSyncId() {},
  startSpan<T>(_name: string, _op: string, fn: () => T, _attributes?: SpanAttributes): T {
    return fn();
  },
  async startSpanAsync<T>(
    _name: string,
    _op: string,
    fn: () => Promise<T>,
    _attributes?: SpanAttributes
  ): Promise<T> {
    return fn();
  },
};

/** No-op analytics — silently discards all analytics calls */
export const noopAnalytics: SyncAnalytics = {
  capture() {},
};

/** Browser-native online status provider */
export const browserOnlineStatus: OnlineStatusProvider = {
  isOnline(): boolean {
    // Only `navigator.onLine === false` is the MDN-reliable "definitely offline"
    // signal. Don't use `!navigator.onLine`: Node 18+ exposes a global
    // `navigator` whose `onLine` is `undefined`, which `!` would read as offline —
    // wedging every Node/server client (agents, worker, MCP) into a false offline.
    return !(typeof navigator !== 'undefined' && navigator.onLine === false);
  },
};

/** Session error detector — delegates to SyncSessionError so detection is
 *  code-aware (only genuine session/JWT expiry counts), not a blunt 401/403. */
export const defaultSessionErrorDetector: SessionErrorDetector = {
  isSessionError(error: unknown): boolean {
    if (error && typeof error === 'object' && 'isSessionError' in error) {
      return (error as { isSessionError: boolean }).isSessionError === true;
    }
    return false;
  },
  isSessionErrorResponse(status: number, body?: string): boolean {
    return SyncSessionError.isSessionErrorResponse(status, body);
  },
};

/**
 * Fallback config used when the context is read before
 * `createSyncEngine(...)` has initialized it (tests, early-boot code
 * paths). An empty `modelCreatePriority` means every model falls through
 * to `defaultCreatePriority`, so ordering is flat — fine for tests that
 * never exercise FK ordering; consumers who do rely on it should finish
 * wiring the engine before the first `create()` fires.
 */
export const emptyConfig: SyncEngineConfig = {
  modelCreatePriority: new Map(),
  defaultCreatePriority: 40,
  defaultNonCreatePriority: 50,
  essentialFields: {},
  classNameFallbackMap: {},
};
