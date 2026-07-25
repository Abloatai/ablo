/**
 * Engine-side validation fallback for `ablo connect`: dial-failure
 * classification (which local errors mean "ask the engine" vs "fatal here"),
 * the endpoint path, wire parsing, and checklist rendering labels.
 */

import {
  describeRemoteFailure,
  dialFailureReason,
  requestRemoteValidation,
  validateEndpoint,
} from '../remoteValidation';

function codedError(code: string, message: string): Error {
  const err = new Error(message);
  (err as Error & { code: string }).code = code;
  return err;
}

describe('dialFailureReason', () => {
  it('classifies DNS misses, refused/unrouteable connects, and dial timeouts', () => {
    expect(dialFailureReason(codedError('ENOTFOUND', 'getaddrinfo ENOTFOUND db.x.supabase.co'))).toBe(
      'getaddrinfo ENOTFOUND db.x.supabase.co',
    );
    expect(dialFailureReason(codedError('ENETUNREACH', 'connect ENETUNREACH 2a05::1'))).toBe(
      'connect ENETUNREACH 2a05::1',
    );
    expect(dialFailureReason(codedError('CONNECT_TIMEOUT', 'write CONNECT_TIMEOUT'))).toBe(
      'write CONNECT_TIMEOUT',
    );
  });

  it('looks through AggregateError members (dual-stack connects report one error per family)', () => {
    const aggregate = new AggregateError(
      [codedError('ECONNREFUSED', 'connect ECONNREFUSED 1.2.3.4:5432')],
      'All attempts failed',
    );
    expect(dialFailureReason(aggregate)).toBe('connect ECONNREFUSED 1.2.3.4:5432');
  });

  it('returns null for errors where the host WAS reached — those are fatal locally', () => {
    // Postgres auth failure: SQLSTATE, not a network code.
    expect(dialFailureReason(codedError('28P01', 'password authentication failed'))).toBeNull();
    expect(dialFailureReason(new Error('relation does not exist'))).toBeNull();
    expect(dialFailureReason(null)).toBeNull();
    expect(dialFailureReason('ENOTFOUND')).toBeNull();
  });
});

describe('validateEndpoint', () => {
  it('targets the /api-mounted validate route, matching registration', () => {
    expect(validateEndpoint('https://api.abloatai.com')).toBe(
      'https://api.abloatai.com/api/v1/datasources/validate',
    );
    expect(validateEndpoint('https://api.abloatai.com/')).toBe(
      'https://api.abloatai.com/api/v1/datasources/validate',
    );
  });
});

describe('describeRemoteFailure', () => {
  it('names each problem in plain language — no Postgres internals in the label', () => {
    // The label says what's not ready for the user; the `fix` carries the how. No
    // wal_level / publication / REPLICATION-attribute jargon reaches the reader.
    const labels = [
      describeRemoteFailure({ item: 'wal_level', actual: 'replica', fix: 'f' }).label,
      describeRemoteFailure({ item: 'publication', fix: 'f' }).label,
      describeRemoteFailure({ item: 'replication_role', fix: 'f' }).label,
      describeRemoteFailure({ item: 'replica_identity', actual: 'public.users', fix: 'f' }).label,
      describeRemoteFailure({ item: 'table_select', actual: 'public.users', fix: 'f' }).label,
      describeRemoteFailure({ item: 'write_role', fix: 'f' }).label,
      describeRemoteFailure({ item: 'logical_marker', fix: 'f' }).label,
    ];
    for (const label of labels) {
      expect(label).not.toMatch(/wal_level|\bpublication\b|REPLICATION attribute|DML|correlation marker|logical/i);
    }
    expect(describeRemoteFailure({ item: 'wal_level', fix: 'f' }).label).toBe(
      `your database isn't set up to share changes as they happen yet`,
    );
    expect(describeRemoteFailure({ item: 'replication_role', fix: 'f' }).label).toBe(
      `the login Ablo reads with can't follow your changes yet`,
    );
  });

  it('names a publication-coverage gap by the tables, and never leaks "publication"', () => {
    const drift = describeRemoteFailure({
      item: 'publication_drift',
      actual: 'tasks, notes',
      fix: 'ALTER PUBLICATION "ablo_publication" ADD TABLE public."tasks", public."notes";',
    });
    // The reader learns WHICH tables aren't shared and the exact statement to run,
    // without the word "publication" in the plain-language label.
    expect(drift.label).toContain('tasks, notes');
    expect(drift.label).not.toMatch(/\bpublication\b/i);
    expect(drift.fix).toContain('ALTER PUBLICATION');
  });

  it('passes an unknown item through so a newer server never breaks an older CLI', () => {
    expect(describeRemoteFailure({ item: 'future_check', fix: 'do x' })).toEqual({
      label: 'future_check',
      fix: 'do x',
    });
  });
});

