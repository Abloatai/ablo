import { AbloAuthenticationError } from '../errors.js';
import { classifyCredentialKind } from './credentialKind.js';
import {
  credentialToken,
  type CredentialProvider,
  type CredentialProviderResult,
} from './credentialResult.js';

export function assertBrowserSafety(input: {
  readonly apiKey: string | CredentialProvider | null;
  readonly dangerouslyAllowBrowser: boolean | undefined;
}): void {
  if (
    !input.dangerouslyAllowBrowser &&
    typeof window !== 'undefined' &&
    typeof input.apiKey === 'string' &&
    classifyCredentialKind(input.apiKey) === 'secret'
  ) {
    throwBrowserSecretError();
  }
}

export function protectBrowserCredentialProvider(
  provider: CredentialProvider,
  dangerouslyAllowBrowser: boolean | undefined,
): CredentialProvider {
  return async (): Promise<CredentialProviderResult> => {
    const result = await provider();
    const token = credentialToken(result);
    if (
      !dangerouslyAllowBrowser &&
      typeof window !== 'undefined' &&
      token !== null &&
      classifyCredentialKind(token) === 'secret'
    ) {
      throwBrowserSecretError();
    }
    return result;
  };
}

function throwBrowserSecretError(): never {
  throw new AbloAuthenticationError(
    'A secret `sk_` credential reached the browser. Keep it server-side and ' +
      'configure the browser with `authEndpoint` instead.',
    { code: 'browser_apikey_blocked' },
  );
}
