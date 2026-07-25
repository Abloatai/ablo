/**
 * `resolveParticipantIdentity` branch tests. Three branches map to
 * three auth paths:
 *   1. Hosted-cloud — apiKey present → `exchangeApiKey` round-trip
 *      + refresh scheduler set up.
 *   2. Self-derived — capability token but no organizationId/user.id
 *      → `resolveIdentity` round-trip.
 *   3. Legacy explicit — organizationId + user.id (or agentId)
 *      present → no server call.
 *
 * Mocks the two server-touching helpers so tests stay network-free
 * while still exercising the dispatch logic.
 */

import { resolveParticipantIdentity } from '@abloatai/transaction/auth/identity';
import { createAuthCredentialSource } from '@abloatai/transaction/auth/credentialSource';
import type { BootstrapFetcher } from '../../sync/BootstrapFetcher.js';
import type { Logger } from '../../interfaces/index.js';

jest.mock('@abloatai/transaction/auth', () => ({
  exchangeApiKey: jest.fn(),
  resolveIdentity: jest.fn(),
  createRefreshScheduler: jest.fn(() => ({
    stop: jest.fn(),
    refreshNow: jest.fn(),
  })),
}));

import { exchangeApiKey } from '@abloatai/transaction/auth';
import { resolveIdentity } from '@abloatai/transaction/auth';
import { createRefreshScheduler } from '@abloatai/transaction/auth';

const mockExchangeApiKey = exchangeApiKey as jest.MockedFunction<typeof exchangeApiKey>;
const mockResolveIdentity = resolveIdentity as jest.MockedFunction<typeof resolveIdentity>;
const mockCreateRefreshScheduler = createRefreshScheduler as jest.MockedFunction<typeof createRefreshScheduler>;

