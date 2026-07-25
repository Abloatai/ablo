import { exchangeApiKey, resolveIdentity } from '@abloatai/transaction/auth';

function jsonResponse(
  body: unknown,
  options: { ok?: boolean; status?: number; requestId?: string } = {},
): Response {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.ok === false ? 'Unauthorized' : 'OK',
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'x-request-id' ? options.requestId ?? null : null,
    },
    json: async () => body,
  } as unknown as Response;
}

describe('auth wire schemas', () => {
  it('validates and normalizes /v1/capabilities responses at the boundary', async () => {
    const result = await exchangeApiKey({
      apiKey: 'sk_test',
      baseUrl: 'https://mesh.example.com/api',
      participantKind: 'user',
      participantId: 'user_1',
      ttlSeconds: 900,
      fetch: jest.fn(async () =>
        jsonResponse({
          capabilityId: 'cap_1',
          token: ' rk_test_1 ',
          expiresAt: '2026-06-02T06:00:00.000Z',
          organizationId: 'org_1',
          scope: {
            organizationId: 'org_1',
            syncGroups: ['org:org_1'],
            operations: ['slides.read'],
            participantKind: 'user',
            participantId: 'user_1',
            extraScopeField: true,
          },
          userMeta: { plan: 'pro' },
          extraTopLevelField: 'kept',
        }),
      ) as typeof fetch,
    });

    expect(result.token).toBe('rk_test_1');
    expect(result.scope.participantKind).toBe('user');
    expect((result as Record<string, unknown>).extraTopLevelField).toBeUndefined();
  });

  it('rejects malformed /v1/capabilities success bodies', async () => {
    await expect(
      exchangeApiKey({
        apiKey: 'sk_test',
        baseUrl: 'https://mesh.example.com/api',
        participantKind: 'user',
        participantId: 'user_1',
        ttlSeconds: 900,
        fetch: jest.fn(async () =>
          jsonResponse({
            token: 'rk_test_1',
            expiresAt: '2026-06-02T06:00:00.000Z',
            organizationId: 'org_1',
            userMeta: {},
          }),
        ) as typeof fetch,
      }),
    ).rejects.toMatchObject({
      type: 'AbloAuthenticationError',
      code: 'exchange_malformed_response',
    });
  });

  it('validates /auth/identity responses at the boundary', async () => {
    const result = await resolveIdentity({
      baseUrl: 'https://mesh.example.com/api',
      authToken: 'ek_test',
      fetch: jest.fn(async () =>
        jsonResponse({
          participantKind: 'user',
          participantId: 'user_1',
          accountScope: 'org_1',
          projectId: null,
          environment: null,
          sandboxId: null,
          syncGroups: ['org:org_1', 'user:user_1'],
          userMeta: { method: 'apikey' },
          extraTopLevelField: 'kept',
        }),
      ) as typeof fetch,
    });

    expect(result.accountScope).toBe('org_1');
    expect(result.syncGroups).toEqual(['org:org_1', 'user:user_1']);
    expect((result as Record<string, unknown>).extraTopLevelField).toBeUndefined();
  });

  it('rejects malformed /auth/identity success bodies instead of casting them', async () => {
    await expect(
      resolveIdentity({
        baseUrl: 'https://mesh.example.com/api',
        authToken: 'ek_test',
        fetch: jest.fn(async () =>
          jsonResponse({
            participantKind: 'user',
            participantId: 'user_1',
            syncGroups: ['org:org_1'],
            userMeta: {},
          }),
        ) as typeof fetch,
      }),
    ).rejects.toMatchObject({
      type: 'AbloAuthenticationError',
      code: 'identity_resolve_failed',
    });
  });
});
