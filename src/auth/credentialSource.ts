/**
 * Single mutable source for the SDK's active bearer credential.
 *
 * Every transport should read from this object at request/connect time:
 * bootstrap HTTP, lazy query HTTP, identity/probe HTTP, and WebSocket URL
 * auth. Token refresh writes here once; consumers observe the new value
 * through their getter without being manually patched one by one.
 */

/**
 * WebSocket subprotocols used to carry the bearer credential OUT of the URL.
 *
 * Browsers cannot set an `Authorization` header on a WebSocket, so the SDK
 * offers the token as a `Sec-WebSocket-Protocol` value — `ablo.bearer.<token>` —
 * alongside the real `ablo.sync.v1` protocol the server selects. This keeps the
 * credential out of the query string, which ALB access logs, proxies, and
 * browser history capture. The server reads the token from the subprotocol and
 * echoes back ONLY `ablo.sync.v1`, never the token-bearing value. Shared with
 * the sync-server so client and server can never drift on the wire format.
 */
export const WS_BEARER_SUBPROTOCOL_PREFIX = 'ablo.bearer.';
export const WS_SYNC_SUBPROTOCOL = 'ablo.sync.v1';

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
