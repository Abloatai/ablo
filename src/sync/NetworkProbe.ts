/**
 * NetworkProbe - Reliable network + session connectivity detection
 *
 * navigator.onLine is unreliable: it reports true whenever the device has a LAN
 * connection, even without actual internet access (MDN docs confirm this).
 * After laptop sleep/wake, it may report true before WiFi/DNS are functional.
 *
 * This module provides an authenticated probe against the sync server to verify
 * real connectivity + credential validity in a single round-trip. The probe
 * hits `/api/auth/check`, which runs the SAME auth middleware as the WebSocket
 * upgrade path, and classifies the response into a single {@link ProbeOutcome}
 * via the closed recovery taxonomy ({@link classifyRecovery}):
 *   204 No Content                         → `reachable`        (credential valid)
 *   401 `apikey_expired` (ephemeral key)   → `credential_stale` (re-mint & retry, NO sign-out)
 *   401 `session_expired` / bare 401       → `session_expired`  (sign out)
 *   401/403 credential-type/config/perm    → `auth_blocked`     (stop, no loop, no sign-out)
 *   network fail / offline                 → `unreachable`
 *
 * This closes a real gap: the browser's WebSocket API hides HTTP status from
 * the handshake, so a 401 on the WS upgrade surfaces only as `close code
 * 1006`. Without this HTTP probe, the client cannot distinguish auth failure
 * from a network blip and loops reconnecting forever instead of redirecting
 * the user to sign-in.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Navigator/onLine
 */

import { z } from 'zod';
import { getContext } from '../context.js';
import { classifyRecovery } from '../errors.js';
import { withAuthHeaders, type AuthTokenGetter } from '../auth/credentialSource.js';

/**
 * The closed set of probe outcomes — one value carrying both reachability and
 * credential disposition, so the {@link ConnectionManager} branches on a single
 * exhaustive discriminant instead of reconstructing intent from a trio of
 * booleans. Mirrors the {@link RecoveryClass} taxonomy at the connectivity tier.
 */
export const PROBE_OUTCOMES = [
  /** Server reachable and the access credential is currently valid. */
  'reachable',
  /** Could not reach the server (offline / DNS / TLS / timeout). */
  'unreachable',
  /** Reachable, but the long-lived login is gone → terminal, sign out. */
  'session_expired',
  /** Reachable, but the ephemeral access key (`ek_`/`rk_`) expired → silently
   *  re-mint a fresh key from the still-valid login and retry. NOT a sign-out. */
  'credential_stale',
  /** Reachable, but the credential TYPE/config was rejected (wrong key kind,
   *  untrusted issuer, no org, a 403) → stop; neither reconnecting nor re-auth
   *  helps. Distinct from a sign-out. */
  'auth_blocked',
] as const;

/** Zod enum derived from {@link PROBE_OUTCOMES}. */
export const probeOutcomeSchema = z.enum(PROBE_OUTCOMES);

/** A single probe outcome. See {@link PROBE_OUTCOMES}. */
export type ProbeOutcome = z.infer<typeof probeOutcomeSchema>;

/** Result of a network probe: a single {@link ProbeOutcome} plus round-trip
 *  latency (null when the probe never completed). */
export const probeResultSchema = z.object({
  outcome: probeOutcomeSchema,
  latencyMs: z.number().nullable(),
});

/** @see {@link probeResultSchema} */
export type ProbeResult = z.infer<typeof probeResultSchema>;

const PROBE_TIMEOUT_MS = 4000;

export interface NetworkProbeOptions {
  /**
   * Sync-server base URL (HTTP or WS scheme accepted). If omitted, falls
   * back to the legacy `NEXT_PUBLIC_GO_SERVER_URL` default.
   */
  baseUrl?: string;
  /**
   * Optional bearer credential. Browser cookie deployments can omit this;
   * bearer-first deployments must pass the same `ek_`/`rk_` token used by
   * bootstrap and the WebSocket upgrade.
   */
  getAuthToken?: AuthTokenGetter;
  /** Compatibility fallback for callers with a copied token string. */
  authToken?: string | null;
}

/**
 * Derive the probe URL from a sync-server base URL. Accepts `ws://`,
 * `wss://`, `http://`, `https://`, or a bare host — mirrors the
 * normalisation in `BootstrapHelper` / `createSyncEngine`.
 */
function resolveProbeUrl(baseUrl?: string): string {
  // Fall back to the legacy env var so callers that haven't been migrated
  // to pass an explicit baseUrl keep working.
  const resolved =
    baseUrl ??
    (typeof process !== 'undefined' ? process.env?.NEXT_PUBLIC_GO_SERVER_URL : undefined) ??
    'http://localhost:8080';

  // Normalize ws → http so fetch() accepts the URL. Strip any trailing slash
  // so we don't produce `//api/auth/check`.
  const httpBase = resolved.replace(/^ws/, 'http').replace(/\/+$/, '');
  return `${httpBase}/api/auth/check`;
}

/**
 * Probe the sync engine server with a lightweight HEAD request.
 *
 * Returns reachability AND session status in a single call, so the
 * ConnectionStore can make the right state transition without guessing.
 *
 * @param input The sync-server base URL (HTTP or WS scheme accepted), or an
 *              options bag with `authToken`. A bare string is still accepted
 *              for backwards compatibility.
 */
