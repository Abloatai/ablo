/**
 * Internal apiKey → capability exchange.
 *
 * Called by the `Ablo({...})` factory's `ready()` flow when the
 * consumer passed `apiKey` without an explicit `capabilityToken` /
 * `organizationId` / `user.id`. SDK calls `/auth/capability` once,
 * server returns the scope + userMeta blobs (Phases 1A + 1B),
 * SDK populates internal state from the response.
 *
 * Consumer never sees this happen. Same shape as Stripe / Anthropic
 * SDKs hide their internal auth-handshake — the apiKey is the only
 * credential the consumer touches.
 */

import { AbloAuthenticationError } from '../errors.js';
import type { ErrorCode } from '../errorCodes.js';

/** Server response shape — matches Phase 1A + 1B wire output. */
export interface CapabilityExchangeResponse {
  readonly capabilityId: string;
  readonly token: string;
  readonly expiresAt: string;
  readonly organizationId: string;
  readonly scope: {
    readonly organizationId: string;
    readonly syncGroups: readonly string[];
    readonly operations: readonly string[];
    readonly participantKind: 'user' | 'agent' | 'system';
    readonly participantId: string;
  };
  readonly userMeta: Record<string, unknown>;
}

export interface ExchangeApiKeyRequest {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly participantKind: 'user' | 'agent' | 'system';
  readonly participantId?: string;
  readonly syncGroups?: readonly string[];
  readonly operations?: readonly string[];
  readonly wideScope?: boolean;
  readonly ttlSeconds: number;
  readonly label?: string;
  readonly userMeta?: Record<string, unknown>;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export async function exchangeApiKey(
  options: ExchangeApiKeyRequest,
): Promise<CapabilityExchangeResponse> {
  if (!options.apiKey) {
    throw new AbloAuthenticationError(
      'apiKey is required for capability exchange',
      { code: 'apikey_missing' },
    );
  }
  if (!options.baseUrl) {
    throw new AbloAuthenticationError(
      'baseUrl is required for capability exchange',
      { code: 'base_url_missing' },
    );
  }

  const fetcher = options.fetch ?? fetch;
  const url = `${options.baseUrl.replace(/\/+$/, '')}/auth/capability`;
  const timeoutMs = options.timeoutMs ?? 10_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        participantKind: options.participantKind,
        ...(options.participantId ? { participantId: options.participantId } : {}),
        syncGroups: options.syncGroups,
        operations: options.operations,
        wideScope: options.wideScope,
        ttlSeconds: options.ttlSeconds,
        label: options.label,
        userMeta: options.userMeta,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new AbloAuthenticationError(
      `apiKey exchange failed: ${err instanceof Error ? err.message : String(err)}`,
      { code: 'exchange_network_error', cause: err },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // ignore — server returned non-JSON error
    }
    const errBody = body as { error?: string; reason?: string } | null;
    throw new AbloAuthenticationError(
      `apiKey exchange rejected (${response.status}): ${errBody?.reason ?? response.statusText}`,
      {
        code: (errBody?.error as ErrorCode | undefined) ?? 'exchange_failed',
        httpStatus: response.status,
      },
    );
  }

  const raw = (await response.json()) as unknown;
  if (!isCapabilityExchangeResponse(raw)) {
    throw new AbloAuthenticationError(
      'apiKey exchange response was malformed — missing required fields',
      { code: 'exchange_malformed_response' },
    );
  }

  return raw;
}

function isCapabilityExchangeResponse(
  raw: unknown,
): raw is CapabilityExchangeResponse {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  if (typeof o.token !== 'string') return false;
  if (typeof o.expiresAt !== 'string') return false;
  if (typeof o.organizationId !== 'string') return false;
  if (typeof o.scope !== 'object' || o.scope === null) return false;
  if (typeof o.userMeta !== 'object' || o.userMeta === null) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────

export interface IdentityResolveResponse {
  readonly participantKind: 'user' | 'agent' | 'system';
  readonly participantId: string;
  readonly accountScope: string;
  readonly syncGroups: readonly string[];
  readonly userMeta: Record<string, unknown>;
}

export interface ResolveIdentityRequest {
  readonly baseUrl: string;
  readonly authToken?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * Resolve the caller's Ablo identity from the authenticated request
 * context. Used by browser/session/capability flows where the SDK should
 * not require a public `userId` prop just to open local storage.
 */
export async function resolveIdentity(
  options: ResolveIdentityRequest,
): Promise<IdentityResolveResponse> {
  if (!options.baseUrl) {
    throw new AbloAuthenticationError('baseUrl is required for identity resolve', {
      code: 'base_url_missing',
    });
  }

  const fetcher = options.fetch ?? fetch;
  const url = `${options.baseUrl.replace(/\/+$/, '')}/auth/identity`;
  const timeoutMs = options.timeoutMs ?? 10_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.authToken) {
      headers.Authorization = `Bearer ${options.authToken}`;
    }
    response = await fetcher(url, {
      method: 'GET',
      headers,
      credentials: 'include',
      signal: controller.signal,
    });
  } catch (err) {
    throw new AbloAuthenticationError(
      `identity resolve failed: ${err instanceof Error ? err.message : String(err)}`,
      { code: 'identity_network_error', cause: err },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // ignore non-JSON auth errors
    }
    const errBody = body as { error?: string; reason?: string } | null;
    throw new AbloAuthenticationError(
      `identity resolve rejected (${response.status}): ${errBody?.reason ?? response.statusText}`,
      {
        code: (errBody?.error as ErrorCode | undefined) ?? 'identity_resolve_failed',
        httpStatus: response.status,
      },
    );
  }

  return (await response.json()) as IdentityResolveResponse;
}

