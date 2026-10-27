import {afterEach, describe, expect, it, jest} from '@jest/globals';
import {probeNetwork} from '../networkProbe.js';

afterEach(() => jest.restoreAllMocks());

describe('probe credential destination', () => {
  it.each(['http://remote.example', 'ws://remote.example', 'https://user:password@remote.example'])('rejects %s before reading or sending credentials', async baseUrl => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, {status: 204}));
    const getAuthToken = jest.fn(() => 'ek_fixture');
    await expect(probeNetwork({baseUrl, getAuthToken})).rejects.toThrow();
    expect(getAuthToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['http://127.0.0.1:8080', 'http://127.0.0.1:8080/api/auth/check'],
    ['ws://localhost:8080', 'http://localhost:8080/api/auth/check'],
    ['wss://remote.example/prefix/', 'https://remote.example/prefix/api/auth/check'],
  ])('retains supported local or secure destinations: %s', async (baseUrl, expected) => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, {status: 204}));
    await expect(probeNetwork({baseUrl, authToken: 'ek_fixture'})).resolves.toMatchObject({outcome: 'reachable'});
    expect(fetch).toHaveBeenCalledWith(expected, expect.any(Object));
  });
});
