/**
 * MockNetworkMonitor — Test double for OnlineStatusProvider.
 *
 * Allows tests to programmatically toggle online/offline state
 * and trigger visibility change events.
 */

import type { OnlineStatusProvider } from '../../interfaces';

export class MockNetworkMonitor implements OnlineStatusProvider {
  private _online: boolean;

  constructor(initialOnline = true) {
    this._online = initialOnline;
  }

  isOnline(): boolean {
    return this._online;
  }

  /** Simulate going online */
  goOnline(): void {
    this._online = true;
    // Also update navigator.onLine for code that reads it directly
    Object.defineProperty(navigator, 'onLine', {
      writable: true,
      value: true,
    });
  }

  /** Simulate going offline */
  goOffline(): void {
    this._online = false;
    Object.defineProperty(navigator, 'onLine', {
      writable: true,
      value: false,
    });
  }

  /** Toggle online state and return new value */
  toggle(): boolean {
    if (this._online) {
      this.goOffline();
    } else {
      this.goOnline();
    }
    return this._online;
  }

  /** Reset to initial state (online) */
  reset(): void {
    this.goOnline();
  }
}