describe('requestRemoteValidation', () => {
  // A plain-object response — the injectable seam only reads ok/status/json,
  // so tests never depend on the runtime's Response global.
  const jsonResponse = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: (): Promise<unknown> => Promise.resolve(body),
  });

  it('parses a ready verdict and sends the key + connection string', async () => {
    const seen: { url?: string; auth?: string; body?: unknown } = {};
    const result = await requestRemoteValidation({
      apiUrl: 'https://api.abloatai.com',
      apiKey: 'sk_test_k',
      connectionString: 'postgres://u:p@db.x.supabase.co/db',
      fetchImpl: (url, init) => {
        seen.url = url;
        seen.auth = init.headers.authorization;
        seen.body = JSON.parse(init.body);
        return Promise.resolve(
          jsonResponse(200, {
            object: 'datasource_validation',
            reachable: true,
            ready: true,
            failures: [],
          }),
        );
      },
    });
    expect(seen.url).toBe('https://api.abloatai.com/api/v1/datasources/validate');
    expect(seen.auth).toBe('Bearer sk_test_k');
    expect(seen.body).toEqual({ connectionString: 'postgres://u:p@db.x.supabase.co/db' });
    expect(result).toEqual({ ok: true, reachable: true, ready: true, failures: [] });
  });

  it('sends an empty body to validate the registered source — no credential, just the key', async () => {
    const seen: { auth?: string; body?: unknown } = {};
    const result = await requestRemoteValidation({
      apiUrl: 'https://api.abloatai.com',
      apiKey: 'sk_test_k',
      fetchImpl: (_url, init) => {
        seen.auth = init.headers.authorization;
        seen.body = JSON.parse(init.body);
        return Promise.resolve(
          jsonResponse(200, {
            object: 'datasource_validation',
            reachable: true,
            ready: true,
            failures: [],
          }),
        );
      },
    });
    // The body carries no connection string — the engine resolves the plane's
    // registered source from the key alone.
    expect(seen.body).toEqual({});
    expect(seen.auth).toBe('Bearer sk_test_k');
    expect(result).toEqual({ ok: true, reachable: true, ready: true, failures: [] });
  });

  it('surfaces a 404 no_data_source_registered as a non-throwing error outcome', async () => {
    const result = await requestRemoteValidation({
      apiUrl: 'https://api.abloatai.com',
      apiKey: 'sk_test_k',
      fetchImpl: () =>
        Promise.resolve(
          jsonResponse(404, {
            error: {
              code: 'no_data_source_registered',
              message: 'No database is connected to this plane yet.',
            },
          }),
        ),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure outcome');
    expect(result.status).toBe(404);
    expect(result.code).toBe('no_data_source_registered');
  });

  it('parses failures and drops malformed wire entries instead of crashing', async () => {
    const result = await requestRemoteValidation({
      apiUrl: 'https://api.abloatai.com',
      apiKey: 'sk_test_k',
      connectionString: 'postgres://u:p@h/db',
      fetchImpl: () =>
        Promise.resolve(
          jsonResponse(200, {
            reachable: true,
            ready: false,
            failures: [
              { item: 'wal_level', actual: 'replica', fix: 'set it' },
              { item: 42, fix: 'nope' },
              'garbage',
            ],
          }),
        ),
    });
    expect(result).toEqual({
      ok: true,
      reachable: true,
      ready: false,
      failures: [{ item: 'wal_level', actual: 'replica', fix: 'set it' }],
    });
  });

  it('carries the unreachable reason through', async () => {
    const result = await requestRemoteValidation({
      apiUrl: 'https://api.abloatai.com',
      apiKey: 'sk_test_k',
      connectionString: 'postgres://u:p@h/db',
      fetchImpl: () =>
        Promise.resolve(
          jsonResponse(200, { reachable: false, ready: false, reason: 'ENOTFOUND h', failures: [] }),
        ),
    });
    expect(result).toEqual({
      ok: true,
      reachable: false,
      ready: false,
      reason: 'ENOTFOUND h',
      failures: [],
    });
  });

  it('returns the server error envelope as a non-throwing outcome', async () => {
    const result = await requestRemoteValidation({
      apiUrl: 'https://api.abloatai.com',
      apiKey: 'pk_live_wrong',
      connectionString: 'postgres://u:p@h/db',
      fetchImpl: () =>
        Promise.resolve(
          jsonResponse(403, { code: 'forbidden', message: 'forbidden: requires a secret API key' }),
        ),
    });
    expect(result).toEqual({
      ok: false,
      status: 403,
      code: 'forbidden',
      message: 'forbidden: requires a secret API key',
    });
  });

  it('reports an unreachable API as ok:false with status 0', async () => {
    const result = await requestRemoteValidation({
      apiUrl: 'https://api.abloatai.com',
      apiKey: 'sk_test_k',
      connectionString: 'postgres://u:p@h/db',
      fetchImpl: () => Promise.reject(new Error('fetch failed')),
    });
    expect(result).toMatchObject({ ok: false, status: 0 });
  });
});
