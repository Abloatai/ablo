/**
 * Validates the options passed when constructing an interactive client, before any
 * connection is attempted. Returns the first problem it finds as an
 * {@link AbloError}, or null when every check passes. The caller records that
 * error on the client's sync status, so a misconfiguration surfaces through the
 * normal status channel rather than throwing at the call site.
 *
 * The order of checks matters: a missing `url` is reported before any identity
 * problem, because the identity error messages mention the URL and would
 * mislead if the URL were the thing actually missing.
 */

import { AbloError, AbloValidationError } from '@abloatai/transaction/errors';
import type { ParticipantKind } from '@abloatai/transaction/types/participant';

/**
 * The subset of client options this validator reads. It is declared as its own
 * interface, structurally compatible with the full options type, so a real
 * options object satisfies it without the validator having to depend on the
 * complete type.
 */
export interface ValidatableAbloOptions {
  readonly schema?: { readonly models?: Record<string, unknown> } | null;
  readonly kind?: ParticipantKind;
  readonly user?: { readonly id?: string } | undefined;
  readonly agentId?: string | undefined;
  readonly capabilityToken?: string | undefined;
}

export interface ValidateAbloOptionsInput {
  readonly options: ValidatableAbloOptions;
  readonly url: string;
  /**
   * Truthy when an API key was supplied (string or callable). The
   * validator only inspects presence, never the value, so the input
   * shape stays loose to accept whatever the caller resolved.
   */
  readonly configuredApiKey: unknown;
  readonly configuredAuthToken: unknown;
}

export function validateAbloOptions(input: ValidateAbloOptionsInput): AbloError | null {
  const { options, url, configuredApiKey, configuredAuthToken } = input;
  const kind = options.kind ?? 'user';

  if (!url) {
    return new AbloValidationError(
      'Ablo: `url` is required. Pass the sync server URL, e.g. ' +
        `Ablo({ baseURL: 'wss://api.abloatai.com', schema, user })`,
      { code: 'base_url_missing' },
    );
  }

  if (!options.schema?.models) {
    return new AbloValidationError(
      'Ablo: `schema` is required. Define it once and access models as `ablo.<model>`.',
      { code: 'invalid_options', param: 'schema' },
    );
  }

  if (
    !configuredApiKey &&
    !configuredAuthToken &&
    !options.capabilityToken &&
    kind === 'user' &&
    options.user &&
    !options.user.id
  ) {
    return new AbloValidationError(
      'Ablo: `user.id` must be a non-empty string when `user` is provided.',
      { code: 'invalid_options', param: 'user.id' },
    );
  }

  if (!configuredApiKey && !configuredAuthToken && kind === 'agent' && !options.agentId) {
    return new AbloValidationError(
      'Ablo: provide either `apiKey` or `agentId` for `kind: "agent"`. ' +
        'Hosted-cloud consumers pass `apiKey` and the server derives the ' +
        'agent identity from its scope; self-hosted passes `agentId` + ' +
        '`capabilityToken` directly.',
      { code: 'invalid_options', param: 'agentId' },
    );
  }

  if (!configuredApiKey && !configuredAuthToken && kind === 'agent' && !options.capabilityToken) {
    return new AbloValidationError(
      'Ablo: provide either `apiKey` (hosted cloud — SDK exchanges internally) ' +
        'or `capabilityToken` (self-hosted — your auth layer mints + hands in). ' +
        'See https://abloatai.com/docs/api-keys for the full pattern.',
      { code: 'invalid_options', param: 'capabilityToken' },
    );
  }

  return null;
}
