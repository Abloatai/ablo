/**
 * Runtime lifecycle for a renewable session supplied to `Ablo({ session })`.
 *
 * A session provider mints a credential, while this boundary decides when to
 * reuse it. Keeping that policy here prevents HTTP requests and the WebSocket
 * bootstrap from independently minting duplicate sessions for the same actor.
 */

import type {
  CredentialProvider,
  CredentialProviderResult,
} from '../auth/credentialResult.js';
import type {
  SessionProvider,
  SessionProviderResult,
  SessionSource,
} from './contract.js';
import { AbloValidationError } from '../errors.js';
import {
  createEndpointCredentialResolver,
  isCredentialEndpoint,
} from '../auth/credentialEndpoint.js';
import { protectBrowserCredentialProvider } from '../auth/browserCredentialSafety.js';

const SESSION_REFRESH_SKEW_MS = 30_000;

function remainsUsable(session: Exclude<SessionProviderResult, null>, now: number): boolean {
  const expiresAt = Date.parse(session.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt - now > SESSION_REFRESH_SKEW_MS;
}

/** Cache one minted session until it approaches expiry; concurrent refreshes share one mint. */
export function cachedSessionProvider(provider: SessionProvider): CredentialProvider {
  let current: Exclude<SessionProviderResult, null> | null = null;
  let refreshing: Promise<SessionProviderResult> | null = null;

  return async () => {
    if (current && remainsUsable(current, Date.now())) return current;
    refreshing ??= provider().then((next) => {
      current = next;
      return next;
    }).finally(() => {
      refreshing = null;
    });
    return refreshing;
  };
}

/** The one credential input a live transport consumes. */
export interface SessionAccess {
  readonly renewable: boolean;
  credential(): Promise<CredentialProviderResult>;
}

/** Normalize a static or renewable session before it reaches a transport. */
export function createSessionAccess(
  source: SessionSource | null | undefined,
  credential: () => Promise<CredentialProviderResult>,
): SessionAccess {
  return {
    renewable:
      typeof source === 'function'
      || (typeof source === 'object' && source !== null && 'endpoint' in source),
    credential,
  };
}

/** Resolve the public session forms into the credential shape auth consumes. */
export function resolveSessionCredential(
  source: SessionSource,
  options: {
    readonly fetch?: typeof globalThis.fetch;
    readonly dangerouslyAllowBrowser?: boolean;
  },
): string | CredentialProvider {
  if (typeof source === 'function') {
    return protectBrowserCredentialProvider(
      cachedSessionProvider(source),
      options.dangerouslyAllowBrowser,
    );
  }
  if (!('endpoint' in source)) return source.token;
  if (!isCredentialEndpoint(source.endpoint)) {
    throw new AbloValidationError(
      '`session.endpoint` expects a URL or path such as \'/api/ablo-session\'.',
      { code: 'invalid_options', param: 'session.endpoint' },
    );
  }
  return protectBrowserCredentialProvider(createEndpointCredentialResolver(source.endpoint, {
    fetch: options.fetch,
    timeoutMs: source.timeoutMs,
    allowCrossOrigin: source.allowCrossOrigin,
  }), options.dangerouslyAllowBrowser);
}
