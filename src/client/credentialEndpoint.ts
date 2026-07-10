/**
 * Support for the endpoint-string form of `apiKey`.
 *
 * With `Ablo({ schema, apiKey: '/api/ablo-session' })`, you point the client at
 * your own session-mint route and the client owns the exchange: it POSTs to the
 * endpoint, parses the minted token, keeps it fresh, and classifies failures
 * onto the resolver's three outcomes. The string form covers the common case;
 * the function form of `apiKey` remains the escape hatch for custom headers,
 * bodies, or non-HTTP mints.
 *
 * The form is detected by prefix: a string starting with `/`, `http://`, or
 * `https://` is an endpoint, and anything else is a literal key. Ablo keys are
 * prefixed (`sk_`/`pk_`/`ek_`/`rk_`), so the two shapes cannot collide. An
 * `ABLO_API_KEY` environment value is never treated as an endpoint — it is
 * always a literal key (see `resolveApiKey`).
 *
 * Wire contract:
 *   POST <endpoint>  (same-origin, `credentials: 'include'` so cookies flow)
 *   → 200 `{ token, expiresAt? }`       a fresh short-lived `ek_`/`rk_`
 *   → 200 `{ token: null }` or 401/403  the login itself is gone (sign out)
 *   → anything else                     transient — retry, do not sign out
 *
 * The three-way mapping is the reason to build this in. Hand-written token
 * fetchers routinely get it wrong — mapping any non-OK response to `null` signs
 * the user out on a 500. Encoded here once, every consumer inherits the correct
 * split between a terminal sign-out and a transient retry.
 */

/**
 * An async callable that resolves the current credential. It serves two uses:
 * credential rotation (for example against AWS STS, GCP IAM, or Vault) and the
 * short-lived per-user browser path (minting a fresh `ek_`/`rk_` from the
 * signed-in session). It is re-exported from `./auth` so existing import paths
 * keep working, and defined here so the resolver it types has no import cycle.
 *
 * The contract has three outcomes: resolve a token; resolve `null` when the
 * login itself is gone (terminal — the credential lifecycle treats this as
 * `session_expired` and signs out); or throw on a transient failure (back off
 * and retry, without signing out). A long-lived static `apiKey` string needs
 * none of this and is used as-is.
 */
export type ApiKeySetter = () => Promise<string | null>;

/**
 * Is this `apiKey` string a session-mint endpoint rather than a literal key?
 * Prefix rule: `/relative/path`, `http://…`, or `https://…`.
 */
export function isCredentialEndpoint(value: string): boolean {
  return value.startsWith('/') || /^https?:\/\//i.test(value);
}

/**
 * Builds the resolver behind an endpoint-string `apiKey`. It follows the
 * {@link ApiKeySetter} contract end to end:
 *   - resolves the minted token string on success;
 *   - resolves `null` when the login is gone (a 401 or 403, or an explicit
 *     `{ token: null }`) — terminal, so the client signs out;
 *   - throws on anything transient (a network failure, a 5xx or 429, or a
 *     malformed response) — so the lifecycle backs off and retries without
 *     signing out.
 *
 * A relative endpoint invoked on a server (where `fetch` has no origin) throws,
 * which is transient by contract; the credential lifecycle translates that exact
 * failure into an actionable "use an absolute URL server-side" warning.
 */
export function createEndpointCredentialResolver(endpoint: string): ApiKeySetter {
  return async (): Promise<string | null> => {
    // `fetch()` rejections (offline, DNS, a relative URL on a server) propagate
    // as-is: a throw is the transient signal in the resolver contract.
    const res = await fetch(endpoint, {
      method: 'POST',
      credentials: 'include',
    });

    // The login itself is gone — terminal. Only these two statuses sign out.
    if (res.status === 401 || res.status === 403) return null;

    // 5xx / 429 / anything unexpected: the login may be perfectly valid —
    // transient, retry later.
    if (!res.ok) {
      throw new Error(
        `credential endpoint ${endpoint} answered ${res.status} — transient, will retry`,
      );
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new Error(
        `credential endpoint ${endpoint} returned non-JSON — expected { token }`,
      );
    }

    // Distinguish "explicitly signed out" (`{ token: null }`) from "not a mint
    // endpoint at all" (no `token` key). A misconfiguration must fail loudly and
    // transiently, never as a silent sign-out.
    if (typeof body !== 'object' || body === null || !('token' in body)) {
      throw new Error(
        `credential endpoint ${endpoint} returned no \`token\` field — expected { token }`,
      );
    }
    const token = body.token;
    if (token === null || token === undefined) return null;
    if (typeof token !== 'string') {
      throw new Error(
        `credential endpoint ${endpoint} returned a non-string \`token\``,
      );
    }
    return token;
  };
}
