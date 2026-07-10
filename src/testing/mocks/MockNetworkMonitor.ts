/**
 * A test double for {@link OnlineStatusProvider} that lets tests flip the
 * connection between online and offline on demand. Alongside its own state, it
 * updates the global `navigator.onLine` flag so code that reads the browser
 * value directly sees the same status.
 */

import type { OnlineStatusProvider } from '../../interfaces/index.js';

export class MockNetworkMonitor implements OnlineStatusProvider {
  private _online: boolean;

  constructor(initialOnline = true) {
    this._online = initialOnline;
  }

  isOnline(): boolean {
    return this._online;
  }

  /** Marks the connection online and sets `navigator.onLine` to true. */
  goOnline(): void {
    this._online = true;
    // Also update navigator.onLine for code that reads it directly
    Object.defineProperty(navigator, 'onLine', {
      writable: true,
      value: true,
    });
  }

  /** Marks the connection offline and sets `navigator.onLine` to false. */
  goOffline(): void {
    this._online = false;
    Object.defineProperty(navigator, 'onLine', {
      writable: true,
      value: false,
    });
  }

  /** Flips between online and offline, returning the new online state. */
  toggle(): boolean {
    if (this._online) {
      this.goOffline();
    } else {
      this.goOnline();
    }
    return this._online;
  }

  /** Returns the monitor to its online starting state. */
  reset(): void {
    this.goOnline();
  }
}
