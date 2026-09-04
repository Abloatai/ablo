/**
 * The single mutable holder for the active bearer credential every transport
 * uses.
 *
 * Each transport reads the current token from this object at request or connect
 * time — the HTTP request paths and the WebSocket URL authorizer alike. When the
 * token is refreshed, it is written here once, and every reader observes the new
 * value through its getter rather than being updated one by one.
 */

// The WebSocket bearer-subprotocol constants are defined in `../wire/protocol.js`
// as part of the wire contract shared between client and server. They are
// re-exported here so this module stays a stable import site for them.
export { WS_BEARER_SUBPROTOCOL_PREFIX, WS_SYNC_SUBPROTOCOL } from '../wire/protocol.js';
import type { PresenceSessionSource } from '../presence/session.js';

export interface AuthCredentialSource {
  /**
   * Declared as a standalone closure rather than a method because callers pass
   * it on by reference — the transport and the core client each take
   * `getAuthToken` alone and call it with no receiver. The implementation is a
   * closure over the token, so that is safe; typing it as a method would say
   * otherwise and make every hand-off read as a lost `this`.
   */
  getAuthToken: () => string | null;
  setAuthToken(token: string | null | undefined): void;
  authorizationHeader(): string | undefined;
  withAuthHeaders(headers?: Record<string, string>): Record<string, string>;
  applyAuthQueryParam(params: URLSearchParams, paramName?: string): void;
  /** Session attribution shared by WebSocket and HTTP; it never grants authority. */
  readonly presenceSession?: PresenceSessionSource;
}

export type AuthTokenGetter = () => string | null | undefined;

export function createAuthCredentialSource(
  initialToken?: string | null,
  presenceSession?: PresenceSessionSource,
): AuthCredentialSource {
  let authToken = normalizeToken(initialToken);

  return {
    getAuthToken: () => authToken,
    setAuthToken(token) {
      authToken = normalizeToken(token);
    },
    authorizationHeader() {
      return authorizationHeaderForToken(authToken);
    },
    withAuthHeaders(headers = {}) {
      const authorization = authorizationHeaderForToken(authToken);
      const authenticated = authorization
        ? { ...headers, Authorization: authorization }
        : { ...headers };
      return presenceSession?.withHeader(authenticated) ?? authenticated;
    },
    applyAuthQueryParam(params, paramName = 'authorization') {
      applyAuthToQueryParams(params, () => authToken, paramName);
    },
    ...(presenceSession ? { presenceSession } : {}),
  };
}

export function resolveAuthToken(
  getAuthToken?: AuthTokenGetter,
  fallbackToken?: string | null,
): string | undefined {
  return normalizeToken(getAuthToken?.() ?? fallbackToken) ?? undefined;
}

export function authorizationHeaderForToken(
  token: string | null | undefined,
): string | undefined {
  const normalized = normalizeToken(token);
  return normalized ? `Bearer ${normalized}` : undefined;
}

export function withAuthHeaders(
  getAuthToken: AuthTokenGetter | undefined,
  headers: Record<string, string> = {},
  fallbackToken?: string | null,
  presenceSession?: PresenceSessionSource,
): Record<string, string> {
  const authorization = authorizationHeaderForToken(
    resolveAuthToken(getAuthToken, fallbackToken),
  );
  const authenticated = authorization
    ? { ...headers, Authorization: authorization }
    : { ...headers };
  return presenceSession?.withHeader(authenticated) ?? authenticated;
}

export function applyAuthToQueryParams(
  params: URLSearchParams,
  getAuthToken: AuthTokenGetter | undefined,
  paramName = 'authorization',
  fallbackToken?: string | null,
): void {
  const authorization = authorizationHeaderForToken(
    resolveAuthToken(getAuthToken, fallbackToken),
  );
  if (authorization) {
    params.set(paramName, authorization);
  }
}

function normalizeToken(token: string | null | undefined): string | null {
  if (!token) return null;
  const trimmed = token.trim();
  return trimmed.length > 0 ? trimmed : null;
}
