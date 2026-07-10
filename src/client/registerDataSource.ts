/**
 * Registers a direct database connection as an organization's data source.
 *
 * When a client is constructed with `databaseUrl`, the SDK calls this before
 * bootstrap so the server points the organization's data plane at that connection.
 *
 * It posts to `POST /v1/datasources`, falling back to the older
 * `POST /v1/datasource` route on a 404 so registration still works against an
 * earlier server.
 *
 * The organization is derived on the server from the API key; the caller never
 * sends an organization id. The connection string is sent once over TLS and is
 * never echoed back — the server stores it as a secret and returns only a safe
 * projection of the data source (host, database, schema).
 */
import { AbloError } from '../errors.js';

export interface RegisterDataSourceInput {
  /** The HTTP API base, for example `https://api.abloatai.com/api`. */
  readonly baseUrl: string;
  /** The secret key (`sk_…`) used to authenticate the call and derive the organization. */
  readonly apiKey: string | null;
  /** The Postgres connection string to register. */
  readonly databaseUrl: string;
  /** An optional Postgres schema; the server defaults to `public`. */
  readonly schema?: string;
  /** A custom fetch implementation for tests, proxies, or unusual runtimes. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Posts the connection string to the data-source registration route. Resolves once
 * the organization's data plane points at this database; otherwise throws an
 * {@link AbloError} with code `datasource_registration_failed`, so `ready()`
 * surfaces the failure instead of quietly bootstrapping against the wrong store.
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
    // The newer route is absent on an older server; use the earlier one.
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
