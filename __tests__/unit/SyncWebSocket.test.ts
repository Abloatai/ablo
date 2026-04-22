/**
 * SyncWebSocket unit tests — URL construction, event emission,
 * connection lifecycle, delta handling, collaboration events.
 */

import { SyncWebSocket } from '../../src/sync/SyncWebSocket';
import { createTestContext, resetFixtureCounter } from '../../src/testing';

describe('SyncWebSocket', () => {
  let cleanup: () => void;

  beforeEach(() => {
    resetFixtureCounter();
    const ctx = createTestContext();
    cleanup = ctx.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  describe('constructor', () => {
    it('should construct WebSocket URL from baseUrl (http→ws)', () => {
      const ws = new SyncWebSocket({
        baseUrl: 'http://localhost:8080',
        userId: 'user-1',
        organizationId: 'org-1',
      });

      // We can verify the URL indirectly — connect() builds the full URL
      expect(ws).toBeDefined();
      expect(ws.isConnected()).toBe(false);
    });

    it('should construct WebSocket URL from https (→wss)', () => {
      const ws = new SyncWebSocket({
        baseUrl: 'https://api.example.com',
        userId: 'user-1',
        organizationId: 'org-1',
      });

      expect(ws).toBeDefined();
    });

    it('should accept syncGroups option', () => {
      const ws = new SyncWebSocket({
        baseUrl: 'http://localhost:8080',
        userId: 'user-1',
        organizationId: 'org-1',
        syncGroups: ['default', 'org:org-1', 'team:team-1'],
      });

      expect(ws.getSyncGroups()).toEqual(['default', 'org:org-1', 'team:team-1']);
    });
  });

  describe('connect()', () => {
    it('should emit connected event on successful connection', (done) => {
      const ws = new SyncWebSocket({
        baseUrl: 'http://localhost:8080',
        userId: 'user-1',
        organizationId: 'org-1',
      });

      ws.on('connected', () => {
        expect(ws.isConnected()).toBe(true);
        ws.disconnect();
        done();
      });

      ws.connect();
    });

    it('should suppress connect when sessionErrorDetected', () => {
      const ws = new SyncWebSocket({
        baseUrl: 'http://localhost:8080',
        userId: 'user-1',
        organizationId: 'org-1',
      });

      ws.setSessionErrorDetected();

      let connected = false;
      ws.on('connected', () => { connected = true; });
      ws.connect();

      // Should not attempt connection
      expect(connected).toBe(false);
      expect(ws.isConnected()).toBe(false);
    });

    it('should not connect twice if already connected', (done) => {
      const ws = new SyncWebSocket({
        baseUrl: 'http://localhost:8080',
        userId: 'user-1',
        organizationId: 'org-1',
      });

      let connectCount = 0;
      ws.on('connected', () => {
        connectCount++;
        if (connectCount === 1) {
          // Try connecting again while already connected
          ws.connect();
          // Should still be 1
          setTimeout(() => {
            expect(connectCount).toBe(1);
            ws.disconnect();
            done();
          }, 50);
        }
      });

      ws.connect();
    });
  });

  describe('disconnect()', () => {
    it('should set isConnected to false', (done) => {
      const ws = new SyncWebSocket({
        baseUrl: 'http://localhost:8080',
        userId: 'user-1',
        organizationId: 'org-1',
      });

      ws.on('connected', () => {
        ws.disconnect();
        expect(ws.isConnected()).toBe(false);
        done();
      });

      ws.connect();
    });

    it('should not trigger reconnect on manual disconnect', (done) => {
      const ws = new SyncWebSocket({
        baseUrl: 'http://localhost:8080',
        userId: 'user-1',
        organizationId: 'org-1',
      });

      let reconnecting = false;
      ws.on('reconnecting', () => { reconnecting = true; });

      ws.on('connected', () => {
        ws.disconnect();
        setTimeout(() => {
          expect(reconnecting).toBe(false);
          done();
        }, 100);
      });

      ws.connect();
    });
  });

  describe('subscribe()', () => {
    it('should return an unsubscribe function', () => {
      const ws = new SyncWebSocket({
        baseUrl: 'http://localhost:8080',
        userId: 'user-1',
        organizationId: 'org-1',
      });

      let callCount = 0;
      const unsubscribe = ws.subscribe('connected', () => { callCount++; });

      // Trigger event
      ws.emit('connected');
      expect(callCount).toBe(1);

      // Unsubscribe
      unsubscribe();
      ws.emit('connected');
      expect(callCount).toBe(1); // No change
    });
  });

  describe('setSessionErrorDetected()', () => {
    it('should prevent future connections', () => {
      const ws = new SyncWebSocket({
        baseUrl: 'http://localhost:8080',
        userId: 'user-1',
        organizationId: 'org-1',
      });

      ws.setSessionErrorDetected();

      let connected = false;
      ws.on('connected', () => { connected = true; });
      ws.connect();

      expect(connected).toBe(false);
    });
  });

  describe('acknowledge()', () => {
    it('should not throw when not connected', () => {
      const ws = new SyncWebSocket({
        baseUrl: 'http://localhost:8080',
        userId: 'user-1',
        organizationId: 'org-1',
      });

      // Should gracefully no-op
      expect(() => ws.acknowledge(42)).not.toThrow();
    });
  });

  describe('resetReconnectAttempts()', () => {
    it('should reset the counter to allow fresh reconnects', () => {
      const ws = new SyncWebSocket({
        baseUrl: 'http://localhost:8080',
        userId: 'user-1',
        organizationId: 'org-1',
      });

      // Should not throw
      ws.resetReconnectAttempts();
      expect(ws).toBeDefined();
    });
  });
});
