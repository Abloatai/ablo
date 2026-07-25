/**
 * `credentialPolicy` — the consolidated credential KIND taxonomy + connect-time
 * routing. Covers `classifyCredentialKind` for all four prefixes + null, and
 * `resolveCredential` routing for each of the four outcomes (publishable /
 * exchange / pre-minted / explicit) plus the `session_expired` fast-fail.
 */

import {
  classifyCredentialKind,
  resolveCredential,
  type CredentialPrimitives,
  type ResolveCredentialContext,
} from '@ablo/transaction/auth/credentialPolicy';
import { AbloAuthenticationError } from '@ablo/transaction/errors';

describe('classifyCredentialKind', () => {
  it('maps each Ablo key prefix to its kind', () => {
    expect(classifyCredentialKind('sk_live_abc')).toBe('secret');
    expect(classifyCredentialKind('ek_test_abc')).toBe('ephemeral');
    expect(classifyCredentialKind('rk_live_abc')).toBe('restricted');
    expect(classifyCredentialKind('pk_test_abc')).toBe('publishable');
  });

  it('returns null for a value with no recognized prefix', () => {
    expect(classifyCredentialKind('biscuit_some_cap_token')).toBeNull();
    expect(classifyCredentialKind('')).toBeNull();
    expect(classifyCredentialKind('whsec_secret')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────

function buildPrimitives(
  overrides: Partial<CredentialPrimitives> = {},
): CredentialPrimitives {
  return {
    exchangeApiKey: jest.fn(),
    mintUserSessionKey: jest.fn(),
    resolveIdentity: jest.fn(),
    resolveApiKeyValue: jest.fn(async (k) =>
      typeof k === 'function' ? k() : k,
    ),
    ...overrides,
  };
}

function buildCtx(primitives: CredentialPrimitives): ResolveCredentialContext {
  return {
    primitives,
    exchangeArgs: {
      baseUrl: 'https://api.example.com/api',
      participantKind: 'system',
      participantId: 'u1',
      wideScope: true,
      ttlSeconds: 3600,
    },
  };
}

const EXCHANGE_RESULT = {
  capabilityId: 'cap_xyz',
  token: 'biscuit_exchanged',
  expiresAt: new Date('2030-01-01T00:00:00Z').toISOString(),
  organizationId: 'org_acme',
  scope: {
    organizationId: 'org_acme',
    syncGroups: ['org:org_acme'],
    operations: ['*'],
    participantKind: 'user' as const,
    participantId: 'u1',
  },
  userMeta: {},
};

describe('resolveCredential — routing', () => {
  it('routes a pk_ key (no cap token) to the publishable route, no exchange', async () => {
    const primitives = buildPrimitives();
    const cred = await resolveCredential(
      {
        apiKeyValue: 'pk_live_readonly',
        configuredApiKey: 'pk_live_readonly',
        capabilityToken: undefined,
        authToken: null,
        hasExplicitIdentity: false,
      },
      buildCtx(primitives),
    );

    expect(cred).toEqual({
      kind: 'publishable',
      getBearer: 'pk_live_readonly',
      expiresAtMs: null,
      controlPlaneKey: null,
    });
    expect(primitives.exchangeApiKey).not.toHaveBeenCalled();
  });

  it('routes an sk_ key (no cap token) to the exchange route via exchangeApiKey', async () => {
    const exchangeApiKey = jest.fn().mockResolvedValue(EXCHANGE_RESULT);
    const primitives = buildPrimitives({
      exchangeApiKey: exchangeApiKey as unknown as CredentialPrimitives['exchangeApiKey'],
    });

    const cred = await resolveCredential(
      {
        apiKeyValue: 'sk_live_secret',
        configuredApiKey: 'sk_live_secret',
        capabilityToken: undefined,
        authToken: null,
        hasExplicitIdentity: false,
      },
      buildCtx(primitives),
    );

    expect(exchangeApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk_live_secret', wideScope: true }),
    );
    expect(cred.kind).toBe('exchange');
    if (cred.kind !== 'exchange') throw new Error('expected exchange');
    expect(cred.getBearer).toBe('biscuit_exchanged');
    expect(cred.expiresAtMs).toBe(Date.parse(EXCHANGE_RESULT.expiresAt));
    expect(cred.controlPlaneKey).toBe('sk_live_secret');
    expect(cred.exchange).toBe(EXCHANGE_RESULT);
  });

  it('routes a pre-minted ek_ key to the pre-minted route, used as-is (no exchange)', async () => {
    const primitives = buildPrimitives();
    const cred = await resolveCredential(
      {
        apiKeyValue: 'ek_test_session',
        configuredApiKey: 'ek_test_session',
        capabilityToken: undefined,
        authToken: null,
        hasExplicitIdentity: false,
      },
      buildCtx(primitives),
    );

    expect(cred).toEqual({
      kind: 'pre-minted',
      getBearer: 'ek_test_session',
      expiresAtMs: null,
      controlPlaneKey: null,
    });
    expect(primitives.exchangeApiKey).not.toHaveBeenCalled();
  });

  it('routes a pre-minted rk_ key to the pre-minted route', async () => {
    const primitives = buildPrimitives();
    const cred = await resolveCredential(
      {
        apiKeyValue: 'rk_live_restricted',
        configuredApiKey: 'rk_live_restricted',
        capabilityToken: undefined,
        authToken: null,
        hasExplicitIdentity: false,
      },
      buildCtx(primitives),
    );
    expect(cred.kind).toBe('pre-minted');
    if (cred.kind !== 'pre-minted') throw new Error('expected pre-minted');
    expect(cred.getBearer).toBe('rk_live_restricted');
    expect(primitives.exchangeApiKey).not.toHaveBeenCalled();
  });

  it('routes an explicit capabilityToken (even with an sk_ apiKey) to pre-minted, no exchange', async () => {
    const primitives = buildPrimitives();
    const cred = await resolveCredential(
      {
        apiKeyValue: 'sk_live_secret',
        configuredApiKey: 'sk_live_secret',
        capabilityToken: 'biscuit_caller_supplied',
        authToken: null,
        hasExplicitIdentity: false,
      },
      buildCtx(primitives),
    );

    expect(cred.kind).toBe('pre-minted');
    if (cred.kind !== 'pre-minted') throw new Error('expected pre-minted');
    expect(cred.getBearer).toBe('biscuit_caller_supplied');
    expect(primitives.exchangeApiKey).not.toHaveBeenCalled();
  });

  it('routes to explicit when the caller knows its own identity', async () => {
    const primitives = buildPrimitives();
    const cred = await resolveCredential(
      {
        apiKeyValue: null,
        configuredApiKey: null,
        capabilityToken: undefined,
        authToken: 'biscuit_self_hosted',
        hasExplicitIdentity: true,
      },
      buildCtx(primitives),
    );

    expect(cred).toEqual({
      kind: 'explicit',
      getBearer: 'biscuit_self_hosted',
      expiresAtMs: null,
      controlPlaneKey: null,
    });
    expect(primitives.exchangeApiKey).not.toHaveBeenCalled();
    expect(primitives.resolveIdentity).not.toHaveBeenCalled();
  });

  it('throws session_expired when no token can authenticate /auth/identity', async () => {
    const primitives = buildPrimitives();
    const error = await resolveCredential(
      {
        apiKeyValue: null,
        configuredApiKey: null,
        capabilityToken: undefined,
        authToken: null,
        hasExplicitIdentity: false,
      },
      buildCtx(primitives),
    ).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(AbloAuthenticationError);
    expect((error as AbloAuthenticationError).code).toBe('session_expired');
  });
});
