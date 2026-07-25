import type { CredentialProvider } from './credentialResult.js';
import {
  credentialEndpointErrorCode,
  parseCredentialEndpointSuccess,
} from './credentialEndpointProtocol.js';

const DEFAULT_AUTH_TIMEOUT_MS = 10_000;

export interface CredentialEndpointOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly allowCrossOrigin?: boolean;
}

export function isCredentialEndpoint(value: string): boolean {
  return value.startsWith('/') || /^https?:\/\//i.test(value);
}

function assertEndpointOrigin(endpoint: string, allowCrossOrigin: boolean): void {
  if (allowCrossOrigin || endpoint.startsWith('/')) return;
  if (typeof window === 'undefined') return;
  const endpointOrigin = new URL(endpoint, window.location.href).origin;
  if (endpointOrigin !== window.location.origin) {
    throw new Error(
      'credential endpoint must be same-origin; set ' +
        '`allowCrossOriginAuthEndpoint: true` only after configuring CORS and CSRF protection',
    );
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Strict, injectable client for the browser session-mint protocol. */
export function createEndpointCredentialResolver(
  endpoint: string,
  options: CredentialEndpointOptions = {},
): CredentialProvider {
  assertEndpointOrigin(endpoint, options.allowCrossOrigin ?? false);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;

  return async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      const body = await readJson(response);

      if (
        response.status === 401 &&
        credentialEndpointErrorCode(body) === 'session_expired'
      ) {
        return null;
      }
      if (!response.ok) {
        const code = credentialEndpointErrorCode(body);
        throw new Error(
          `credential endpoint ${endpoint} answered ${response.status}` +
            (code ? ` (${code})` : ''),
        );
      }
      return parseCredentialEndpointSuccess(body);
    } finally {
      clearTimeout(timeout);
    }
  };
}
