import { describe, expect, it, jest } from '@jest/globals';
import {
  revokeCapability,
  rotateCapability,
} from '../capabilityLifecycle.js';

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
  } as Response;
}

describe('capability lifecycle', () => {
  it('revokes a session by resource id', async () => {
    const fetcher = jest.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(
        'https://api.test/v1/capabilities/cap_1',
      );
      expect(init?.method).toBe('DELETE');
      expect(new Headers(init?.headers).get('authorization')).toBe(
        'Bearer sk_test_secret',
      );
      return response({
        id: 'cap_1',
        deleted: true,
        activeSessionsClosed: 2,
      });
    });

    await expect(
      revokeCapability({
        apiKey: 'sk_test_secret',
        baseUrl: 'https://api.test',
        id: 'cap_1',
        fetch: fetcher,
      }),
    ).resolves.toEqual({
      id: 'cap_1',
      deleted: true,
      activeSessionsClosed: 2,
    });
  });

  it('rotates an agent session and normalizes resource ids', async () => {
    const fetcher = jest.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(
        'https://api.test/v1/capabilities/cap_old/rotate',
      );
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        graceSeconds: 60,
        ttlSeconds: 900,
      });
      return response(
        {
          capabilityId: 'cap_new',
          token: ' rk_test_new ',
          expiresAt: '2026-07-26T12:00:00.000Z',
          organizationId: 'org_1',
          scope: {
            organizationId: 'org_1',
            syncGroups: ['org:org_1'],
            operations: ['item.read', 'item.update'],
            participantKind: 'agent',
            participantId: 'agent_1',
          },
          rotatedFrom: {
            capabilityId: 'cap_old',
            expiresAt: '2026-07-25T12:01:00.000Z',
          },
        },
        201,
      );
    });

    await expect(
      rotateCapability({
        apiKey: 'sk_test_secret',
        baseUrl: 'https://api.test',
        id: 'cap_old',
        graceSeconds: 60,
        ttlSeconds: 900,
        fetch: fetcher,
      }),
    ).resolves.toMatchObject({
      id: 'cap_new',
      token: 'rk_test_new',
      rotatedFrom: { id: 'cap_old' },
    });
  });

  it('rejects malformed lifecycle responses', async () => {
    await expect(
      revokeCapability({
        apiKey: 'sk_test_secret',
        baseUrl: 'https://api.test',
        id: 'cap_1',
        fetch: jest.fn(async () => response({ deleted: true })),
      }),
    ).rejects.toMatchObject({ code: 'exchange_malformed_response' });
  });
});
