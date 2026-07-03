/**
 * credentialEndpoint — the endpoint-string shape of `apiKey`.
 *
 * `Ablo({ schema, apiKey: '/api/ablo-session' })` — point the client at your
 * session-mint route and the SDK owns the exchange: it POSTs the endpoint,
 * parses the minted token, keeps it fresh (the credential lifecycle), and
 * classifies failures onto the resolver tri-state. This is the Ably `authUrl`
 * / Liveblocks `authEndpoint` model — the string form is the 95% case; the
 * function form of `apiKey` remains the escape hatch for custom headers,
 * bodies, or non-HTTP mints.
 *
 * Detection is by prefix: a string starting with `/`, `http://`, or
 * `https://` is an endpoint; anything else is a literal key. Real Ablo keys
 * are `sk_`/`pk_`/`ek_`/`rk_`-prefixed, so the two shapes cannot collide.
 * (`ABLO_API_KEY` env values are NEVER endpoint-detected — the env var is
 * always a literal key; see `resolveApiKey`.)
 *
 * Wire contract — matches the `ablo init` scaffold route exactly:
 *   POST <endpoint>  (same-origin, `credentials: 'include'` so cookies flow)
 *   → 200 `{ token, expiresAt? }`      fresh short-lived `ek_`/`rk_`
 *   → 200 `{ token: null }` or 401/403 the login itself is gone (sign out)
 *   → anything else                    transient — retry, NEVER sign out
 *
 * The tri-state mapping is the whole point of building this in: hand-written
 * thunks routinely get it wrong (mapping any `!res.ok` to `null` signs the
 * user out on a 500). Encoded here once, every consumer inherits the correct
 * terminal-vs-transient split (the Liveblocks `{ error: "forbidden" }` vs
 * retry contract, translated to HTTP statuses).
 */

/**
 * Async callable that resolves the current credential. Mirrors the shape
 * Anthropic / OpenAI / Stripe ship — used for credential rotation
 * (e.g. AWS STS, GCP IAM, Vault) AND the short-lived per-user browser
 * path (mint a fresh `ek_`/`rk_` from the signed-in session). Re-exported
 * from `./auth` (and thence `./Ablo`) so existing import paths work; defined
 * in this leaf so the credential resolver it types has no import cycle.
 *
 * Contract: resolve a token; resolve `null` when the login itself is gone
 * (terminal → the credential lifecycle treats this as `session_expired` and
 * signs out); or THROW on a transient failure (→ back off and retry, never
 * sign out). A long-lived static `apiKey` string needs none of this — it is
 * used as-is. This is the single credential resolver the SDK supports.
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
 * Build the resolver behind an endpoint-string `apiKey`. Conforms to the
 * `ApiKeySetter` contract end-to-end:
 *   - resolves the minted token string on success,
 *   - resolves `null` when the login is gone (401/403, or an explicit
 *     `{ token: null }`) → terminal, the client signs out,
 *   - THROWS on anything transient (network failure, 5xx/429, malformed
 *     response) → the lifecycle backs off and retries, never signs out.
 *
 * A relative endpoint invoked server-side (Node fetch has no origin) throws —
 * transient by contract, and `credentialLifecycle` already translates that
 * exact failure into an actionable "use an absolute URL server-side" warning.
 */
export function createEndpointCredentialResolver(endpoint: string): ApiKeySetter {
  return async (): Promise<string | null> => {
    // fetch() rejections (offline, DNS, relative URL in Node) propagate as-is:
    // a throw IS the transient signal in the resolver contract.
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

    // Distinguish "explicitly signed out" ({ token: null }) from "not a mint
    // endpoint at all" (no `token` key — misconfiguration must be LOUD and
    // transient, never a silent sign-out).
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
