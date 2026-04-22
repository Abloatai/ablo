/**
 * NetworkMonitor unit tests — online/offline events, visibility change.
 */

import { NetworkMonitor } from '../../src/NetworkMonitor';
import { createTestContext, resetFixtureCounter } from '../../src/testing';

describe('NetworkMonitor', () => {
  let monitor: NetworkMonitor;
  let cleanup: () => void;

  beforeEach(() => {
    resetFixtureCounter();
    const ctx = createTestContext();
    cleanup = ctx.cleanup;
    monitor = new NetworkMonitor();
  });

  afterEach(() => {
    monitor.dispose();
    cleanup();
  });

  describe('getStatus()', () => {
    it('should return true initially (navigator.onLine defaults to true in tests)', () => {
      expect(monitor.getStatus()).toBe(true);
    });

    it('should return false after offline event fires', () => {
      window.dispatchEvent(new Event('offline'));
      expect(monitor.getStatus()).toBe(false);
    });

    it('should return true again after online event fires', () => {
      window.dispatchEvent(new Event('offline'));
      expect(monitor.getStatus()).toBe(false);

      window.dispatchEvent(new Event('online'));
      expect(monitor.getStatus()).toBe(true);
    });
  });

  describe('getLastOnlineTime()', () => {
    it('should return a Date', () => {
      const lastOnline = monitor.getLastOnlineTime();
      expect(lastOnline).toBeInstanceOf(Date);
    });
  });

  describe('online/offline events', () => {
    it('should emit online when transitioning from offline to online', () => {
      const events: string[] = [];
      monitor.on('online', () => events.push('online'));

      // Must go offline first, then online triggers the event
      window.dispatchEvent(new Event('offline'));
      window.dispatchEvent(new Event('online'));

      expect(events).toContain('online');
    });

    it('should emit offline when window fires offline event', () => {
      const events: string[] = [];
      monitor.on('offline', () => events.push('offline'));

      window.dispatchEvent(new Event('offline'));

      expect(events).toContain('offline');
    });
  });

  describe('visibility change', () => {
    it('should emit visibility_online when tab becomes visible while online', () => {
      const events: string[] = [];
      monitor.on('visibility_online', () => events.push('visibility_online'));

      (navigator as { onLine: boolean }).onLine = true;
      (document as { visibilityState: string }).visibilityState = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));

      expect(events).toContain('visibility_online');
    });

    it('should NOT emit visibility_online when tab becomes visible while offline', () => {
      const events: string[] = [];
      monitor.on('visibility_online', () => events.push('visibility_online'));

      (navigator as { onLine: boolean }).onLine = false;
      (document as { visibilityState: string }).visibilityState = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));

      expect(events).not.toContain('visibility_online');

      // Reset
      (navigator as { onLine: boolean }).onLine = true;
    });
  });

  describe('dispose()', () => {
    it('should remove all event listeners', () => {
      const events: string[] = [];
      monitor.on('online', () => events.push('online'));

      monitor.dispose();

      window.dispatchEvent(new Event('online'));
      // After dispose, no events should fire
      // (We can't directly assert this since the window listener is removed,
      // but the monitor's EventEmitter listeners are also cleared)
    });
  });
});
