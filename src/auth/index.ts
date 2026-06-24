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

import {
  type CapabilityExchangeResponse,
  type EphemeralKeyResponse,
  type IdentityResolveResponse,
  parseCapabilityExchangeResponse,
  parseEphemeralKeyResponse,
  parseIdentityResolveResponse,
} from './schemas.js';
import { AbloAuthenticationError, hasWireCode, translateHttpError } from '../errors.js';

export type {
  CapabilityExchangeResponse,
  EphemeralKeyResponse,
  IdentityResolveResponse,
} from './schemas.js';

export interface ExchangeApiKeyRequest {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly participantKind: 'user' | 'agent' | 'system';
  readonly participantId?: string;
  readonly syncGroups?: readonly string[];
  readonly operations?: readonly string[];
  /**
   * Bypass narrow-by-default scoping (admin/apikey callers only). SDK-internal:
   * only the startup exchange (`identity.ts` `resolveHosted`) sets it. Stripped
   * from the published `.d.ts` (`stripInternal`) — agents read declaration
   * files as API, and this flag advertised an escalation knob consumers should
   * never reach for (`sessions.create` scopes via `can` + `syncGroups`).
   * @internal
   */
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
      'No API key found. Set ABLO_API_KEY in your environment — `npx ablo login` ' +
        'then `npx ablo dev` writes it into .env.local for you — or pass ' +
        '`apiKey` to Ablo({ ... }) directly.',
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
    // Route through the canonical wire-error translator so the server's
    // envelope (`code` + `message` + `doc_url`) propagates verbatim and maps to
    // the right AbloError subclass — instead of the legacy `error`/`reason`
    // shape this used to read (which the server no longer emits, collapsing
    // every failure to a generic code with an empty message). Fall back to
    // `exchange_failed` only when the body carried no recognizable code.
    const requestId = response.headers.get('x-request-id') ?? undefined;
    throw hasWireCode(body)
      ? translateHttpError(response.status, body, requestId)
      : new AbloAuthenticationError(
          `apiKey exchange rejected (${response.status})`,
          { code: 'exchange_failed', httpStatus: response.status },
        );
  }

  return parseCapabilityExchangeResponse(await response.json());
}

// ─────────────────────────────────────────────────────────────────────

export interface MintUserSessionRequest {
  /** The ORIGINAL secret (`sk_`) key — control-plane calls always present it,
   *  never the exchanged sync credential. */
  readonly apiKey: string;
  readonly baseUrl: string;
  /** The end user's external IdP id — becomes the session's `participantId`. */
  readonly userId: string;
  /** Target org for a cross-org (platform) mint — the Stripe-Connect
   *  `Stripe-Account` analogue. Requires the `sk_` to carry
   *  `ephemeral:mint-any-org`; omit to mint into the key's own org. */
  readonly organizationId?: string;
  /** SHARED SCHEMA — point this session's SCHEMA at the project that owns it,
   *  while its DATA stays scoped to `organizationId`. Use this for org-per-customer
   *  isolation: keep one schema project, and every customer's session resolves its
   *  schema from it instead of re-pushing the schema into each customer's org.
   *  Requires the `sk_` to carry `ephemeral:mint-any-org`. Omit for the default
   *  (the session resolves its schema from its own org). */
  readonly schemaProject?: {
    /** The org that owns the schema project. */
    readonly organizationId: string;
    /** The project the schema was pushed under. */
    readonly projectId: string;
  };
  readonly syncGroups?: readonly string[];
  readonly ttlSeconds: number;
  readonly label?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * Mint an END-USER session key (`ek_`) via `POST /auth/ephemeral-keys` — the
 * sk_-gated user-session door. This is deliberately a DIFFERENT endpoint from
 * `/auth/capability`: that route can never mint humans (its
 * `invalid_participant_kind` gate is what fired in the 2026-06-11 Pulse
 * cascade, when `sessions.create({ user })` was funneled through the agent
 * door). The server trusts the `ek_` because a secret key minted it; the
 * browser presents it as its bearer.
 */
export async function mintUserSessionKey(
  options: MintUserSessionRequest,
): Promise<EphemeralKeyResponse> {
  if (!options.apiKey) {
    throw new AbloAuthenticationError(
      'No API key found. Set ABLO_API_KEY in your environment or pass `apiKey` ' +
        'to Ablo({ ... }) directly — user sessions are minted by your backend.',
      { code: 'apikey_missing' },
    );
  }
  if (!options.baseUrl) {
    throw new AbloAuthenticationError(
      'baseUrl is required for user-session mint',
      { code: 'base_url_missing' },
    );
  }

  const fetcher = options.fetch ?? fetch;
  const url = `${options.baseUrl.replace(/\/+$/, '')}/auth/ephemeral-keys`;
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
        user: { id: options.userId },
        ...(options.organizationId ? { organizationId: options.organizationId } : {}),
        // Flattened to the existing wire keys — the public param is project-centric,
        // the transport contract is unchanged (no coordinated server deploy needed).
        ...(options.schemaProject
          ? {
              schemaProjectId: options.schemaProject.projectId,
              schemaOwnerOrgId: options.schemaProject.organizationId,
            }
          : {}),
        ...(options.syncGroups ? { syncGroups: options.syncGroups } : {}),
        ttlSeconds: options.ttlSeconds,
        ...(options.label ? { label: options.label } : {}),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new AbloAuthenticationError(
      `user-session mint failed: ${err instanceof Error ? err.message : String(err)}`,
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
    const requestId = response.headers.get('x-request-id') ?? undefined;
    throw hasWireCode(body)
      ? translateHttpError(response.status, body, requestId)
      : new AbloAuthenticationError(
          `user-session mint rejected (${response.status})`,
          { code: 'exchange_failed', httpStatus: response.status },
        );
  }

  return parseEphemeralKeyResponse(await response.json());
}

// ─────────────────────────────────────────────────────────────────────

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
    // Canonical envelope translation (see `exchangeApiKey` above). This is what
    // surfaces the sync-server's precise auth diagnosis — e.g.
    // `jwt_issuer_untrusted` with its full message — to the SDK consumer,
    // instead of collapsing every 401 to `identity_resolve_failed` with an
    // empty reason because the old parser looked for `error`/`reason` keys the
    // server doesn't emit.
    const requestId = response.headers.get('x-request-id') ?? undefined;
    throw hasWireCode(body)
      ? translateHttpError(response.status, body, requestId)
      : new AbloAuthenticationError(
          `identity resolve rejected (${response.status})`,
          { code: 'identity_resolve_failed', httpStatus: response.status },
        );
  }

  return parseIdentityResolveResponse(await response.json());
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
