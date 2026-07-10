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

export interface AuthCredentialSource {
  getAuthToken(): string | null;
  setAuthToken(token: string | null | undefined): void;
  authorizationHeader(): string | undefined;
  withAuthHeaders(headers?: Record<string, string>): Record<string, string>;
  applyAuthQueryParam(params: URLSearchParams, paramName?: string): void;
}

export type AuthTokenGetter = () => string | null | undefined;

export function createAuthCredentialSource(
  initialToken?: string | null,
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
      return authorization ? { ...headers, Authorization: authorization } : { ...headers };
    },
    applyAuthQueryParam(params, paramName = 'authorization') {
      applyAuthToQueryParams(params, () => authToken, paramName);
    },
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
): Record<string, string> {
  const authorization = authorizationHeaderForToken(
    resolveAuthToken(getAuthToken, fallbackToken),
  );
  return authorization ? { ...headers, Authorization: authorization } : { ...headers };
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