export async function probeNetwork(input?: string | NetworkProbeOptions): Promise<ProbeResult> {
  const baseUrl = typeof input === 'string' ? input : input?.baseUrl;
  const getAuthToken = typeof input === 'string' ? undefined : input?.getAuthToken;
  const authToken = typeof input === 'string' ? undefined : input?.authToken;
  const url = resolveProbeUrl(baseUrl);

  // Fast-fail: if navigator.onLine is false, skip the probe entirely.
  // This is the ONE case where navigator.onLine is reliable (MDN: "false
  // means definitely offline"). Use `=== false` rather than `!onLine`
  // because Node 22+ exposes `navigator` with `onLine === undefined`,
  // and `!undefined === true` would short-circuit the probe server-side.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { outcome: 'unreachable', latencyMs: null };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const start = performance.now();

  try {
    const headers = withAuthHeaders(
      getAuthToken,
      { 'Cache-Control': 'no-cache' },
      authToken,
    );

    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      // Cache-bust to avoid stale responses
      headers,
    });

    const latencyMs = Math.round(performance.now() - start);

    // The probe is a HEAD (no body), but the sync-server sets `X-Auth-Failure:
    // <code>` on every auth rejection. Route the code through the closed
    // recovery taxonomy so each failure mode gets its correct outcome — the
    // whole reason this taxonomy exists: an expired ephemeral key
    // (`access_credential_expiry`) must re-mint, NOT sign the user out the way
    // a genuine login expiry (`session_expiry`) does, and NOT wedge the way a
    // credential-type/config rejection (`auth_blocked`) does.
    const authFailure = response.headers.get('x-auth-failure');
    if (authFailure) {
      const recovery = classifyRecovery(authFailure);
      switch (recovery) {
        case 'session_expiry':
          getContext().logger.info('[NetworkProbe] Server reachable, login expired', {
            status: response.status,
            code: authFailure,
            latencyMs,
          });
          return { outcome: 'session_expired', latencyMs };
        case 'access_credential_expiry':
          getContext().logger.info('[NetworkProbe] Server reachable, access key stale — will re-mint', {
            status: response.status,
            code: authFailure,
            latencyMs,
          });
          return { outcome: 'credential_stale', latencyMs };
        case 'auth_blocked':
        case 'permission':
        case 'none':
          // A non-expiry auth rejection — wrong credential type/config, a 403,
          // or an auth-tagged code this SDK doesn't recognise. Re-auth re-mints
          // the same rejected credential and retrying won't help, so STOP
          // rather than reconnect-loop or sign the user out.
          getContext().logger.warn('[NetworkProbe] Reachable but auth-blocked (non-retryable, non-expiry)', {
            status: response.status,
            code: authFailure,
            recovery,
            latencyMs,
          });
          return { outcome: 'auth_blocked', latencyMs };
        case 'transient':
          // Retryable auth-tagged response — connectivity is proven; fall
          // through to `reachable` and let the normal retry path handle it.
          break;
        default: {
          const _exhaustive: never = recovery;
          void _exhaustive;
        }
      }
    } else if (response.status === 401) {
      // Bare 401 with no READABLE structured code. This is AMBIGUOUS and must
      // NOT sign the user out on its own — two common causes are both
      // recoverable, and only one is a real logout:
      //   1. The server DID send `X-Auth-Failure: apikey_expired`, but it's a
      //      custom header on a cross-origin response and the server didn't list
      //      it in `Access-Control-Expose-Headers`, so the browser stripped it to
      //      null (the network-change logout bug). The access key just needs a
      //      re-mint.
      //   2. A genuinely expired access key on a non-Ablo proxy / cookie path.
      // So route to `credential_stale`: the FSM attempts a re-mint, and the ONLY
      // way to actually sign out is the re-mint resolving `null` (login truly
      // gone). If no refresher is wired, the bounded attempt counter falls
      // through to `auth_blocked` (stop) — still never a spurious logout. This
      // upholds the invariant: null is the only terminal path, never a bare 401.
      getContext().logger.info('[NetworkProbe] Server reachable, bare 401 — re-mint (not sign-out)', {
        latencyMs,
      });
      return { outcome: 'credential_stale', latencyMs };
    }

    // 2xx (including 204) means reachable + credential valid.
    // 3xx/4xx (non-auth) still prove connectivity even though the probe
    // expected 204; log a warning so misconfigurations surface instead of
    // silently passing.
    if (response.status < 200 || response.status >= 300) {
      getContext().logger.warn('[NetworkProbe] Unexpected probe response', {
        status: response.status,
        url,
        latencyMs,
      });
    } else {
      getContext().logger.debug('[NetworkProbe] Server reachable, credential valid', {
        status: response.status,
        latencyMs,
      });
    }
    return { outcome: 'reachable', latencyMs };
  } catch (error) {
    clearTimeout(timeout);

    const isAbort = error instanceof DOMException && error.name === 'AbortError';
    getContext().logger.info('[NetworkProbe] Probe failed', {
      reason: isAbort ? 'timeout' : (error as Error).message,
    });

    return { outcome: 'unreachable', latencyMs: null };
  } finally {
    clearTimeout(timeout);
  }
}