function buildBootstrapFetcher(): {
  helper: BootstrapFetcher;
  setCacheScope: jest.Mock;
  setSyncGroups: jest.Mock;
} {
  const setCacheScope = jest.fn();
  const setSyncGroups = jest.fn();
  return {
    helper: { setCacheScope, setSyncGroups } as unknown as BootstrapFetcher,
    setCacheScope,
    setSyncGroups,
  };
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('resolveParticipantIdentity — hosted-cloud branch (apiKey)', () => {
  it('exchanges the apiKey, sets cache scope + sync groups, returns refresh scheduler', async () => {
    mockExchangeApiKey.mockResolvedValue({
      capabilityId: 'cap_xyz',
      token: 'biscuit_abc',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      organizationId: 'org_acme',
      scope: {
        organizationId: 'org_acme',
        // A user scope carries no operation grants (those are the agent axis);
        // the wire form is now `model.verb`, and the old `'*'` wildcard is not a
        // member of it. Empty, like every other scope mock in this file.
        syncGroups: ['org:org_acme', 'user:u1'],
        operations: [],
        participantKind: 'user',
        participantId: 'u1',
      },
      userMeta: {},
    });

    const { helper, setCacheScope, setSyncGroups } = buildBootstrapFetcher();
    const auth = createAuthCredentialSource();

    const result = await resolveParticipantIdentity({
      options: {},
      internalOptions: {},
      url: 'wss://api.example.com',
      kind: 'user',
      configuredApiKey: 'sk_live_abc',
      configuredAuthToken: null,
      bootstrapHelper: helper,
      auth,
      logger: noopLogger,
    });

    expect(mockExchangeApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://api.example.com/api',
        apiKey: 'sk_live_abc',
        wideScope: true,
      }),
    );
    expect(setCacheScope).toHaveBeenCalledWith('org_acme');
    expect(setSyncGroups).toHaveBeenCalledWith(['org:org_acme', 'user:u1']);
    expect(auth.getAuthToken()).toBe('biscuit_abc');
    expect(result).toMatchObject({
      userId: 'u1',
      accountScope: 'org_acme',
      capabilityToken: 'biscuit_abc',
      participantKind: 'user',
    });
    expect(result.refreshScheduler).not.toBeNull();
  });

  it('resolves a CredentialProvider before exchanging', async () => {
    mockExchangeApiKey.mockResolvedValue({
      capabilityId: 'cap_xyz',
      token: 'biscuit_abc',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      organizationId: 'org_acme',
      scope: {
        organizationId: 'org_acme',
        syncGroups: [],
        operations: [],
        participantKind: 'user',
        participantId: 'u1',
      },
      userMeta: {},
    });

    const setter = jest.fn(async () => 'sk_live_rotated');
    const { helper } = buildBootstrapFetcher();
    const auth = createAuthCredentialSource();

    await resolveParticipantIdentity({
      options: {},
      internalOptions: {},
      url: 'wss://api.example.com',
      kind: 'user',
      configuredApiKey: setter,
      configuredAuthToken: null,
      bootstrapHelper: helper,
      auth,
      logger: noopLogger,
    });

    expect(setter).toHaveBeenCalled();
    expect(mockExchangeApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk_live_rotated' }),
    );
  });

  it('configures the refresh scheduler with the exchange expiresAt', async () => {
    const expiresAt = new Date('2030-01-01T00:00:00Z').toISOString();
    mockExchangeApiKey.mockResolvedValue({
      capabilityId: 'cap_xyz',
      token: 'biscuit_abc',
      expiresAt,
      organizationId: 'org_acme',
      scope: {
        organizationId: 'org_acme',
        syncGroups: [],
        operations: [],
        participantKind: 'user',
        participantId: 'u1',
      },
      userMeta: {},
    });

    const { helper } = buildBootstrapFetcher();
    const auth = createAuthCredentialSource();

    await resolveParticipantIdentity({
      options: {},
      internalOptions: {},
      url: 'wss://api.example.com',
      kind: 'user',
      configuredApiKey: 'sk_live_abc',
      configuredAuthToken: null,
      bootstrapHelper: helper,
      auth,
      logger: noopLogger,
    });

    expect(mockCreateRefreshScheduler).toHaveBeenCalledWith(
      expect.objectContaining({
        initialExpiresAtMs: Date.parse(expiresAt),
      }),
    );
  });

  it('refresh scheduler writes rotated tokens into the shared auth source', async () => {
    mockExchangeApiKey
      .mockResolvedValueOnce({
        capabilityId: 'cap_initial',
        token: 'biscuit_initial',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        organizationId: 'org_acme',
        scope: {
          organizationId: 'org_acme',
          syncGroups: [],
          operations: [],
          participantKind: 'user',
          participantId: 'u1',
        },
        userMeta: {},
      })
      .mockResolvedValueOnce({
        capabilityId: 'cap_next',
        token: 'biscuit_next',
        expiresAt: new Date(Date.now() + 7200_000).toISOString(),
        organizationId: 'org_acme',
        scope: {
          organizationId: 'org_acme',
          syncGroups: [],
          operations: [],
          participantKind: 'user',
          participantId: 'u1',
        },
        userMeta: {},
      });

    const { helper } = buildBootstrapFetcher();
    const auth = createAuthCredentialSource();

    await resolveParticipantIdentity({
      options: {},
      internalOptions: {},
      url: 'wss://api.example.com',
      kind: 'user',
      configuredApiKey: 'sk_live_abc',
      configuredAuthToken: null,
      bootstrapHelper: helper,
      auth,
      logger: noopLogger,
    });

    expect(auth.getAuthToken()).toBe('biscuit_initial');

    const schedulerCall = mockCreateRefreshScheduler.mock.calls[0];
    if (!schedulerCall) throw new Error('expected createRefreshScheduler to have been called');
    const schedulerArgs = schedulerCall[0];
    await schedulerArgs.refresh();

    expect(auth.getAuthToken()).toBe('biscuit_next');
  });

  it('skips the apiKey branch when caller passed a capabilityToken explicitly', async () => {
    // Even though apiKey is set, the explicit capabilityToken signals
    // the caller wants the self-derived path, not the exchange.
    mockResolveIdentity.mockResolvedValue({
      participantKind: 'user',
      participantId: 'u_self',
      accountScope: 'org_self',
      projectId: null,
      environment: null,
      sandboxId: null,
      syncGroups: [],
      userMeta: {},
    });

    const { helper } = buildBootstrapFetcher();
    const auth = createAuthCredentialSource();

    await resolveParticipantIdentity({
      options: { capabilityToken: 'biscuit_caller_supplied' },
      internalOptions: {},
      url: 'wss://api.example.com',
      kind: 'user',
      configuredApiKey: 'sk_live_abc',
      configuredAuthToken: null,
      bootstrapHelper: helper,
      auth,
      logger: noopLogger,
    });

    expect(mockExchangeApiKey).not.toHaveBeenCalled();
    expect(mockResolveIdentity).toHaveBeenCalled();
  });
});

