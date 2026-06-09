/**
 * Self-serve direct-kind datasource registration.
 *
 * When a client is constructed with `databaseUrl`, the SDK registers that
 * connection string BEFORE bootstrap so the server resolves the org's data plane
 * to that direct connection.
 *
 * Targets the unified `POST /v1/datasources` resource; on a 404 (an older
 * server without the unified route) it falls back to the legacy
 * `POST /v1/datasource` alias so an SDK upgrade never strands registration.
 *
 * The org is derived server-side from the API key — the caller never sends an
 * organization id. The connection string is sent once over TLS and is never
 * echoed back (the server stores it as a secret and returns only a safe
 * `datasource` projection: host, database, schema).
 */
import { AbloError } from '../errors.js';

export interface RegisterDataSourceInput {
  /** HTTP API base, e.g. `https://api.abloatai.com/api` (from resolveBootstrapBaseUrl). */
  readonly baseUrl: string;
  /** Secret key (`sk_…`) used to authenticate + derive the org. */
  readonly apiKey: string | null;
  /** Postgres connection string for the direct connector. */
  readonly databaseUrl: string;
  /** Optional Postgres schema (defaults server-side to `public`). */
  readonly schema?: string;
  /** Custom fetch (tests/proxies/odd runtimes). */
  readonly fetchImpl?: typeof fetch;
}

/**
 * POST the connection string to the self-serve datasource route. Resolves on
 * success (the org's data plane now points at this DB); throws an `AbloError`
 * with `datasource_registration_failed` otherwise so `ready()` surfaces it
 * instead of silently bootstrapping against the wrong store.
 */
export async function registerDataSource(input: RegisterDataSourceInput): Promise<void> {
  if (!input.apiKey) {
    throw new AbloError(
      'databaseUrl requires an apiKey to register the database connection (the org is derived from the key).',
      { code: 'datasource_registration_failed' }
    );
  }
  const doFetch = input.fetchImpl ?? fetch;
  const base = input.baseUrl.replace(/\/+$/, '');
  const body = JSON.stringify({
    connectionString: input.databaseUrl,
    ...(input.schema ? { schema: input.schema } : {}),
  });
  const post = async (endpoint: string): Promise<Response> => {
    try {
      return await doFetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${input.apiKey}`,
        },
        body,
      });
    } catch (cause) {
      throw new AbloError('Could not reach the Ablo API to register the database connection.', {
        code: 'datasource_registration_failed',
        cause,
      });
    }
  };
  let response = await post(`${base}/v1/datasources`);
  if (response.status === 404) {
    // Older server without the unified resource — use the legacy alias.
    response = await post(`${base}/v1/datasource`);
  }
  if (!response.ok) {
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 500);
    } catch {
      // ignore body read failures — the status alone is enough to fail loud
    }
    throw new AbloError(
      `Database connection registration failed (HTTP ${response.status}). ${detail}`,
      { code: 'datasource_registration_failed', httpStatus: response.status }
    );
  }
}
