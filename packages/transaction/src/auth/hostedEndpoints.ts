/**
 * The hosted Ablo hosts, with no dependencies of their own.
 *
 * This is the single place each published Ablo domain is declared: the API the
 * SDK calls, the documentation site every error link and descriptor points at,
 * and the marketing site that carries signup and the legal pages. URL
 * resolution, the CLI's default URL, the data-source connector's base, the
 * generated OpenAPI server entry, the error registry's `doc_url`, and the
 * published discovery descriptors all import from here, so changing a domain is
 * a one-line edit.
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

/**
 * The documentation site. Canonical target of every error `doc_url`, of the
 * published OpenAPI document, and of the discovery descriptors under
 * `/.well-known`, which is why it is declared beside the API host rather than
 * retyped at each of those call sites.
 */
export const ABLO_DOCS_BASE_URL = 'https://docs.abloatai.com';

/**
 * The marketing site: signup, the CLI device-flow approval page, and the legal
 * pages a machine-readable onboarding descriptor has to cite. The apex
 * redirects here, so this is the form to publish.
 */
export const ABLO_SITE_BASE_URL = 'https://www.abloatai.com';
