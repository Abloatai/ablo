/**
 * Headless DI interfaces — the three abstractions createSyncEngine needs
 * to run in Node.js without browser globals.
 *
 * STATUS: Type stubs only. No implementation yet. These interfaces are
 * the deliverable of Path C Phase 1. When all three have both a browser
 * implementation and a Node implementation, the SDK is truly headless.
 *
 * Usage (once implemented):
 *
 *   // Browser (default — no DI needed, uses browser globals)
 *   const engine = createSyncEngine({ url, userId, organizationId });
 *
 *   // Node.js / agent / sidecar (headless — DI overrides)
 *   import { inMemoryStorage, alwaysOnline } from '@ablo/sync-engine/headless';
 *   const engine = createSyncEngine({
 *     url, userId, organizationId,
 *     storage: inMemoryStorage(),
 *     network: alwaysOnline(),
 *   });
 *
 * The `transport` override is optional because Node 22 has a built-in
 * global `WebSocket` class. It's included for testing (mock WebSocket)
 * and for environments where the built-in WebSocket isn't available
 * (Node 20, Deno, Bun — each has its own WebSocket story).
 *
 * See also: apps/sync-server/src/sdk-headless-entrypoint.test.ts
 * (the skipped tests that become the acceptance tests for Phase 1)
 */

// ── StorageProvider ──────────────────────────────────────────────────────
//
// Replaces: IndexedDB (via Database.ts)
// Browser impl: wraps indexedDB.open() — the current Database.ts behavior
// Node impl: in-memory Map<string, Map<string, unknown>> — no persistence
//
// The interface mirrors the subset of IndexedDB that Database.ts uses:
// open a named database, get an object store, read/write records.

/** A record in an object store. */
export type StorageRecord = Record<string, unknown> & { id: string };

/** An object store — analogous to an IDBObjectStore. */
export interface ObjectStore {
  get(id: string): Promise<StorageRecord | undefined>;
  getAll(): Promise<StorageRecord[]>;
  getAllFromIndex(indexName: string, value: string): Promise<StorageRecord[]>;
  put(record: StorageRecord): Promise<void>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

/** A database — analogous to an IDBDatabase. */
export interface StorageDatabase {
  getStore(name: string): ObjectStore | undefined;
  close(): void;
}

/**
 * Opens or creates a named database.
 *
 * Browser: wraps indexedDB.open(name, version)
 * Node: returns an in-memory database backed by Maps
 */
export interface StorageProvider {
  open(name: string, version?: number): Promise<StorageDatabase>;
  delete(name: string): Promise<void>;
}

// ── NetworkProvider ──────────────────────────────────────────────────────
//
// Replaces: navigator.onLine + window online/offline events (via NetworkMonitor.ts)
// Browser impl: reads navigator.onLine, listens for online/offline/visibilitychange
// Node impl: always online (the server IS the network — it doesn't go offline)
// Test impl: controllable — set online/offline for reconnection testing

export interface NetworkProvider {
  /** Current online status. */
  isOnline(): boolean;

  /**
   * Subscribe to online/offline transitions. Returns an unsubscribe function.
   * The callback receives `true` when coming online, `false` when going offline.
   *
   * Browser: listens for window 'online'/'offline' events + visibilitychange
   * Node: never fires (always online)
   * Test: fires when the test calls setOnline(true/false)
   */
  onStatusChange(callback: (online: boolean) => void): () => void;
}

// ── TransportProvider ────────────────────────────────────────────────────
//
// Replaces: `new WebSocket(url)` (via SyncWebSocket.ts)
// Browser impl: `globalThis.WebSocket` (the browser's built-in)
// Node impl: Node 22's built-in `WebSocket` OR the `ws` npm package
// Test impl: FakeWebSocket from apps/sync-server/src/test/FakeWebSocket.ts
//
// This override is OPTIONAL in Node 22 (which has a global WebSocket)
// but useful for:
//   - Environments without a global WebSocket (Node 20, some serverless)
//   - Testing with a fake WebSocket (no network needed)
//   - Custom WebSocket wrappers (e.g., with extra headers, proxy support)

/** Minimal WebSocket interface that SyncWebSocket uses. */
export interface WebSocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;

  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  ping?(): void;

  addEventListener(type: 'open', handler: () => void): void;
  addEventListener(type: 'close', handler: (event: { code: number; reason: string }) => void): void;
  addEventListener(type: 'message', handler: (event: { data: unknown }) => void): void;
  addEventListener(type: 'error', handler: (event: unknown) => void): void;

  removeEventListener(type: string, handler: (...args: unknown[]) => void): void;
}

export interface TransportProvider {
  /**
   * Create a WebSocket connection to the given URL.
   * Returns an object satisfying the WebSocketLike interface.
   */
  connect(url: string): WebSocketLike;
}

// ── Factory functions (to be implemented in Phase 1) ─────────────────────
//
// These will be the public API that headless consumers import:
//
//   import { inMemoryStorage, alwaysOnline } from '@ablo/sync-engine/headless';
//
// Stubs below show the intended signatures. Implementation is Phase 1 work.

// export function inMemoryStorage(): StorageProvider { ... }
// export function alwaysOnline(): NetworkProvider { ... }
// export function nodeWebSocket(): TransportProvider { ... }
// export function controllableNetwork(): NetworkProvider & { setOnline(v: boolean): void } { ... }
