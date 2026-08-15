/**
 * Unit tests for `validateAbloOptions`. Extracted from `Ablo.ts` so
 * the validation rules can be exercised without standing up the
 * full constructor stack.
 *
 * Each test asserts on the exact error message because callers see
 * these in `store.syncStatus.error` — wording is part of the
 * contract.
 */

import { validateAbloOptions } from '../validateAbloOptions.js';
import { AbloError, AbloValidationError } from '@abloatai/transaction/errors';

const validSchema = { models: { items: {} } };

/**
 * Narrows away the `null` branch. Every rejection test expects an error, so a
 * `null` here is the failure itself — reported with a readable message instead
 * of a crash on the following property access.
 */
function assertRejected(err: AbloError | null): AbloError {
  if (err === null) {
    throw new Error('expected validateAbloOptions to return an error, but it returned null');
  }
  return err;
}

describe('validateAbloOptions', () => {
  it('returns null with a schema and apiKey', () => {
    expect(
      validateAbloOptions({
        options: { schema: validSchema },
        url: 'wss://api.example.com',
        configuredApiKey: 'sk_live_abc',
        configuredAuthToken: null,
      }),
    ).toBeNull();
  });

  it('rejects a missing schema with the canonical model-access hint', () => {
    const err = validateAbloOptions({
      options: {},
      url: 'wss://api.example.com',
      configuredApiKey: 'sk_live_abc',
      configuredAuthToken: null,
    });
    expect(err).toMatchObject({ code: 'invalid_options', param: 'schema' });
    expect(assertRejected(err).message).toContain('ablo.<model>');
  });

  it('accepts schema when provided for typed internal callers', () => {
    expect(
      validateAbloOptions({
        options: { schema: validSchema, user: { id: 'u1' } },
        url: 'wss://api.example.com',
        configuredApiKey: 'sk_live_abc',
        configuredAuthToken: null,
      }),
    ).toBeNull();
  });

  it('rejects empty url with the migration-pointer message', () => {
    const err = validateAbloOptions({
      options: { schema: validSchema },
      url: '',
      configuredApiKey: 'sk_live_abc',
      configuredAuthToken: null,
    });
    expect(err).not.toBeNull();
    expect(assertRejected(err).message).toContain('`url` is required');
    expect(assertRejected(err).message).toContain('baseURL');
  });

  it('returns a typed AbloError (never a bare Error) tagged with a code', () => {
    // The SDK contract: construction-time validation failures are tagged
    // like every other Ablo error, so callers reading `store.syncStatus.error`
    // can discriminate on `e.type` / `e.code`.
    const urlErr = validateAbloOptions({
      options: { schema: validSchema },
      url: '',
      configuredApiKey: 'sk_live_abc',
      configuredAuthToken: null,
    });
    expect(urlErr).toBeInstanceOf(AbloValidationError);
    expect(urlErr).toBeInstanceOf(AbloError);
    expect(assertRejected(urlErr).code).toBe('base_url_missing');

    const userErr = validateAbloOptions({
      options: { schema: validSchema, user: { id: '' } },
      url: 'wss://api.example.com',
      configuredApiKey: null,
      configuredAuthToken: null,
    });
    expect(userErr).toBeInstanceOf(AbloValidationError);
    expect(assertRejected(userErr).code).toBe('invalid_options');
    expect(assertRejected(userErr).param).toBe('user.id');
  });

  it('accepts an intentionally empty schema', () => {
    expect(
      validateAbloOptions({
        options: { schema: { models: {} } },
        url: 'wss://api.example.com',
        configuredApiKey: 'sk_live_abc',
        configuredAuthToken: null,
      }),
    ).toBeNull();
  });

  it('rejects user with empty id when no apiKey/authToken/capabilityToken', () => {
    const err = validateAbloOptions({
      options: { schema: validSchema, user: { id: '' } },
      url: 'wss://api.example.com',
      configuredApiKey: null,
      configuredAuthToken: null,
    });
    expect(assertRejected(err).message).toContain('user.id');
  });

  it('accepts user with empty id when apiKey is present (server resolves)', () => {
    expect(
      validateAbloOptions({
        options: { schema: validSchema, user: { id: '' } },
        url: 'wss://api.example.com',
        configuredApiKey: 'sk_live_abc',
        configuredAuthToken: null,
      }),
    ).toBeNull();
  });

  it('rejects agent kind without apiKey/authToken/agentId', () => {
    const err = validateAbloOptions({
      options: { schema: validSchema, kind: 'agent' },
      url: 'wss://api.example.com',
      configuredApiKey: null,
      configuredAuthToken: null,
    });
    expect(assertRejected(err).message).toContain('apiKey');
    expect(assertRejected(err).message).toContain('agentId');
  });

  it('rejects agent kind without capabilityToken in self-hosted path', () => {
    const err = validateAbloOptions({
      options: {
        schema: validSchema,
        kind: 'agent',
        agentId: 'agent-1',
        // capabilityToken missing
      },
      url: 'wss://api.example.com',
      configuredApiKey: null,
      configuredAuthToken: null,
    });
    expect(assertRejected(err).message).toContain('capabilityToken');
  });

  it('accepts agent kind with apiKey (hosted path — server mints capability)', () => {
    expect(
      validateAbloOptions({
        options: { schema: validSchema, kind: 'agent' },
        url: 'wss://api.example.com',
        configuredApiKey: 'sk_live_abc',
        configuredAuthToken: null,
      }),
    ).toBeNull();
  });

  it('accepts agent kind with self-hosted authToken + agentId + capabilityToken', () => {
    expect(
      validateAbloOptions({
        options: {
          schema: validSchema,
          kind: 'agent',
          agentId: 'agent-1',
          capabilityToken: 'biscuit_abc',
        },
        url: 'wss://api.example.com',
        configuredApiKey: null,
        configuredAuthToken: 'auth_token_xyz',
      }),
    ).toBeNull();
  });

  it('treats configuredApiKey as a CredentialProvider the same as a string', () => {
    // Validator only checks presence, never the value type, so a
    // callable apiKey resolver passes the same gates a string would.
    const setter = () => 'sk_live_abc';
    expect(
      validateAbloOptions({
        options: { schema: validSchema, kind: 'agent' },
        url: 'wss://api.example.com',
        configuredApiKey: setter,
        configuredAuthToken: null,
      }),
    ).toBeNull();
  });
});
