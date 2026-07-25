/**
 * postQuery × the auth-recovery backbone — the fix for the "Could not load
 * documents — apikey_expired ... forever" wedge: a 401 on the lazy-query lane
 * now routes through `recoverCredential` (the store's single-flight re-mint)
 * and replays the request EXACTLY ONCE with the refreshed credential, instead
 * of silently returning empty rows against an expired key.
 */

import { postQuery, type PostQueryOptions } from '../../src/local/query/client';

interface MockResponseInit {
  status: number;
  body: unknown;
}

function mockResponse({ status, body }: MockResponseInit): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    clone: () => ({ json: () => Promise.resolve(body) }),
  } as unknown as Response;
}

const EXPIRED_401 = {
  status: 401,
  body: { error: { code: 'apikey_expired', message: 'key has expired' } },
};
const OK_ROWS = { status: 200, body: { results: [[{ id: 'doc_1' }]] } };

describe('postQuery — credential recovery replay', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  type FetchMock = jest.Mock<ReturnType<typeof fetch>, Parameters<typeof fetch>>;

  function mockFetchSequence(...responses: MockResponseInit[]): FetchMock {
    const fn = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
    for (const res of responses) fn.mockResolvedValueOnce(mockResponse(res));
    globalThis.fetch = fn;
    return fn;
  }

  const batch = { queries: [{ model: 'documents', where: [] }] };

  function options(overrides: Partial<PostQueryOptions> = {}): PostQueryOptions {
    return { baseUrl: 'https://api.example.com/api', ...overrides };
  }

  it('401 apikey_expired → recovery("access_credential_expiry") → replays once with the FRESH token', async () => {
    const fetchMock = mockFetchSequence(EXPIRED_401, OK_ROWS);
    let token = 'ek_expired';
    const recoverCredential = jest.fn(() => {
      token = 'ek_fresh';
      return Promise.resolve('retry' as const);
    });

    const result = await postQuery(
      options({ getAuthToken: () => token, recoverCredential }),
      batch,
    );

    expect(recoverCredential).toHaveBeenCalledTimes(1);
    expect(recoverCredential).toHaveBeenCalledWith('access_credential_expiry');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstCall, replayCall] = fetchMock.mock.calls as [string, RequestInit][];
    if (!firstCall || !replayCall) throw new Error('expected an initial fetch and a replay');
    const authHeader = (init: RequestInit) => (init.headers as Record<string, string>).Authorization;
    expect(authHeader(firstCall[1])).toBe('Bearer ek_expired');
    expect(authHeader(replayCall[1])).toBe('Bearer ek_fresh');
    expect(result).toEqual({ results: [[{ id: 'doc_1' }]] });
  });

  it('bare 401 with no readable code → still attempts recovery as an expired access key', async () => {
    // NetworkProbe precedent: an ambiguous 401 must attempt a re-mint; the
    // only terminal path is the mint itself resolving null, never the status.
    const fetchMock = mockFetchSequence({ status: 401, body: 'Unauthorized' }, OK_ROWS);
    const recoverCredential = jest.fn(() => Promise.resolve('retry' as const));

    const result = await postQuery(
      options({ getAuthToken: () => 'ek_x', recoverCredential }),
      batch,
    );

    expect(recoverCredential).toHaveBeenCalledWith('access_credential_expiry');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ results: [[{ id: 'doc_1' }]] });
  });

  it('recovery says stop → NO replay, empty slots (the pre-backbone behavior)', async () => {
    const fetchMock = mockFetchSequence(EXPIRED_401);
    const recoverCredential = jest.fn(() => Promise.resolve('stop' as const));

    const result = await postQuery(
      options({ getAuthToken: () => 'ek_x', recoverCredential }),
      batch,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ results: [[]] });
  });

  it('replay rejected again → bounded: recovery runs ONCE, then empty slots (no retry loop)', async () => {
    const fetchMock = mockFetchSequence(EXPIRED_401, EXPIRED_401);
    const recoverCredential = jest.fn(() => Promise.resolve('retry' as const));

    const result = await postQuery(
      options({ getAuthToken: () => 'ek_x', recoverCredential }),
      batch,
    );

    expect(recoverCredential).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ results: [[]] });
  });

  it('403 (permission) → recovery NOT consulted', async () => {
    const fetchMock = mockFetchSequence({
      status: 403,
      body: { error: { code: 'permission_denied', message: 'nope' } },
    });
    const recoverCredential = jest.fn(() => Promise.resolve('retry' as const));

    const result = await postQuery(
      options({ getAuthToken: () => 'ek_x', recoverCredential }),
      batch,
    );

    expect(recoverCredential).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ results: [[]] });
  });

  it('session_expired code → recovery consulted with session_expiry (sign-out is the backbone/FSM call)', async () => {
    const fetchMock = mockFetchSequence({
      status: 401,
      body: { error: { code: 'session_expired', message: 'login gone' } },
    });
    const recoverCredential = jest.fn(() => Promise.resolve('stop' as const));

    await postQuery(options({ getAuthToken: () => 'ek_x', recoverCredential }), batch);

    expect(recoverCredential).toHaveBeenCalledWith('session_expiry');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('no recovery hook wired → single attempt, empty slots (unchanged legacy behavior)', async () => {
    const fetchMock = mockFetchSequence(EXPIRED_401);

    const result = await postQuery(options({ getAuthToken: () => 'ek_x' }), batch);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ results: [[]] });
  });
});
