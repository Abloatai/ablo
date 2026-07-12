/**
 * A controllable WebSocket stand-in for sync engine tests. It reproduces the
 * event interface of the real connection without opening a socket, so tests
 * can drive connection changes, deltas, and bootstrap hints by hand.
 */

import type { SyncActionType } from '../../types/index.js';
import type { BootstrapReason } from '../../wire/bootstrapReason.js';

/** The shape of a single delta — one change the server pushes to the client. */
export interface MockDelta {
  id: number;
  modelName: string;
  modelId: string;
  action: SyncActionType;
  data: Record<string, unknown>;
}

/**
 * A hint from the server that the client has fallen too far behind and should
 * rebuild its data from scratch rather than catch up one delta at a time.
 */
export interface MockBootstrapHint {
  reason: BootstrapReason;
  tables?: string[];
  staleTables?: string[];
}

type EventHandler = (...args: unknown[]) => void;

/**
 * A controllable, event-based stand-in for the sync engine's WebSocket
 * connection. Subscribe with {@link MockWebSocket.on} exactly as production
 * code does, then use the `simulate*` and `receive*` methods to push
 * connection changes, deltas, and bootstrap hints. Every event the mock emits
 * is recorded on {@link MockWebSocket.emittedEvents} for assertions.
 */
export class MockWebSocket {
  private _connected = false;
  private _sessionError = false;
  private _listeners = new Map<string, Set<EventHandler>>();

  /** Every event the mock has emitted, in order, for assertions. */
  readonly emittedEvents: { type: string; data: unknown }[] = [];

  get connected(): boolean {
    return this._connected;
  }

  get sessionError(): boolean {
    return this._sessionError;
  }

  // ─────────────────────────────────────────────
  // Event subscription (matches the real connection's API)
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

  /** Fires a successful connection, emitting the `connected` event. */
  simulateConnect(): void {
    this._connected = true;
    this._sessionError = false;
    this.emit('connected');
  }

  /** Drops the connection, emitting the `disconnected` event. */
  simulateDisconnect(): void {
    this._connected = false;
    this.emit('disconnected');
  }

  /** Emits a `reconnecting` event carrying the attempt number and retry delay. */
  simulateReconnecting(attempt: number, delay: number): void {
    this.emit('reconnecting', { attempt, delay });
  }

  /** Emits a `session_error` event, as when the server rejects the session as unauthorized. The code defaults to 401. */
  simulateSessionError(code = 401): void {
    this._sessionError = true;
    this._connected = false;
    this.emit('session_error', { code });
  }

  /** Emits a `reconnect_failed` event, signaling the client gave up after exhausting its retries. */
  simulateReconnectFailed(): void {
    this._connected = false;
    this.emit('reconnect_failed');
  }

  // ─────────────────────────────────────────────
  // Test control: delta injection
  // ─────────────────────────────────────────────

  /** Delivers a single delta, emitting a `delta` event as if the server had sent it. */
  receiveDelta(delta: MockDelta): void {
    this.emit('delta', delta);
  }

  /** Delivers a batch of deltas, emitting a `delta_batch` event. */
  receiveDeltas(deltas: MockDelta[]): void {
    this.emit('delta_batch', deltas);
  }

  // ─────────────────────────────────────────────
  // Test control: bootstrap hints
  // ─────────────────────────────────────────────

  /** Emits a `bootstrap_required` hint, telling the client to rebuild its data instead of catching up. */
  simulateBootstrapHint(hint: MockBootstrapHint): void {
    this.emit('bootstrap_required', hint);
  }

  // ─────────────────────────────────────────────
  // Test control: presence
  // ─────────────────────────────────────────────

  /** Emits a `presence_update` event carrying the given payload. */
  simulatePresenceUpdate(data: Record<string, unknown>): void {
    this.emit('presence_update', data);
  }

  // ─────────────────────────────────────────────
  // Assertions
  // ─────────────────────────────────────────────

  /** Returns the payloads of every emitted event of the given type, in order. */
  getEvents(type: string): unknown[] {
    return this.emittedEvents.filter((e) => e.type === type).map((e) => e.data);
  }

  /** Reports whether an event of the given type has been emitted. */
  hasEmitted(type: string): boolean {
    return this.emittedEvents.some((e) => e.type === type);
  }

  /** Clears connection state, listeners, and the record of emitted events. */
  reset(): void {
    this._connected = false;
    this._sessionError = false;
    this._listeners.clear();
    this.emittedEvents.length = 0;
  }
}
