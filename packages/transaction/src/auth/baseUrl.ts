/**
 * The base URL every credential is sent to, and the rules it has to satisfy.
 *
 * `baseURL` is the only client option that decides *where* an API key travels.
 * Every request the SDK makes attaches the resolved credential as a bearer
 * token against this origin, so an unchecked value here is an exfiltration
 * primitive: one stray environment variable and a live `sk_` is posted to
 * somebody else's host, in cleartext if the scheme says so.
 *
 * That check belongs beside the option, not in each application that sets it.
 * A consumer who has to re-derive "must be HTTPS, must not embed credentials,
 * must not carry a query" writes it once per codebase at best, and never at
 * worst. Normalization and validation are therefore the same pass, at the one
 * point both transports funnel through.
 */

import { AbloValidationError } from '../errors.js';
import { ABLO_DEFAULT_BASE_URL } from './hostedEndpoints.js';

/**
 * Is this host the local machine?
 *
 * Loopback is the one place plaintext carries no risk: the request never
 * reaches a network, so there is nothing between the process and the server to
 * read the token. This is the same boundary browsers draw when they decide
 * which plaintext origins count as trustworthy, which is why `ablo dev` can
 * serve `http://127.0.0.1:8080` without an override while any other host has
 * to prove itself with TLS.
 *
 * `.localhost` names are included because they are reserved to resolve to the
 * loopback interface and are a common local-development convention.
 */
function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '[::1]' || host === '::1') return true;
  // The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function reject(message: string): never {
  throw new AbloValidationError(message, {
    code: 'invalid_options',
    param: 'baseURL',
  });
}

/**
 * Resolves a caller-supplied base URL to the absolute origin the SDK will send
 * credentials to, refusing the values that would leak one.
 *
 * Accepted: an absolute `http`, `https`, `ws`, or `wss` URL, or a bare host
 * name that is treated as `https`. A path prefix is preserved, so a
 * self-hosted deployment mounted at `https://internal.example/ablo` works.
 *
 * Refused, each because the request that followed would be wrong rather than
 * merely unusual:
 *
 *   - an unparseable value, which today fails later as an opaque fetch error;
 *   - a scheme outside the HTTP family;
 *   - plaintext `http` to anywhere but the local machine, which puts the key
 *     on the wire in clear;
 *   - an embedded `user:password`, which is both a credential in the wrong
 *     place and the shape a lookalike host uses to read as a familiar one;
 *   - a query string or fragment, which cannot survive having a path appended;
 *   - a trailing-dot host, which reaches the same server as the name without it
 *     while comparing unequal to every check that names the host.
 */
export function normalizeAbloBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  // An empty override is an unset override. Returning it verbatim would hand
  // the transports a base no request can be built against.
  if (!trimmed) return ABLO_DEFAULT_BASE_URL;

  // A scheme-less value (e.g. `api-staging.abloatai.com`) is treated as a
  // relative URL: `new URL()` throws on it, and a later `fetch` would resolve it
  // against the current page, producing a 404 from the app's own origin.
  // Prepending a scheme makes the base absolute, and `https` is the only safe
  // guess; the socket layer derives `wss` from it. An existing scheme (ws, wss,
  // http, or https) is preserved untouched.
  const schemed = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(schemed);
  } catch {
    reject(
      `\`baseURL\` is not a valid URL: ${JSON.stringify(rawUrl)}. ` +
        `Pass an absolute origin such as ${ABLO_DEFAULT_BASE_URL}.`,
    );
  }

  // Canonicalize the scheme to the HTTP family: accept all four schemes
  // (http, https, ws, wss), normalize at this single entry point, and let
  // each layer derive its own protocol (the socket layer maps http to ws and
  // https to wss; fetch uses the URL as-is). Without this, a `ws://` base URL
  // reaches HTTP consumers un-normalized and the client fails at startup
  // instead of connecting.
  if (url.protocol === 'ws:') url.protocol = 'http:';
  if (url.protocol === 'wss:') url.protocol = 'https:';

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    reject(
      `\`baseURL\` must be an https URL. ${JSON.stringify(rawUrl)} uses ` +
        `${url.protocol.replace(':', '')}, which Ablo cannot send a request over.`,
    );
  }

  if (url.username || url.password) {
    reject(
      '`baseURL` must not embed a username or password. Ablo authenticates ' +
        'with the credential you pass as `apiKey`; a URL that carries its own ' +
        'is either a mistake or a host impersonating a familiar one.',
    );
  }

  if (url.search || url.hash) {
    reject(
      '`baseURL` must not carry a query string or fragment. Ablo appends its ' +
        'own path to this value, so anything after it would be discarded or ' +
        'would swallow the path. Pass the origin, and the path prefix if you ' +
        'self-host behind one.',
    );
  }

  if (url.hostname.endsWith('.')) {
    reject(
      '`baseURL` must not end its host in a dot. That name reaches the same ' +
        'server as the one without it, but compares unequal everywhere the ' +
        'host is checked.',
    );
  }

  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
    reject(
      `\`baseURL\` must use https. Ablo sends your API key with every ` +
        `request, and ${url.hostname} over plain http would expose it to ` +
        `anything on the path. Plain http is accepted only for the local ` +
        `machine during development.`,
    );
  }

  return url.toString().replace(/\/+$/, '');
}
