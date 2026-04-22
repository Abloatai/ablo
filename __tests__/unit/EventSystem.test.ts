/**
 * EventSystem unit tests — on/once/emit, unsubscribe, createScopedEmitter.
 *
 * SyncEventEmitter extends EventTarget (not EventEmitter).
 * Events are CustomEvent<detail> — the on() callback receives the full CustomEvent.
 */

import { SyncEventEmitter, createScopedEmitter } from '../../src/EventSystem';
import { createTestContext } from '../../src/testing';

describe('SyncEventEmitter', () => {
  let emitter: SyncEventEmitter;
  let cleanup: () => void;

  beforeEach(() => {
    const ctx = createTestContext();
    cleanup = ctx.cleanup;
    emitter = new SyncEventEmitter();
  });

  afterEach(() => {
    cleanup();
  });

  describe('emit() and on()', () => {
    it('should emit and receive typed events', () => {
      const received: unknown[] = [];
      emitter.on('bootstrap:started', (event) => {
        received.push(event);
      });

      emitter.emit('bootstrap:started');

      expect(received).toHaveLength(1);
    });

    it('should emit events with detail payload', () => {
      let receivedDetail: unknown = null;
      emitter.on('bootstrap:progress', (event) => {
        receivedDetail = (event as CustomEvent).detail;
      });

      emitter.emit('bootstrap:progress', { loaded: 42 });

      expect(receivedDetail).toEqual({ loaded: 42 });
    });

    it('should support multiple listeners for same event', () => {
      const calls: number[] = [];
      emitter.on('bootstrap:started', () => calls.push(1));
      emitter.on('bootstrap:started', () => calls.push(2));

      emitter.emit('bootstrap:started');

      expect(calls).toEqual([1, 2]);
    });
  });

  describe('on() unsubscribe', () => {
    it('should return an unsubscribe function that stops delivery', () => {
      let callCount = 0;
      const unsub = emitter.on('bootstrap:started', () => callCount++);

      emitter.emit('bootstrap:started');
      expect(callCount).toBe(1);

      unsub();
      emitter.emit('bootstrap:started');
      expect(callCount).toBe(1); // No change
    });
  });

  describe('once()', () => {
    it('should fire handler only once', () => {
      let callCount = 0;
      emitter.once('bootstrap:started', () => callCount++);

      emitter.emit('bootstrap:started');
      emitter.emit('bootstrap:started');

      expect(callCount).toBe(1);
    });
  });

  describe('emit() with no listeners', () => {
    it('should not throw', () => {
      expect(() => emitter.emit('bootstrap:started')).not.toThrow();
    });
  });
});

describe('createScopedEmitter()', () => {
  let cleanup: () => void;

  beforeEach(() => {
    const ctx = createTestContext();
    cleanup = ctx.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  it('should return an independent SyncEventEmitter', () => {
    const emitter1 = createScopedEmitter();
    const emitter2 = createScopedEmitter();

    let count1 = 0;
    let count2 = 0;
    emitter1.on('bootstrap:started', () => count1++);
    emitter2.on('bootstrap:started', () => count2++);

    emitter1.emit('bootstrap:started');

    expect(count1).toBe(1);
    expect(count2).toBe(0); // Scoped — no cross-talk
  });
});
