/**
 * Detects real network and session connectivity for the sync engine. It exists
 * because `navigator.onLine` is unreliable: it reports true whenever the device
 * has a local network connection, even with no route to the internet, and after
 * sleep/wake it can report true before Wi-Fi or DNS are working again.
 *
 * The probe makes one authenticated request to the sync server's
 * `/api/auth/check` endpoint — which runs the same auth middleware as the
 * WebSocket upgrade — and classifies the response into a single
 * {@link ProbeOutcome} through the recovery taxonomy ({@link classifyRecovery}):
 *   204 No Content                         → `reachable`        (credential valid)
 *   401 `apikey_expired` (ephemeral key)   → `credential_stale` (re-mint and retry, no sign-out)
 *   401 `session_expired` / bare 401       → `session_expired`  (sign out)
 *   401/403 credential-type/config/perm    → `auth_blocked`     (stop; no loop, no sign-out)
 *   network failure / offline              → `unreachable`
 *
 * This closes a real gap. The browser's WebSocket API hides the HTTP status of
 * a failed handshake, so a 401 on the upgrade surfaces only as close code 1006.
 * Without this HTTP probe, the client cannot tell an auth failure from a network
 * blip, and loops reconnecting forever instead of sending the user to sign in.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Navigator/onLine
 */

import { z } from 'zod';
import { classifyRecovery } from '../../errors.js';
import { withAuthHeaders, type AuthTokenGetter } from '../../auth/credentialSource.js';
import { ABLO_DEFAULT_BASE_URL } from '../../auth/hostedEndpoints.js';
import { noopLogger, type Logger } from '../../logger.js';

/**
 * The complete set of probe outcomes. Each value carries both reachability and
 * credential state, so the connection state machine can branch on one exhaustive
 * discriminant instead of piecing the situation together from several booleans.
 * It mirrors the `RecoveryClass` taxonomy at the connectivity layer.
 */
export const PROBE_OUTCOMES = [
  /** Server reachable and the access credential is currently valid. */
  'reachable',
  /** Could not reach the server (offline, DNS, TLS, or timeout). */
  'unreachable',
  /** Reachable, but the long-lived login is gone. Terminal: sign out. */
  'session_expired',
  /** Reachable, but the ephemeral access key (`ek_`/`rk_`) expired. Silently
   *  re-mint a fresh key from the still-valid login and retry; not a sign-out. */
  'credential_stale',
  /** Reachable, but the credential's type or configuration was rejected (wrong
   *  key kind, untrusted issuer, no organization, or a 403). Stop: neither
   *  reconnecting nor re-authenticating helps. Distinct from a sign-out. */
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
   * Sync-server base URL (HTTP or WS scheme accepted). If omitted, the probe
   * targets the canonical hosted endpoint ({@link ABLO_DEFAULT_BASE_URL}) —
   * the same default `Ablo()` resolves.
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
  /** Where probe outcomes are logged. Defaults to silent. */
  logger?: Logger;
}

/**
 * Derive the probe URL from a sync-server base URL. Accepts `ws://`,
 * `wss://`, `http://`, `https://`, or a bare host — mirrors the
 * normalisation in `BootstrapFetcher` / `createSyncEngine`.
 */
function resolveProbeUrl(baseUrl?: string): string {
  // No explicit baseUrl → probe the canonical hosted endpoint, matching the
  // `Ablo()` default.
  const resolved = baseUrl ?? ABLO_DEFAULT_BASE_URL;

  // Normalize ws → http so fetch() accepts the URL. Strip any trailing slash
  // so we don't produce `//api/auth/check`.
  const httpBase = resolved.replace(/^ws/, 'http').replace(/\/+$/, '');
  return `${httpBase}/api/auth/check`;
}

/**
 * Probes the sync server with a lightweight HEAD request, returning both
 * reachability and session status in a single call so the connection state
 * machine can pick the right transition without guessing.
 *
 * @param input The sync-server base URL (an HTTP or WS scheme is accepted), or
 *              an options bag. A bare string is also accepted.
 */
