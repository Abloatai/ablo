import { describe, expect, it, jest } from '@jest/globals';
import { createSessionHandler } from '../handler.js';

const SESSION = {
  object: 'session' as const,
  id: 'session-1',
  token: 'ek_test_browser',
  expiresAt: '2030-09-01T12:00:00.000Z',
  organizationId: 'org-1',
  scope: {
    organizationId: 'org-1',
    projectId: 'project-1',
    branchId: 'branch-1',
    groups: ['user:user-1'],
    operations: ['record.read'],
    participantKind: 'user' as const,
    participantId: 'user-1',
    deliveryPartition: null,
  },
  userMeta: {},
};

describe('sessions.handler', () => {
  it('derives the grant from an authenticated principal and returns the strict credential envelope', async () => {
    const create = jest.fn(async () => SESSION);
    const handler = createSessionHandler(create, {
      authenticate: async () => ({ userId: 'user-1' }),
      grant: ({ principal }) => ({
        user: { id: principal.userId },
        can: { records: ['read'] },
      }),
    });

    const response = await handler(new Request('https://app.example/api/ablo/session', {
      method: 'POST',
      headers: { origin: 'https://app.example' },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      token: SESSION.token,
      expiresAt: SESSION.expiresAt,
      credentialKind: 'ephemeral',
    });
    expect(create).toHaveBeenCalledWith({
      user: { id: 'user-1' },
      can: { records: ['read'] },
    });
  });

  it('rejects cross-origin, signed-out, and unauthorized requests before minting', async () => {
    const create = jest.fn(async () => SESSION);
    const signedOut = createSessionHandler(create, {
      authenticate: async () => null,
      grant: () => null,
    });
    const unauthorized = createSessionHandler(create, {
      authenticate: async () => ({ userId: 'user-1' }),
      grant: () => null,
    });

    const crossOrigin = await signedOut(new Request('https://app.example/api/ablo/session', {
      method: 'POST',
      headers: { origin: 'https://attacker.example' },
    }));
    expect(crossOrigin.status).toBe(403);

    const expired = await signedOut(new Request('https://app.example/api/ablo/session', {
      method: 'POST',
      headers: { origin: 'https://app.example' },
    }));
    expect(expired.status).toBe(401);

    const denied = await unauthorized(new Request('https://app.example/api/ablo/session', {
      method: 'POST',
      headers: { origin: 'https://app.example' },
    }));
    expect(denied.status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });
});
