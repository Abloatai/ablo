/**
 * BaseSyncedStore.createConnectionManager — participant-kind gate.
 *
 * Background: ConnectionManager's FSM is built around browser events
 * (visibilitychange, online/offline, watchdog). On agent hosts (Node,
 * headless workers) those listeners early-return because `window` is
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
import type { ParticipantKind } from '@abloatai/transaction/types/participant';
import { storeDependencies } from '../../src/local/testing/helpers/storeDependencies';

/** A real store, constructed from real collaborators, exposing the protected factory. */
class FactoryProbe extends BaseSyncedStore {
  connectionManagerFor(kind?: ParticipantKind) {
    return this.createConnectionManager(kind);
  }
}

function makeShell(syncServerUrl: string): FactoryProbe {
  const deps = storeDependencies();
  return new FactoryProbe({ ...deps, url: syncServerUrl });
}

describe('BaseSyncedStore.createConnectionManager — participant kind gate', () => {
  it('returns null for agent participants', () => {
    const shell = makeShell('ws://localhost:8080');
    expect(shell.connectionManagerFor('agent')).toBeNull();
  });

  it('returns a ConnectionManager for user participants', () => {
    const shell = makeShell('ws://localhost:8080');
    const cm = shell.connectionManagerFor('user');
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
    const cm = shell.connectionManagerFor('system');
    expect(cm).not.toBeNull();
    cm?.dispose();
  });

  it('returns a ConnectionManager when kind is undefined (backwards compatibility)', () => {
    // Older call sites that didn't pass `kind` shouldn't lose the FSM.
    const shell = makeShell('ws://localhost:8080');
    const cm = shell.connectionManagerFor(undefined);
    expect(cm).not.toBeNull();
    cm?.dispose();
  });
});
