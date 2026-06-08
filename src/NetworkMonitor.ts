/**
 * NetworkMonitor - Network connectivity tracking with visibility awareness
 *
 * Monitors online/offline state using browser events AND visibility changes.
 * When a tab becomes visible after being hidden (e.g., laptop sleep/wake),
 * the WebSocket may have silently died without triggering online/offline events.
 * The visibility handler detects this and emits 'online' to trigger recovery.
 */

import { EventEmitter } from 'events';
import { getContext } from './context.js';

export class NetworkMonitor extends EventEmitter {
  private isOnline: boolean = typeof navigator !== 'undefined' ? navigator.onLine : true;
  private lastOnlineCheck: Date = new Date();

  constructor() {
    super();
    this.setupListeners();
  }

  private handleOnline = async (): Promise<void> => {
    const wasOffline = !this.isOnline;
    this.isOnline = true;
    this.lastOnlineCheck = new Date();
    if (wasOffline) {
      getContext().logger.info('Network connection restored');
      this.emit('online');
    }
  };

  private handleOffline = (): void => {
    const wasOnline = this.isOnline;
    this.isOnline = false;
    if (wasOnline) {
      getContext().logger.warn('Network connection lost');
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
      getContext().logger.info('Tab became visible with network available — emitting visibility_online');
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
