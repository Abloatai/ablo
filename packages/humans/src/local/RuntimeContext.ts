/**
 * RuntimeContext — Runtime dependency container
 *
 * All SDK classes receive this context at construction time.
 * It bundles every injectable dependency so constructors stay clean.
 */

import type {
  Logger,
  ObservabilityProvider,
  Analytics,
  SessionErrorDetector,
  OnlineStatusProvider,
  ModelDebugLoggerContract,
  MutationExecutor,
  RuntimeConfig,
  BreadcrumbLevel,
  BreadcrumbCategory,
  SpanAttributes,
} from './interfaces/index.js';
import type { ModelMetadata } from '@abloatai/transaction/types';
import { AbloSessionError } from '@abloatai/transaction/errors';

export interface RuntimeContext {
  /** Structured logger */
  logger: Logger;

  /** Error tracking & performance monitoring */
  observability: ObservabilityProvider;

  /** Product analytics (optional) */
  analytics?: Analytics;

  /** Session error detection for auth redirect decisions */
  sessionErrorDetector: SessionErrorDetector;

  /** Network connectivity detection */
  onlineStatus: OnlineStatusProvider;

  /** Model operation debug logging (optional, dev-only) */
  modelDebugLogger?: ModelDebugLoggerContract;

  /** Backend mutation transport (GraphQL, REST, etc.) */
  mutationExecutor: MutationExecutor;

  /** Application-specific sync configuration */
  config: RuntimeConfig;

  /**
   * Model metadata lookup. Injected by the client (it wires this from its
   * `ModelRegistry`) so the confirmation core can resolve a model's metadata
   * without importing the registry — the dependency inversion that keeps the
   * core free of the client's `Model` layer (ADR 0013).
   */
  getModelMetadata: (name: string) => ModelMetadata | undefined;
}

// ─────────────────────────────────────────────
// No-op defaults for optional dependencies
// ─────────────────────────────────────────────

// Re-exported, not redeclared. `@abloatai/transaction/logger` owns the no-op that
// sits beside the `Logger` port. This package held a second, behaviourally
// identical copy, and half of it imported the canonical one while the other
// half imported this — so any change of semantics there would have reached
// only one side, invisibly, because the identifier reads the same at both.
export { noopLogger } from '@abloatai/transaction/logger';

/** No-op observability — silently discards all observability calls */
export const noopObservability: ObservabilityProvider = {
  setContext() {},
  setConnectionState() {},
  breadcrumb() {},
  captureRollback() {},
  captureMutationFailure() {},
  captureBootstrapFailure() {},
  captureReconciliation() {},
  captureDeltaRetryExhausted() {},
  captureWebSocketError() {},
  captureSelfHealing() {},
  captureClaim() {},
  captureConflict() {},
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
export const noopAnalytics: Analytics = {
  capture() {},
};

/** Browser-native online status provider */
export const browserOnlineStatus: OnlineStatusProvider = {
  isOnline(): boolean {
    // Only `navigator.onLine === false` is the MDN-reliable "definitely offline"
    // signal. Don't use `!navigator.onLine`: Node 18+ exposes a global
    // `navigator` whose `onLine` is `undefined`, which `!` would read as offline —
    // wedging every Node/server client (agents, worker, MCP) into a false offline.
    // DOM types say `onLine` is boolean, but Node exposes it as undefined.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare
    return !(typeof navigator !== 'undefined' && navigator.onLine === false);
  },
};

/** Session error detector — delegates to AbloSessionError so detection is
 *  code-aware (only genuine session/JWT expiry counts), not a blunt 401/403. */
export const defaultSessionErrorDetector: SessionErrorDetector = {
  isSessionError(error: unknown): boolean {
    if (error && typeof error === 'object' && 'isSessionError' in error) {
      return (error as { isSessionError: boolean }).isSessionError;
    }
    return false;
  },
  isSessionErrorResponse(status: number, body?: string): boolean {
    return AbloSessionError.isSessionErrorResponse(status, body);
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
export const emptyConfig: RuntimeConfig = {
  modelCreatePriority: new Map(),
  defaultCreatePriority: 40,
  defaultNonCreatePriority: 50,
  essentialFields: {},
  classNameFallbackMap: {},
};
