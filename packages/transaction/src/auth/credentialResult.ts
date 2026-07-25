import type { CredentialEndpointSuccess } from './credentialEndpointProtocol.js';

export type CredentialProviderResult =
  | string
  | CredentialEndpointSuccess
  | null;

/** Rotating secret provider or short-lived browser credential provider. */
export type CredentialProvider = () => Promise<CredentialProviderResult>;

export function credentialToken(
  result: CredentialProviderResult,
): string | null {
  return typeof result === 'string' ? result : result?.token ?? null;
}

export function credentialExpiry(
  result: CredentialProviderResult,
): string | undefined {
  return typeof result === 'object' && result !== null
    ? result.expiresAt
    : undefined;
}
