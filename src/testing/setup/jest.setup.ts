/**
 * Jest setup for @abloatai/ablo tests
 *
 * Polyfills browser APIs (IndexedDB, WebSocket, fetch, navigator)
 * and resets SDK state between tests to prevent cross-test leaks.
 */

import 'fake-indexeddb/auto';
import { resetSyncEngine } from '../../context.js';

// ─────────────────────────────────────────────
// Reset sync engine context between tests
// ─────────────────────────────────────────────

beforeEach(() => {
  resetSyncEngine();
});

// ─────────────────────────────────────────────
// Mock global.fetch
// ─────────────────────────────────────────────

if (typeof globalThis.fetch === 'undefined') {
  (globalThis as Record<string, unknown>).fetch = jest.fn();
} else {
  jest.spyOn(globalThis, 'fetch').mockImplementation(
    jest.fn(() => Promise.reject(new Error('fetch not mocked for this test')))
  );
}

// ─────────────────────────────────────────────
// Mock WebSocket
// ─────────────────────────────────────────────

class MockGlobalWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState = MockGlobalWebSocket.OPEN;
  url: string;
  protocol = '';
  extensions = '';
  bufferedAmount = 0;
  binaryType: BinaryType = 'blob';

  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor(url: string | URL, _protocols?: string | string[]) {
    this.url = typeof url === 'string' ? url : url.toString();
    // Auto-connect in next microtask
    queueMicrotask(() => {
      if (this.onopen) {
        this.onopen(new Event('open'));
      }
    });
  }

  send(_data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    // No-op in mock
  }

  close(_code?: number, _reason?: string): void {
    this.readyState = MockGlobalWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose(new CloseEvent('close', { code: _code ?? 1000 }));
    }
  }

  addEventListener(_type: string, _listener: EventListenerOrEventListenerObject): void {
    // Minimal stub
  }

  removeEventListener(_type: string, _listener: EventListenerOrEventListenerObject): void {
    // Minimal stub
  }

  dispatchEvent(_event: Event): boolean {
    return true;
  }
}

(globalThis as Record<string, unknown>).WebSocket = MockGlobalWebSocket;

// ─────────────────────────────────────────────
// Make navigator.onLine writable for offline tests
// ─────────────────────────────────────────────

Object.defineProperty(navigator, 'onLine', {
  writable: true,
  value: true,
});

// ─────────────────────────────────────────────
// Make document.visibilityState writable
// ─────────────────────────────────────────────

Object.defineProperty(document, 'visibilityState', {
  writable: true,
  value: 'visible',
});

// ─────────────────────────────────────────────
// TextEncoder / TextDecoder polyfill (jsdom)
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// structuredClone polyfill (required by fake-indexeddb >=6)
// ─────────────────────────────────────────────

if (typeof globalThis.structuredClone === 'undefined') {
  (globalThis as Record<string, unknown>).structuredClone = <T>(value: T): T =>
    JSON.parse(JSON.stringify(value));
}

// ─────────────────────────────────────────────
// TextEncoder / TextDecoder polyfill (jsdom)
// ─────────────────────────────────────────────

if (typeof globalThis.TextEncoder === 'undefined') {
  const { TextEncoder, TextDecoder } = require('util');
  (globalThis as Record<string, unknown>).TextEncoder = TextEncoder;
  (globalThis as Record<string, unknown>).TextDecoder = TextDecoder;
}

// ─────────────────────────────────────────────
// Web Crypto polyfill (jsdom exposes `crypto` but not `crypto.subtle`)
// ─────────────────────────────────────────────
//
// Node 20+ ships `webcrypto` with the full SubtleCrypto surface; jsdom
// stubs `crypto.getRandomValues` but omits `.subtle`. Patch the global
// so `crypto.subtle.digest(...)`, `.encrypt(...)`, `.importKey(...)` —
// used by OfflineTransactionStore encryption and
// deriveBatchIdempotencyKey — work identically in tests and prod.
// `globalThis.crypto` is typed as `Crypto` which already declares
// `subtle: SubtleCrypto`. Jest's `jest-environment-jsdom` actually
// returns a partial polyfill that omits `subtle`, so we read it
// defensively — `?? null` instead of a cast.
if (!(globalThis.crypto?.subtle ?? null)) {
  const { webcrypto } = require('node:crypto');
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
    writable: true,
  });
}
