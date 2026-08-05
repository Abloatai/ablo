/**
 * Exchanges an API key for a capability token and the scope it grants.
 *
 * The `Ablo({...})` factory calls this during startup when you provide an
 * `apiKey` but no explicit capability token, organization, or user identity. It
 * sends one `POST /v1/capabilities` request; the server responds with the
 * granted scope and any user metadata, which the client uses to populate its
 * session state. The API key is the only credential you handle directly — this
 * exchange happens automatically behind it.
 */

import {
  type EphemeralKeyResponse,
  type IdentityResolveResponse,
  parseCapabilityMintResponse,
  parseEphemeralKeyResponse,
  parseIdentityResolveResponse,
} from './schemas.js';
import { AbloAuthenticationError, hasWireCode, translateHttpError } from '../errors.js';
import type { ParticipantKind } from '../types/participant.js';
import type {
  CapabilityMintResponse,
  GrantedOperation,
} from './capability.js';
export {
  ABLO_DEFAULT_BASE_URL,
  ABLO_HOSTED_API_DOMAIN,
  ABLO_HOSTED_HTTP_BASE_URL,
} from './hostedEndpoints.js';
export { normalizeAbloHostedBaseUrl } from './apiKey.js';

/**
 * @deprecated Use {@link CapabilityMintResponse}. This is a type-only,
 * one-release rename bridge; both names resolve to the same canonical Zod
 * contract and no runtime parser or schema is duplicated.
 */
export type CapabilityExchangeResponse = CapabilityMintResponse;

export type {
  EphemeralKeyResponse,
  IdentityResolveResponse,
} from './schemas.js';
export { parseCapabilityMintResponse } from './schemas.js';
export {
  credentialEndpointErrorSchema,
  credentialEndpointKindSchema,
  credentialEndpointSuccessSchema,
  credentialEndpointErrorCode,
  parseCredentialEndpointSuccess,
} from './credentialEndpointProtocol.js';
export type {
  CredentialEndpointError,
  CredentialEndpointSuccess,
} from './credentialEndpointProtocol.js';
export type {
  CredentialProvider,
  CredentialProviderResult,
} from './credentialResult.js';
export {
  capabilityRotationRequestSchema,
  capabilityRotationResponseSchema,
  sessionRevocationResponseSchema,
  revokeCapability,
  rotateCapability,
} from './capabilityLifecycle.js';
export type {
  RevokeCapabilityRequest,
  RotateCapabilityRequest,
} from './capabilityLifecycle.js';

// The capability vocabulary — what a grant is, on both axes, in one place.
// Served from this barrel so every minter reaches it through one import.
export {
  capabilityOperationSchema,
  capabilityCanSchema,
  capabilityCanSchemaFor,
  effectiveAuthoritySchema,
  capabilityScopeSchema,
  capabilityRequestSchema,
  capabilityMintResponseSchema,
  grantedOperationSchema,
  grantedOperations,
  expandReadYourWrites,
  modelWireNames,
  capabilityModelAliases,
  unresolvableOperations,
} from './capability.js';
export type {
  CapabilityOperation,
  CapabilityCan,
  CapabilityGrant,
  EffectiveAuthority,
  CapabilityScope,
  CapabilityMintResponse,
  CapabilityRequest,
  CapabilityModelShape,
  GrantedOperation,
} from './capability.js';
// A re-export does not bind the name in this module, and the mint request type
// below needs it.
import type { CapabilityOperation } from './capability.js';

