/**
 * The hosted Ablo Cloud endpoint constants, with no dependencies of their own.
 *
 * This is the single place the hosted API host is declared. URL resolution, the
 * CLI's default URL, the data-source connector's base, the generated OpenAPI
 * server entry, and the network probe's default all import from here, so
 * changing the API domain is a one-line edit.
 *
 * These constants are kept dependency-free deliberately: several low-level
 * modules consume them, and routing those modules through the auth layer would
 * pull the error registry and credential policy into otherwise-clean paths and
 * risk an import cycle.
 */

/** The hosted API domain (no scheme). */
export const ABLO_HOSTED_API_DOMAIN = 'api.abloatai.com';

/** The hosted HTTP origin — `https://` + {@link ABLO_HOSTED_API_DOMAIN}. */
export const ABLO_HOSTED_HTTP_BASE_URL = `https://${ABLO_HOSTED_API_DOMAIN}`;

/** Default `baseURL` when the caller passes none. Same value as
 *  {@link ABLO_HOSTED_HTTP_BASE_URL}; kept as a distinct name because it is
 *  the documented client-options default. */
export const ABLO_DEFAULT_BASE_URL = ABLO_HOSTED_HTTP_BASE_URL;
