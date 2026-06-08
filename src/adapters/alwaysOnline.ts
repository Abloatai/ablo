/**
 * Always-online network provider — for Node.js / agent / sidecar.
 *
 * The server IS the network — it doesn't go offline. If the Postgres
 * connection drops, that's a database error, not a network error.
 * The "online/offline" concept only applies to browser clients that
 * can lose their WiFi connection.
 *
 * Implements OnlineStatusProvider (same interface as browserOnlineStatus).
 */

import type { OnlineStatusProvider } from '../interfaces/index.js';

/**
 * Returns an OnlineStatusProvider that always reports online.
 * `onStatusChange` never fires — the network never transitions.
 */
export function alwaysOnline(): OnlineStatusProvider {
  return {
    isOnline: () => true,
  };
}
