/**
 * BaseSyncedStore.createConnectionManager — participant-kind gate.
 *
 * Background: ConnectionManager's FSM is built around browser events
 * (visibilitychange, online/offline, watchdog). On agent hosts (Node,
 * agent-worker) those listeners early-return because `window` is
 * undefined, leaving the FSM with no way to drive recovery once it
 * enters `offline`. Worse, the `offline` entry action calls
 * `syncWebSocket.disconnect()` which cancels the reconnect that
 * `SyncWebSocket.onclose` had just scheduled — the two recovery
 * systems fight and the browser-only one wins by destroying the
 * Node-compatible one's work.
 *
 * Fix: `createConnectionManager(kind)` returns `null` for `kind ===
 * 'agent'`, leaving `SyncWebSocket.scheduleReconnect` as the sole
 * recovery path. Browser users keep the FSM (with full
 * online/offline/visibility recovery).
 *
 * This test pins that contract so a future refactor can't silently
 * remove the gate. See `feedback_node_ws_reconnect_and_http_auth.md`.
 */

import { BaseSyncedStore } from '../../src/local/BaseSyncedStore';
import type { ConnectionManager } from '../../src/local/sync/ConnectionManager';

// Tiny shell that exposes the protected factory. We instantiate via
// Object.create to skip the real (heavy) constructor — the method
// under test reads only `_syncServerUrl` from `this`.
function makeShell(syncServerUrl: string): {
  create: (kind?: 'user' | 'agent' | 'system') => ConnectionManager | null;
} {
  const shell = Object.create(BaseSyncedStore.prototype) as Record<string, unknown>;
  shell._syncServerUrl = syncServerUrl;
  const fn = (
    BaseSyncedStore.prototype as unknown as {
      createConnectionManager: (
        this: unknown,
        kind?: 'user' | 'agent' | 'system',
      ) => ConnectionManager | null;
    }
  ).createConnectionManager;
  return { create: (kind) => fn.call(shell, kind) };
}

describe('BaseSyncedStore.createConnectionManager — participant kind gate', () => {
  it('returns null for agent participants', () => {
    const shell = makeShell('ws://localhost:8080');
    expect(shell.create('agent')).toBeNull();
  });

  it('returns a ConnectionManager for user participants', () => {
    const shell = makeShell('ws://localhost:8080');
    const cm = shell.create('user');
    expect(cm).not.toBeNull();
    expect(cm).toBeDefined();
    cm?.dispose();
  });

  it('returns a ConnectionManager for system participants (treated as user-like)', () => {
    // System participants are headless but typically run on hosts that
    // can drive their own retry — keep them on the FSM unless and
    // until we see a real divergence. The gate is intentionally
    // narrow: ONLY 'agent' is special-cased.
    const shell = makeShell('ws://localhost:8080');
    const cm = shell.create('system');
    expect(cm).not.toBeNull();
    cm?.dispose();
  });

  it('returns a ConnectionManager when kind is undefined (backwards compatibility)', () => {
    // Older call sites that didn't pass `kind` shouldn't lose the FSM.
    const shell = makeShell('ws://localhost:8080');
    const cm = shell.create(undefined);
    expect(cm).not.toBeNull();
    cm?.dispose();
  });
});
