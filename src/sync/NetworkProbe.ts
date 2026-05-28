/**
 * NetworkProbe - Reliable network + session connectivity detection
 *
 * navigator.onLine is unreliable: it reports true whenever the device has a LAN
 * connection, even without actual internet access (MDN docs confirm this).
 * After laptop sleep/wake, it may report true before WiFi/DNS are functional.
 *
 * This module provides an authenticated probe against the sync server to verify
 * real connectivity + session validity in a single round-trip. The probe hits
 * `/api/auth/check`, which runs the SAME auth middleware as the WebSocket
 * upgrade path:
 *   204 No Content → reachable, session cookie valid
 *   401/403        → reachable, session expired or invalid
 *   network fail   → unreachable
 *
 * This closes a real gap: the browser's WebSocket API hides HTTP status from
 * the handshake, so a 401 on the WS upgrade surfaces only as `close code
 * 1006`. Without this HTTP probe, the client cannot distinguish auth failure
 * from a network blip and loops reconnecting forever instead of redirecting
 * the user to sign-in.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Navigator/onLine
 */

import { getContext } from '../context.js';
import { SyncSessionError } from '../errors.js';

/** Result of a network probe */
export interface ProbeResult {
  /** Whether the server was reachable */
  reachable: boolean;
  /** Whether the session cookie is still valid (null if server unreachable) */
  sessionValid: boolean | null;
  /** Round-trip time in ms (null if failed) */
  latencyMs: number | null;
}

const PROBE_TIMEOUT_MS = 4000;

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
 * @param baseUrl The sync-server base URL (HTTP or WS scheme accepted).
 *                If omitted, falls back to `NEXT_PUBLIC_GO_SERVER_URL` →
 *                `http://localhost:8080` for backwards compatibility.
 */
export async function probeNetwork(baseUrl?: string): Promise<ProbeResult> {
  const url = resolveProbeUrl(baseUrl);

  // Fast-fail: if navigator.onLine is false, skip the probe entirely.
  // This is the ONE case where navigator.onLine is reliable (MDN: "false
  // means definitely offline"). Use `=== false` rather than `!onLine`
  // because Node 22+ exposes `navigator` with `onLine === undefined`,
  // and `!undefined === true` would short-circuit the probe server-side.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { reachable: false, sessionValid: null, latencyMs: null };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const start = performance.now();

  try {
    const response = await fetch(url, {
      method: 'HEAD',
      credentials: 'include', // Send cookies for session check
      signal: controller.signal,
      // Cache-bust to avoid stale responses
      headers: { 'Cache-Control': 'no-cache' },
    });

    const latencyMs = Math.round(performance.now() - start);

    if (SyncSessionError.isSessionErrorResponse(response.status)) {
      // Server reachable but session expired/invalid
      getContext().logger.info('[NetworkProbe] Server reachable, session expired', {
        status: response.status,
        latencyMs,
      });
      return { reachable: true, sessionValid: false, latencyMs };
    }

    // 2xx (including 204) means reachable + session valid.
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
      getContext().logger.debug('[NetworkProbe] Server reachable, session valid', {
        status: response.status,
        latencyMs,
      });
    }
    return { reachable: true, sessionValid: true, latencyMs };
  } catch (error) {
    clearTimeout(timeout);

    const isAbort = error instanceof DOMException && error.name === 'AbortError';
    getContext().logger.info('[NetworkProbe] Probe failed', {
      reason: isAbort ? 'timeout' : (error as Error).message,
    });

    return { reachable: false, sessionValid: null, latencyMs: null };
  } finally {
    clearTimeout(timeout);
  }
}
