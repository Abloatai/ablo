/**
 * MockWebSocket — Controllable WebSocket for sync engine tests.
 *
 * Simulates the SyncWebSocket event interface without a real connection.
 * Provides methods to inject deltas, simulate disconnection/reconnection,
 * and trigger bootstrap hints.
 */

import type { SyncActionType } from '../../types/index.js';

/** Delta shape matching the SyncAction interface */
export interface MockDelta {
  id: number;
  modelName: string;
  modelId: string;
  action: SyncActionType;
  data: Record<string, unknown>;
}

/** Bootstrap hint from server */
export interface MockBootstrapHint {
  reason: 'too_far_behind' | 'too_many_deltas' | 'missing_entities';
  tables?: string[];
  staleTables?: string[];
}

type EventHandler = (...args: unknown[]) => void;

/**
 * MockWebSocket provides a controllable event-based interface
 * for testing sync engine components that consume WebSocket events.
 */
export class MockWebSocket {
  private _connected = false;
  private _sessionError = false;
  private _listeners = new Map<string, Set<EventHandler>>();

  /** Track all emitted events for assertions */
  readonly emittedEvents: Array<{ type: string; data: unknown }> = [];

  get connected(): boolean {
    return this._connected;
  }

  get sessionError(): boolean {
    return this._sessionError;
  }

  // ─────────────────────────────────────────────
  // Event subscription (matches SyncWebSocket API)
  // ─────────────────────────────────────────────

  on(event: string, handler: EventHandler): () => void {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event)!.add(handler);

    return () => {
      this._listeners.get(event)?.delete(handler);
    };
  }

  private emit(event: string, ...args: unknown[]): void {
    this.emittedEvents.push({ type: event, data: args[0] });
    const handlers = this._listeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        handler(...args);
      }
    }
  }

  // ─────────────────────────────────────────────
  // Test control: connection lifecycle
  // ─────────────────────────────────────────────

  /** Simulate successful connection */
  simulateConnect(): void {
    this._connected = true;
    this._sessionError = false;
    this.emit('connected');
  }

  /** Simulate disconnection */
  simulateDisconnect(): void {
    this._connected = false;
    this.emit('disconnected');
  }

  /** Simulate reconnection attempt */
  simulateReconnecting(attempt: number, delay: number): void {
    this.emit('reconnecting', { attempt, delay });
  }

  /** Simulate session error (401/403) */
  simulateSessionError(code: number = 401): void {
    this._sessionError = true;
    this._connected = false;
    this.emit('session_error', { code });
  }

  /** Simulate reconnection failure (max attempts reached) */
  simulateReconnectFailed(): void {
    this._connected = false;
    this.emit('reconnect_failed');
  }

  // ─────────────────────────────────────────────
  // Test control: delta injection
  // ─────────────────────────────────────────────

  /** Inject a single delta (as if received from server) */
  receiveDelta(delta: MockDelta): void {
    this.emit('delta', delta);
  }

  /** Inject a batch of deltas */
  receiveDeltas(deltas: MockDelta[]): void {
    this.emit('delta_batch', deltas);
  }

  // ─────────────────────────────────────────────
  // Test control: bootstrap hints
  // ─────────────────────────────────────────────

  /** Inject a bootstrap_required hint from server */
  simulateBootstrapHint(hint: MockBootstrapHint): void {
    this.emit('bootstrap_required', hint);
  }

  // ─────────────────────────────────────────────
  // Test control: presence
  // ─────────────────────────────────────────────

  /** Inject a presence update */
  simulatePresenceUpdate(data: Record<string, unknown>): void {
    this.emit('presence_update', data);
  }

  // ─────────────────────────────────────────────
  // Assertions
  // ─────────────────────────────────────────────

  /** Get all events of a specific type */
  getEvents(type: string): unknown[] {
    return this.emittedEvents.filter((e) => e.type === type).map((e) => e.data);
  }

  /** Check if a specific event was emitted */
  hasEmitted(type: string): boolean {
    return this.emittedEvents.some((e) => e.type === type);
  }

  /** Reset all state */
  reset(): void {
    this._connected = false;
    this._sessionError = false;
    this._listeners.clear();
    this.emittedEvents.length = 0;
  }
}