// ─────────────────────────────────────────────────────────────────────

/**
 * Capability-token refresh scheduler.
 *
 * Long-lived `@abloatai/ablo` clients hold a server-issued capability
 * token whose TTL (1h default) is shorter than typical browser sessions.
 * Without proactive refresh, the WebSocket would either be force-closed
 * by the server at expiry (code 1008) or fail its next reconnect with
 * 401. Either way the user sees a mid-session disconnect.
 *
 * This scheduler keeps the token fresh transparently. Three triggers,
 * one refresh path:
 *
 *   1. Proactive  — `setTimeout` for `(expiresAtMs - bufferMs - now)`.
 *   2. Visibility — on `document.visibilitychange→visible`, if the
 *                   token is within the buffer window, refresh now.
 *                   Defends against dormant-tab `setTimeout` throttling.
 *   3. Reactive   — caller invokes `.refreshNow()` on observed auth
 *                   failure (WS close 1008/4001 etc).
 *
 * All three resolve through the same `inFlight` promise so concurrent
 * triggers don't double-mint. On any successful refresh the new
 * `expiresAtMs` is captured and trigger 1 is rescheduled.
 *
 * Buffer policy: `max(60s, ttl/10)` — for a 1h TTL that's 360s, which
 * matches the AWS SDK / MSAL.js de-facto 5-minute standard while
 * scaling sensibly for shorter TTLs.
 */

export interface RefreshSchedulerOptions {
  /** Initial absolute expiry, ms since epoch (server-supplied). */
  readonly initialExpiresAtMs: number;

  /**
   * Performs the actual exchange. Returns the new expiry. Errors
   * propagate to `onError`; the scheduler stays alive and retries on
   * next trigger (no exponential backoff in v1 — most failures here are
   * the user's apiKey being revoked, in which case retrying is futile).
   */
  readonly refresh: () => Promise<{ expiresAtMs: number }>;

  /** Called on every successful refresh. */
  readonly onRefreshed?: (info: { expiresAtMs: number }) => void;

  /** Called on every refresh failure. */
  readonly onError?: (error: Error) => void;

  /**
   * Override the buffer (ms ahead of expiry to refresh). Defaults to
   * `max(60_000, ttlMs * 0.1)`. Tests use a tiny value to exercise
   * scheduling without burning real time.
   */
  readonly bufferMs?: number;

  /**
   * If true, install a `visibilitychange` listener on `document` that
   * triggers a refresh when the tab becomes visible and the token is
   * within the buffer window. No-op if `document` is undefined (Node).
   * Default: true in browser-ish environments.
   */
  readonly attachVisibilityListener?: boolean;

  /** Time source. Override in tests; defaults to `Date.now`. */
  readonly now?: () => number;

  /** Timer pair. Override in tests. */
  readonly setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface RefreshScheduler {
  /** Force a refresh now. Idempotent — concurrent calls share one promise. */
  refreshNow(): Promise<{ expiresAtMs: number }>;

  /** Stop scheduling. Safe to call multiple times. */
  dispose(): void;

  /** Current absolute expiry. Updated after each successful refresh. */
  readonly expiresAtMs: number;
}

const DEFAULT_BUFFER_FLOOR_MS = 60_000;
const DEFAULT_BUFFER_RATIO = 0.1;

export function createRefreshScheduler(
  options: RefreshSchedulerOptions,
): RefreshScheduler {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;

  let expiresAtMs = options.initialExpiresAtMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<{ expiresAtMs: number }> | null = null;
  let disposed = false;

  // Default visibility attach: only when running in a browser-like env.
  // The Node-side agent worker never has `document`, so the default
  // does the right thing without explicit opt-out.
  const wantsVisibility = options.attachVisibilityListener ?? true;
  const hasDocument = typeof document !== 'undefined';
  const visibilityActive = wantsVisibility && hasDocument;

  function bufferFor(currentExpiresAtMs: number): number {
    if (typeof options.bufferMs === 'number') return options.bufferMs;
    const ttl = currentExpiresAtMs - now();
    return Math.max(DEFAULT_BUFFER_FLOOR_MS, Math.floor(ttl * DEFAULT_BUFFER_RATIO));
  }

  function clearTimerIfAny(): void {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  function schedule(): void {
    if (disposed) return;
    clearTimerIfAny();
    const buffer = bufferFor(expiresAtMs);
    const delay = Math.max(0, expiresAtMs - buffer - now());
    timer = setTimer(() => {
      void refreshNow().catch(() => {
        // onError already fired inside refreshNow; swallow here so
        // the timer callback doesn't surface as an unhandled rejection.
      });
    }, delay);
  }

  function refreshNow(): Promise<{ expiresAtMs: number }> {
    if (disposed) {
      return Promise.reject(new Error('refreshScheduler: disposed'));
    }
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        const result = await options.refresh();
        if (disposed) return result;
        expiresAtMs = result.expiresAtMs;
        options.onRefreshed?.({ expiresAtMs });
        schedule();
        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        options.onError?.(error);
        // Reschedule even on failure so the next window still triggers.
        // The user's apiKey may have been temporarily unreachable.
        if (!disposed) schedule();
        throw error;
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  }

  function onVisibilityChange(): void {
    if (disposed) return;
    if (typeof document === 'undefined') return;
    if (document.visibilityState !== 'visible') return;
    const buffer = bufferFor(expiresAtMs);
    if (expiresAtMs - now() <= buffer) {
      void refreshNow().catch(() => {
        // already routed through onError
      });
    }
  }

  if (visibilityActive) {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  schedule();

  return {
    refreshNow,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearTimerIfAny();
      if (visibilityActive) {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    },
    get expiresAtMs(): number {
      return expiresAtMs;
    },
  };
}
