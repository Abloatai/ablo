import { describe, expect, it } from '@jest/globals';
import {
  PRESENCE_SESSION_HEADER,
  createPresenceSessionSource,
  presenceSessionEstablishedSchema,
} from '../index.js';
import { createAuthCredentialSource } from '../../auth/credentialSource.js';

describe('presence session source', () => {
  it('starts empty and adds the server-issued id to HTTP requests', () => {
    const source = createPresenceSessionSource();
    expect(source.withHeader({ Accept: 'application/json' })).toEqual({
      Accept: 'application/json',
    });

    source.establish({
      presenceSessionId: 'b6741f5a-e982-4f9c-916b-2d247b8d4646',
      resumed: false,
    });

    expect(source.withHeader()).toEqual({
      [PRESENCE_SESSION_HEADER]: 'b6741f5a-e982-4f9c-916b-2d247b8d4646',
    });
  });

  it('rejects client-invented session metadata', () => {
    expect(presenceSessionEstablishedSchema.safeParse({
      presenceSessionId: 'not-a-session-id',
      resumed: true,
      participantId: 'forged',
    }).success).toBe(false);
  });

  it('accepts only a server response header with a valid opaque id', () => {
    const source = createPresenceSessionSource();
    expect(source.establishFromHeader('forged')).toBe(false);
    expect(source.get()).toBeNull();
    expect(source.establishFromHeader('f2fef437-7280-453d-9e46-b00c7639c375')).toBe(true);
    expect(source.get()).toBe('f2fef437-7280-453d-9e46-b00c7639c375');
  });

  it('travels with authentication without becoming authentication', () => {
    const presenceSession = createPresenceSessionSource();
    const credentials = createAuthCredentialSource('rk_test', presenceSession);
    presenceSession.establish({
      presenceSessionId: 'f2fef437-7280-453d-9e46-b00c7639c375',
      resumed: false,
    });

    expect(credentials.withAuthHeaders()).toEqual({
      Authorization: 'Bearer rk_test',
      [PRESENCE_SESSION_HEADER]: 'f2fef437-7280-453d-9e46-b00c7639c375',
    });
    credentials.setAuthToken(null);
    expect(credentials.withAuthHeaders()).toEqual({
      [PRESENCE_SESSION_HEADER]: 'f2fef437-7280-453d-9e46-b00c7639c375',
    });
  });
});
