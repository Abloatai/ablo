/**
 * NetworkMonitor tracks network connectivity and reports it through events.
 * It listens to the browser's online and offline events, and it also watches
 * for a tab becoming visible again: after a laptop sleep/wake or a long spell
 * in the background, the WebSocket can die silently without an offline event
 * firing, so returning to the tab emits a recovery signal the store can act on.
 */

import { EventEmitter } from 'events';
import { globalRuntime } from './context.js';
import type { RuntimeContext } from './RuntimeContext.js';

export class NetworkMonitor extends EventEmitter {
  // Only `navigator.onLine === false` means offline. Node 18+ exposes a global
  // `navigator` with `onLine === undefined`, so the naive `navigator.onLine`
  // would seed `false` (offline) on every server client — start optimistic.
  // DOM types say `onLine` is boolean, but Node exposes it as undefined.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare
  private isOnline = !(typeof navigator !== 'undefined' && navigator.onLine === false);
  private lastOnlineCheck: Date = new Date();

  constructor(private readonly runtime: RuntimeContext = globalRuntime) {
    super();
    this.setupListeners();
  }

  private handleOnline = (): void => {
    const wasOffline = !this.isOnline;
    this.isOnline = true;
    this.lastOnlineCheck = new Date();
    if (wasOffline) {
      this.runtime.logger.info('Network connection restored');
      this.emit('online');
    }
  };

  private handleOffline = (): void => {
    const wasOnline = this.isOnline;
    this.isOnline = false;
    if (wasOnline) {
      // Symmetric with 'Network connection restored' (info) — expected,
      // transient connectivity state, not an actionable warning.
      this.runtime.logger.info('Network connection lost');
      this.emit('offline');
    }
  };

  /**
   * When the tab becomes visible, the WebSocket may have silently died
   * (e.g., laptop sleep/wake, long background). Browser online/offline events
   * don't fire in this case because the network itself didn't change.
   * Emit 'visibility_online' so SyncedStore can check and recover.
   */
  private handleVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible') return;

    // Update navigator.onLine state — it may have changed while hidden
    this.isOnline = navigator.onLine;
    this.lastOnlineCheck = new Date();

    if (this.isOnline) {
      this.runtime.logger.info('Tab became visible with network available — emitting visibility_online');
      this.emit('visibility_online');
    }
  };

  private setupListeners(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener('online', this.handleOnline);
    window.addEventListener('offline', this.handleOffline);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
  }

  getStatus(): boolean {
    return this.isOnline;
  }

  getLastOnlineTime(): Date {
    return this.lastOnlineCheck;
  }

  dispose(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleOnline);
      window.removeEventListener('offline', this.handleOffline);
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
    this.removeAllListeners();
  }
}