export interface ExchangeApiKeyRequest {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly participantKind: ParticipantKind;
  readonly participantId?: string;
  readonly organizationId?: string;
  readonly syncGroups?: readonly string[];
  /** The grant's verb axis, already in wire form. Build it with
   *  `grantedOperations(can)` rather than assembling `model.verb` by hand. */
  readonly operations?: readonly GrantedOperation[];
  /**
   * Grants a wider scope than the narrow-by-default behavior. This is an internal
   * escalation used only by the startup exchange; it is stripped from the
   * published type declarations and is not meant to be set by application code.
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
): Promise<CapabilityMintResponse> {
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
  const url = `${options.baseUrl.replace(/\/+$/, '')}/v1/capabilities`;
  const timeoutMs = options.timeoutMs ?? 10_000;

  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, timeoutMs);

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
        ...(options.organizationId ? { organizationId: options.organizationId } : {}),
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
    // Route the error through the wire-error translator so the server's envelope
    // (`code`, `message`, `doc_url`) is preserved and mapped to the matching
    // AbloError subclass. Fall back to `exchange_failed` only when the body
    // carried no recognizable error code.
    const requestId = response.headers.get('x-request-id') ?? undefined;
    throw hasWireCode(body)
      ? translateHttpError(response.status, body, requestId)
      : new AbloAuthenticationError(
          `apiKey exchange rejected (${response.status})`,
          { code: 'exchange_failed', httpStatus: response.status },
        );
  }

  return parseCapabilityMintResponse(await response.json());
}

// ─────────────────────────────────────────────────────────────────────

interface MintUserSessionBase {
  /** Your secret API key (an `sk_` key). Minting a session is a server-side
   *  operation, so it always presents the secret key, never a token derived
   *  from it. */
  readonly apiKey: string;
  readonly baseUrl: string;
  /** The end user's identifier in your identity provider. It becomes the
   *  session's `participantId`. */
  readonly userId: string;
  /** The organization to mint the session into, for a platform that manages many
   *  organizations. Requires the secret key to carry the `ephemeral:mint-any-org`
   *  capability. Omit to mint into the key's own organization. */
  readonly organizationId?: string;
  /** Points this session's schema at a shared project while its data stays scoped
   *  to `organizationId`. Use this when each customer has its own organization but
   *  they all share one schema: keep a single schema project, and every customer's
   *  session resolves its schema from it instead of pushing the schema into each
   *  organization separately. Requires the secret key to carry the
   *  `ephemeral:mint-any-org` capability. Omit to resolve the schema from the
   *  session's own organization. */
  readonly schemaProject?: {
    /** The organization that owns the shared schema project. */
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
 * Exactly one grant form. Name the models when you know the schema the session
 * will resolve; send verbs alone when you cannot — an identity service minting
 * for organizations whose schemas it does not own has no way to name their
 * models, and a grant is checked against the session's schema at mint time. The
 * server expands the verbs across that schema and stores the same enumerated
 * `model.verb` allowlist either way. The third form grants no data operations
 * at all, for a session that only proves identity to control-plane surfaces —
 * it involves no schema, so it mints even for an organization that has not
 * pushed one yet.
 */
export type MintUserSessionRequest = MintUserSessionBase & {
  /** The allowlist, named model by model. Provide exactly one grant form. */
  readonly operations?: readonly GrantedOperation[];
  /**
   * The allowlist as verbs alone, expanded by the server across the models in
   * the session's active schema. Provide exactly one grant form.
   */
  readonly activeSchemaOperations?: readonly CapabilityOperation[];
  /**
   * No data operations: the session proves who the user is to control-plane
   * surfaces (the dashboard, credential provisioning) and can touch no
   * application data. Provide exactly one grant form.
   */
  readonly controlPlaneOnly?: true;
};

/**
 * Mints an end-user session key (an `ek_` key) by calling
 * `POST /v1/ephemeral_keys`, using your secret key as authorization. Your
 * backend calls this to issue a session that a browser can present as its bearer
 * credential; the server trusts the resulting key because a secret key minted it.
 *
 * This is a distinct endpoint from `/v1/capabilities`, which exchanges keys for
 * agents and systems and cannot mint sessions for human users.
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
  // Exactly one grant form. Several would be two answers to one question; none
  // would send an empty allowlist, and an empty allowlist is read as
  // unrestricted rather than as nothing. The server refuses either way; this
  // says so before the round trip, where the caller can see which call did it.
  const grantForms = [
    options.operations,
    options.activeSchemaOperations,
    options.controlPlaneOnly,
  ].filter((form) => form !== undefined).length;
  if (grantForms !== 1) {
    throw new AbloAuthenticationError(
      'Provide exactly one of operations, activeSchemaOperations, or controlPlaneOnly ' +
        'for a user-session mint.',
      { code: 'invalid_body' },
    );
  }

  const fetcher = options.fetch ?? fetch;
  const url = `${options.baseUrl.replace(/\/+$/, '')}/v1/ephemeral_keys`;
  const timeoutMs = options.timeoutMs ?? 10_000;

  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, timeoutMs);

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
        // The public option is project-centric; map it to the flat wire keys the
        // endpoint expects.
        ...(options.schemaProject
          ? {
              schemaProjectId: options.schemaProject.projectId,
              schemaOwnerOrgId: options.schemaProject.organizationId,
            }
          : {}),
        ...(options.syncGroups ? { syncGroups: options.syncGroups } : {}),
        ...(options.controlPlaneOnly
          ? { controlPlaneOnly: true }
          : options.operations
            ? { operations: options.operations }
            : { activeSchemaOperations: options.activeSchemaOperations }),
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
 * Resolves the caller's identity from an authenticated request by calling
 * `GET /auth/identity`. This lets browser and session flows learn who the
 * current user is without requiring the application to pass a user id up front —
 * for example, to key local storage.
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
  const timer = setTimeout(() => { controller.abort(); }, timeoutMs);

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
    // Translate the error envelope the same way `exchangeApiKey` does, so the
    // server's precise auth diagnosis (for example `jwt_issuer_untrusted` with
    // its full message) reaches the caller instead of collapsing every 401 to a
    // generic `identity_resolve_failed`.
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
 * Keeps a capability token fresh so a long-lived client never disconnects when
 * its token expires.
 *
 * A capability token has a shorter lifetime — one hour by default — than a
 * typical browser session. Without a refresh, the WebSocket is force-closed at
 * expiry (close code 1008) or the next reconnect fails with a 401, and either way
 * the user sees a mid-session disconnect. The scheduler prevents that by
 * re-minting the token ahead of time.
 *
 * Three triggers share one refresh path:
 *
 *   1. Proactive  — a timer set for `expiresAtMs - bufferMs - now`.
 *   2. Visibility — when a hidden tab becomes visible and the token is already
 *                   within the buffer window, refresh immediately. This covers a
 *                   background tab whose timers were throttled while it was idle.
 *   3. Reactive   — the caller invokes {@link RefreshScheduler.refreshNow} after
 *                   observing an auth failure, such as a WebSocket close 1008 or
 *                   4001.
 *
 * All three await the same in-flight promise, so concurrent triggers mint the
 * token only once. Each successful refresh records the new expiry and reschedules
 * the proactive timer.
 *
 * The refresh margin is `max(60s, ttl/10)` — six minutes for a one-hour token,
 * and it scales down for shorter lifetimes.
 */

export interface RefreshSchedulerOptions {
  /** Initial absolute expiry, ms since epoch (server-supplied). */
  readonly initialExpiresAtMs: number;

  /**
   * Performs the token exchange and returns the new expiry. Errors propagate to
   * `onError`; the scheduler stays alive and retries on its next trigger. It does
   * not back off between retries, since the common failure here is a revoked API
   * key, for which retrying would not help.
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
   * Default: true in browser environments.
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

  // Attach the visibility listener only in a browser-like environment. A
  // non-browser runtime has no `document`, so the default behaves correctly
  // without an explicit opt-out.
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