describe('resolveParticipantIdentity — self-derived branch (cap token, unknown identity)', () => {
  it('calls resolveIdentity with the cap token and applies returned scope', async () => {
    mockResolveIdentity.mockResolvedValue({
      participantKind: 'agent',
      participantId: 'agent_research',
      accountScope: 'org_acme',
      projectId: null,
      environment: null,
      sandboxId: null,
      syncGroups: ['org:org_acme'],
      userMeta: {},
    });

    const { helper, setCacheScope, setSyncGroups } = buildBootstrapFetcher();
    const auth = createAuthCredentialSource();

    const result = await resolveParticipantIdentity({
      options: { capabilityToken: 'biscuit_self' },
      internalOptions: {},
      url: 'wss://api.example.com',
      kind: 'agent',
      configuredApiKey: null,
      configuredAuthToken: null,
      bootstrapHelper: helper,
      auth,
      logger: noopLogger,
    });

    expect(mockResolveIdentity).toHaveBeenCalledWith({
      baseUrl: 'https://api.example.com/api',
      authToken: 'biscuit_self',
    });
    expect(setCacheScope).toHaveBeenCalledWith('org_acme');
    expect(setSyncGroups).toHaveBeenCalledWith(['org:org_acme']);
    expect(auth.getAuthToken()).toBe('biscuit_self');
    expect(result).toMatchObject({
      userId: 'agent_research',
      accountScope: 'org_acme',
      participantKind: 'agent',
    });
    expect(result.refreshScheduler).toBeNull();
  });
});

describe('resolveParticipantIdentity — legacy explicit branch', () => {
  it('skips both server calls when organizationId + user.id are present', async () => {
    const { helper, setCacheScope, setSyncGroups } = buildBootstrapFetcher();
    const auth = createAuthCredentialSource();

    const result = await resolveParticipantIdentity({
      options: {
        user: { id: 'u_explicit', teamIds: ['team_1'] },
        syncGroups: ['org:org_explicit'],
      },
      internalOptions: { organizationId: 'org_explicit' },
      url: 'wss://api.example.com',
      kind: 'user',
      configuredApiKey: null,
      configuredAuthToken: 'biscuit_self_hosted',
      bootstrapHelper: helper,
      auth,
      logger: noopLogger,
    });

    expect(mockExchangeApiKey).not.toHaveBeenCalled();
    expect(mockResolveIdentity).not.toHaveBeenCalled();
    expect(setCacheScope).toHaveBeenCalledWith('org_explicit');
    expect(setSyncGroups).toHaveBeenCalledWith(['org:org_explicit']);
    expect(auth.getAuthToken()).toBe('biscuit_self_hosted');
    expect(result).toMatchObject({
      userId: 'u_explicit',
      accountScope: 'org_explicit',
      teamIds: ['team_1'],
      capabilityToken: 'biscuit_self_hosted',
      participantKind: 'user',
    });
  });

  it('uses agentId when kind is agent', async () => {
    const { helper } = buildBootstrapFetcher();
    const auth = createAuthCredentialSource();

    const result = await resolveParticipantIdentity({
      options: { agentId: 'agent_42', capabilityToken: 'biscuit_agent' },
      internalOptions: { organizationId: 'org_explicit' },
      url: 'wss://api.example.com',
      kind: 'agent',
      configuredApiKey: null,
      configuredAuthToken: null,
      bootstrapHelper: helper,
      auth,
      logger: noopLogger,
    });

    expect(result.userId).toBe('agent_42');
    expect(result.teamIds).toBeUndefined();
  });
});
