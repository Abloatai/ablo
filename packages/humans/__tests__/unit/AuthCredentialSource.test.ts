import { createAuthCredentialSource } from '@ablo/transaction/auth/credentialSource';

describe('AuthCredentialSource', () => {
  it('is the mutable source of bearer auth headers', () => {
    const auth = createAuthCredentialSource(' token-a ');

    expect(auth.getAuthToken()).toBe('token-a');
    expect(auth.authorizationHeader()).toBe('Bearer token-a');
    const params = new URLSearchParams();
    auth.applyAuthQueryParam(params);
    expect(params.get('authorization')).toBe('Bearer token-a');
    expect(auth.withAuthHeaders({ 'Content-Type': 'application/json' })).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer token-a',
    });

    auth.setAuthToken('token-b');

    expect(auth.getAuthToken()).toBe('token-b');
    expect(auth.authorizationHeader()).toBe('Bearer token-b');

    auth.setAuthToken(null);

    expect(auth.getAuthToken()).toBeNull();
    expect(auth.authorizationHeader()).toBeUndefined();
    expect(auth.withAuthHeaders({ 'Content-Type': 'application/json' })).toEqual({
      'Content-Type': 'application/json',
    });
  });
});
