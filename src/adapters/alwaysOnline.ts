/**
 * An {@link OnlineStatusProvider} that always reports the client as online.
 * Server-side runtimes — Node processes, agents, and sidecars — have no
 * browser network stack to lose, so there is no offline state to track. A
 * dropped database connection surfaces as a database error, not a network
 * transition. This is the server-side counterpart to the browser's
 * connectivity-aware provider, which watches the real online/offline signal.
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