export async function probeNetwork(input?: string | NetworkProbeOptions): Promise<ProbeResult> {
  const baseUrl = typeof input === 'string' ? input : input?.baseUrl;
  const getAuthToken = typeof input === 'string' ? undefined : input?.getAuthToken;
  const authToken = typeof input === 'string' ? undefined : input?.authToken;
  const logger = (typeof input === 'string' ? undefined : input?.logger) ?? noopLogger;
  const url = resolveProbeUrl(baseUrl);

  // Fast-fail: if navigator.onLine is false, skip the probe entirely. This is
  // the one case where navigator.onLine is reliable (MDN: "false means
  // definitely offline"). Use `=== false` rather than `!onLine` because Node
  // 22+ exposes `navigator` with `onLine === undefined`, and `!undefined` is
  // true, which would short-circuit the probe server-side.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { outcome: 'unreachable', latencyMs: null };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => { controller.abort(); }, PROBE_TIMEOUT_MS);
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

    // The probe is a HEAD request (no body), but the server sets
    // `X-Auth-Failure: <code>` on every auth rejection. Route the code through
    // the recovery taxonomy so each failure mode gets its correct outcome. That
    // distinction is the whole point: an expired ephemeral key
    // (`access_credential_expiry`) must re-mint, not sign the user out the way a
    // genuine login expiry (`session_expiry`) does, and not wedge the way a
    // credential type or configuration rejection (`auth_blocked`) does.
    const authFailure = response.headers.get('x-auth-failure');
    if (authFailure) {
      const recovery = classifyRecovery(authFailure);
      switch (recovery) {
        case 'session_expiry':
          logger.info('[NetworkProbe] Server reachable, login expired', {
            status: response.status,
            code: authFailure,
            latencyMs,
          });
          return { outcome: 'session_expired', latencyMs };
        case 'access_credential_expiry':
          logger.info('[NetworkProbe] Server reachable, access key stale — will re-mint', {
            status: response.status,
            code: authFailure,
            latencyMs,
          });
          return { outcome: 'credential_stale', latencyMs };
        case 'auth_blocked':
        case 'permission':
        case 'none':
          // A non-expiry auth rejection — wrong credential type or config, a
          // 403, or an auth-tagged code this SDK does not recognise.
          // Re-authenticating re-mints the same rejected credential and
          // retrying will not help, so stop rather than reconnect-loop or sign
          // the user out.
          logger.debug('[NetworkProbe] Reachable but auth-blocked (non-retryable, non-expiry)', {
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
      // Bare 401 with no readable structured code. This is ambiguous and must
      // not sign the user out on its own — two common causes are both
      // recoverable, and only one is a real logout:
      //   1. The server did send `X-Auth-Failure: apikey_expired`, but it is a
      //      custom header on a cross-origin response the server did not list in
      //      `Access-Control-Expose-Headers`, so the browser stripped it to
      //      null. The access key just needs a re-mint.
      //   2. A genuinely expired access key on a non-Ablo proxy or cookie path.
      // So route to `credential_stale`: the state machine attempts a re-mint,
      // and the only way to actually sign out is that re-mint resolving `null`
      // (the login is truly gone). If no refresher is wired, the bounded attempt
      // counter falls through to `auth_blocked` (stop) — still never a spurious
      // logout. The invariant holds: null is the only terminal path, never a
      // bare 401.
      logger.info('[NetworkProbe] Server reachable, bare 401 — re-mint (not sign-out)', {
        latencyMs,
      });
      return { outcome: 'credential_stale', latencyMs };
    }

    // 2xx (including 204) means reachable + credential valid.
    // 3xx/4xx (non-auth) still prove connectivity even though the probe
    // expected 204; log a warning so misconfigurations surface instead of
    // silently passing.
    if (response.status < 200 || response.status >= 300) {
      logger.debug('[NetworkProbe] Unexpected probe response', {
        status: response.status,
        url,
        latencyMs,
      });
    } else {
      logger.debug('[NetworkProbe] Server reachable, credential valid', {
        status: response.status,
        latencyMs,
      });
    }
    return { outcome: 'reachable', latencyMs };
  } catch (error) {
    clearTimeout(timeout);

    const isAbort = error instanceof DOMException && error.name === 'AbortError';
    logger.info('[NetworkProbe] Probe failed', {
      reason: isAbort ? 'timeout' : (error as Error).message,
    });

    return { outcome: 'unreachable', latencyMs: null };
  } finally {
    clearTimeout(timeout);
  }
}
