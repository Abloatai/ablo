/**
 * The canonical Ablo Cloud endpoint constants — a ZERO-dependency leaf.
 *
 * This is the single place the hosted API host is declared. Everything else
 * (`client/auth.ts` URL resolution, the CLI's `DEFAULT_URL`, the Data Source
 * connector's dial-out base, the generated OpenAPI `servers` entry, the
 * network probe's default) imports from here, so the next API-domain
 * migration is ONE edit — the `LEGACY_HOSTED_API_HOSTS` rewrite list in
 * `client/auth.ts` (four retired ablo.finance hosts) is proof such
 * migrations happen.
 *
 * Kept dependency-free on purpose: `schema/openapi.ts` and `source/connector.ts`
 * consume it, and routing them through `client/auth.ts` would drag the error
 * registry + credential policy (and a `schema → client → errors →
 * coordination → schema` cycle) into subpaths that are otherwise clean.
 */

/** The hosted API domain (no scheme). */
export const ABLO_HOSTED_API_DOMAIN = 'api.abloatai.com';

/** The hosted HTTP origin — `https://` + {@link ABLO_HOSTED_API_DOMAIN}. */
export const ABLO_HOSTED_HTTP_BASE_URL = `https://${ABLO_HOSTED_API_DOMAIN}`;

/** Default `baseURL` when the caller passes none. Same value as
 *  {@link ABLO_HOSTED_HTTP_BASE_URL}; kept as a distinct name because it is
 *  the documented client-options default. */
export const ABLO_DEFAULT_BASE_URL = ABLO_HOSTED_HTTP_BASE_URL;
