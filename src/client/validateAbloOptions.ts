/**
 * Up-front validation of `AbloOptions`. Returns the first error
 * encountered or null if all checks pass — caller writes the error
 * into `store.syncStatus` so consumers see it through the existing
 * status surface rather than catching it at the call site.
 *
 * Extracted from `Ablo.ts` (which was ~2300 LOC of constructor wiring)
 * so the validation rules are readable in isolation. The order of
 * checks matters: missing `url` is checked before identity options
 * because the error messages reference URLs and would mislead if a
 * URL was actually present.
 */

/**
 * Minimal subset of `AbloOptions` the validator actually inspects.
 * Defined here as its own interface so the validator doesn't pull
 * the whole 200+-line `AbloOptions` type — and to avoid a circular
 * import with `Ablo.ts`. Fields are kept structurally identical to
 * `AbloOptions` so a real options object satisfies this shape.
 */
export interface ValidatableAbloOptions {
  readonly schema?: { readonly models?: Record<string, unknown> } | null;
  readonly kind?: 'user' | 'agent' | 'system';
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

export function validateAbloOptions(input: ValidateAbloOptionsInput): Error | null {
  const { options, url, configuredApiKey, configuredAuthToken } = input;
  const kind = options.kind ?? 'user';

  if (!url) {
    return new Error(
      'Ablo: `url` is required. Pass the sync server URL, e.g. ' +
        `Ablo({ baseURL: 'wss://sync.ablo.dev', schema, user })`
    );
  }

  // Schema is optional for the model-first API:
  //   Ablo({ apiKey }).model('clauses').retrieve(...)
  // Passing a schema only enables typed model sugar (`ablo.weatherReports.update(...)`).

  if (
    !configuredApiKey &&
    !configuredAuthToken &&
    !options.capabilityToken &&
    kind === 'user' &&
    options.user &&
    !options.user.id
  ) {
    return new Error('Ablo: `user.id` must be a non-empty string when `user` is provided.');
  }

  if (!configuredApiKey && !configuredAuthToken && kind === 'agent' && !options.agentId) {
    return new Error(
      'Ablo: provide either `apiKey` or `agentId` for `kind: "agent"`. ' +
        'Hosted-cloud consumers pass `apiKey` and the server derives the ' +
        'agent identity from its scope; self-hosted passes `agentId` + ' +
        '`capabilityToken` directly.'
    );
  }

  if (!configuredApiKey && !configuredAuthToken && kind === 'agent' && !options.capabilityToken) {
    return new Error(
      'Ablo: provide either `apiKey` (hosted cloud — SDK exchanges internally) ' +
        'or `capabilityToken` (self-hosted — your auth layer mints + hands in). ' +
        'See https://ablo.dev/docs/api-keys for the full pattern.'
    );
  }

  return null;
}
