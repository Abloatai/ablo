import { describe, expect, it, jest } from '@jest/globals';
import { z } from 'zod';
import { model } from '../../schema/model.js';
import { defineSchema } from '../../schema/schema.js';
import { Ablo } from '../../client/ablo.js';
import { Sessions } from '../client.js';

const schema = defineSchema({
  chats: model({ title: z.string() }, { typename: 'Chat' }),
});

describe('Sessions', () => {
  it('owns issuance without constructing a participant client', async () => {
    const fetcher = jest.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe('https://api.test/api/v1/capabilities');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk_test_backend');
      expect(JSON.parse(String(init?.body))).toMatchObject({
        participantKind: 'agent',
        participantId: 'agent-1',
        operations: ['chat.update', 'chat.read'],
      });
      return {
        ok: true,
        status: 201,
        headers: new Headers(),
        json: async () => ({
          capabilityId: 'cap-1',
          token: 'rk_test_agent',
          expiresAt: '2030-09-01T12:00:00.000Z',
          organizationId: 'org-1',
          scope: {
            organizationId: 'org-1',
            syncGroups: ['org:org-1'],
            operations: ['chat.update', 'chat.read'],
            participantKind: 'agent',
            participantId: 'agent-1',
          },
          userMeta: {},
        }),
      } as Response;
    });

    const sessions = Sessions({
      schema,
      apiKey: 'sk_test_backend',
      baseURL: 'https://api.test',
      fetch: fetcher,
    });
    const session = await sessions.create({
      agent: { id: 'agent-1' },
      can: { chats: ['update'] },
    });

    expect(session).toMatchObject({ id: 'cap-1', token: 'rk_test_agent' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('requires explicit backend authority when an operation runs', async () => {
    const sessions = Sessions({ schema, apiKey: null });

    await expect(sessions.create({
      user: { id: 'user-1' },
      can: { chats: ['read'] },
    })).rejects.toMatchObject({ code: 'apikey_missing' });
  });
});

describe('participant model namespace', () => {
  it('leaves a schema model named sessions reachable as a normal model', () => {
    const dataSchema = defineSchema({
      sessions: model({ title: z.string() }),
    });
    const ablo = Ablo({ schema: dataSchema, apiKey: 'rk_test_agent' });

    expect(typeof ablo.sessions.get).toBe('function');
    expect('handler' in ablo.sessions).toBe(false);
  });
});
