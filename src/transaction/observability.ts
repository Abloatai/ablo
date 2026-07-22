/**
 * The observability the settlement core reports on its own behalf.
 *
 * Coordination outcomes — a claim changing state, a stale-write collision that
 * notified instead of aborting — happen with no UI and no local store anywhere,
 * so the core must be able to report them without depending on the consumer's
 * full provider (ADR 0016).
 *
 * This is deliberately the narrow set the core actually calls today. Widening it
 * later is non-breaking; the reactive engine's `ObservabilityProvider` extends
 * this interface, so a single implementation still satisfies both.
 */

import type { ClaimEvent, ConflictEvent } from './coordination/events.js';

export interface CoordinationObservability {
  /** Capture a claim state change (acquired / queued / granted / lost / rejected / expired). */
  captureClaim(event: ClaimEvent): void;

  /** Capture a notify-instead-of-abort stale-write collision. */
  captureConflict(event: ConflictEvent): void;
}

// ─────────────────────────────────────────────
// Transport observability
// ─────────────────────────────────────────────

/** Breadcrumb severity levels */
export type BreadcrumbLevel = 'debug' | 'info' | 'warning' | 'error';

/** Breadcrumb categories for sync engine lifecycle events */
export type BreadcrumbCategory =
  | 'sync.bootstrap'
  | 'sync.transaction'
  | 'sync.websocket'
  | 'sync.offline'
  | 'sync.database'
  | 'sync.conflict'
  | 'sync.coordination'
  | 'sync.groups';

export interface WebSocketErrorDetails {
  context: string;
  error?: string;
  code?: number;
  reason?: string;
}

/**
 * The observability the duplex transport reports on its own behalf: connection
 * lifecycle breadcrumbs and socket errors. A server-side agent holding a socket
 * for claim push has no store and no UI, so the transport must be able to
 * report without the consumer's full provider — the same reasoning as
 * {@link CoordinationObservability}, one layer down. The reactive engine's
 * `ObservabilityProvider` extends this interface, so a single implementation
 * satisfies both.
 */
export interface TransportObservability {
  /** Add a breadcrumb for sync lifecycle events */
  breadcrumb(
    message: string,
    category: BreadcrumbCategory,
    level?: BreadcrumbLevel,
    data?: Record<string, string | number | boolean | undefined>
  ): void;

  /** Capture WebSocket error */
  captureWebSocketError(details: WebSocketErrorDetails): void;
}

/**
 * Everything the duplex transport reports: its own lifecycle
 * ({@link TransportObservability}) plus the coordination outcomes that ride
 * the socket ({@link CoordinationObservability} — claim pushes and notified
 * collisions arrive as frames, so the transport is where they surface).
 */
export type SocketObservability = TransportObservability & CoordinationObservability;

/** The no-op default — what the transport reports through when nothing is wired. */
export const noopSocketObservability: SocketObservability = {
  breadcrumb() {},
  captureWebSocketError() {},
  captureClaim() {},
  captureConflict() {},
};
