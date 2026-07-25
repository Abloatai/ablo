import { describe, expect, it, jest } from '@jest/globals';
import { mintSession } from '../sessionMint.js';

describe('user session scope', () => {
  it('derives the wire operation grant from the schema contract', async () => {
    const fetcher = jest.fn<typeof fetch>(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        user: { id: 'user-1' },
        operations: ['task.read', 'task.update'],
      });
      return {
        ok: true,
        status: 201,
        json: async () => ({
          object: 'ephemeral_key',
          id: 'key-1',
          token: 'ek_test_token',
          expiresAt: '2026-07-25T12:00:00Z',
          organizationId: 'org-1',
          participantId: 'user-1',
          syncGroups: ['org:org-1'],
          operations: ['task.read', 'task.update'],
        }),
        headers: new Headers(),
      } as Response;
    });

    const session = await mintSession(
      {
        user: { id: 'user-1' },
        can: { tasks: ['read', 'update'] },
      },
      {
        apiKey: 'sk_test_secret',
        baseUrl: 'https://api.test',
        fetch: fetcher,
        modelTypenames: { tasks: 'Task' },
      },
    );

    expect(session.scope.operations).toEqual(['task.read', 'task.update']);
  });
});
