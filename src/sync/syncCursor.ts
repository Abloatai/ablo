/**
 * SyncCursor — the sync-position state of one SyncWebSocket session.
 *
 * Owns the two pieces of resume state the transport carries between
 * connects: the `lastSyncId` watermark and the opaque server cursor.
 * Extracted from SyncWebSocket so cursor bookkeeping is one cohesive
 * leaf instead of fields + accessors spread through the transport
 * class. The advance DISCIPLINE (only move `lastSyncId` on a
 * persistence-gated ack) is documented at the call sites in
 * SyncWebSocket (`sendAck` / `handleDelta`).
 *
 * (The per-entity version vector that used to live here was a Go-era
 * ghost — zero decision reads client- or server-side; one total-ordered
 * log per plane makes the scalar `sync_id` watermark the causality
 * token. Removed in W4a.)
 */

export class SyncCursor {
  lastSyncId: number;
  syncCursor: string | null;

  constructor(lastSyncId: number) {
    this.lastSyncId = lastSyncId;
    this.syncCursor = null;
  }

  /**
   * Advance the local cursor for an ack — this is what
   * `requestIncrementalSync` and the connect handshake will send next,
   * and what `getLastSyncId()` reports for clean-shutdown persistence.
   * Monotonic: a stale (lower) ack never moves the cursor backward.
   */
  ackAdvance(syncId: number): void {
    if (syncId > this.lastSyncId) {
      this.lastSyncId = syncId;
    }
  }

  /**
   * Update last sync ID (for persistence)
   */
  setLastSyncId(syncId: number): void {
    this.lastSyncId = syncId;
  }

  /**
   * Update sync cursor (for incremental sync)
   */
  setSyncCursor(cursor: string | null): void {
    this.syncCursor = cursor;
  }

  /**
   * Get current sync cursor
   */
  getSyncCursor(): string | null {
    return this.syncCursor;
  }

  /**
   * Get the highest syncId seen this session (for persistence on clean shutdown)
   */
  getLastSyncId(): number {
    return this.lastSyncId || 0;
  }
}
