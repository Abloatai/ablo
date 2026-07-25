/**
 * Holds the resume state of one WebSocket sync session: the `lastSyncId`
 * watermark, which marks the highest delta the client has seen, and an opaque
 * server cursor used for incremental sync. The transport carries both across
 * reconnects so the session can resume where it left off.
 *
 * The watermark advances under a strict rule — it moves forward only on an
 * acknowledgement that is gated on durable persistence — which the transport
 * enforces at its acknowledgement and delta-handling call sites.
 */

export class SyncCursor {
  lastSyncId: number;
  syncCursor: string | null;

  constructor(lastSyncId: number) {
    this.lastSyncId = lastSyncId;
    this.syncCursor = null;
  }

  /**
   * Advances the watermark in response to an acknowledgement. This becomes the
   * value the next incremental-sync request and the connect handshake send, and
   * the value {@link SyncCursor.getLastSyncId} reports when persisting on a
   * clean shutdown. The move is monotonic: a stale, lower acknowledgement never
   * pulls the watermark backward.
   */
  ackAdvance(syncId: number): void {
    if (syncId > this.lastSyncId) {
      this.lastSyncId = syncId;
    }
  }

  /**
   * Sets the watermark outright, used when restoring persisted state.
   */
  setLastSyncId(syncId: number): void {
    this.lastSyncId = syncId;
  }

  /**
   * Sets the opaque server cursor used for incremental sync.
   */
  setSyncCursor(cursor: string | null): void {
    this.syncCursor = cursor;
  }

  /**
   * Returns the current opaque server cursor, or null if none is set.
   */
  getSyncCursor(): string | null {
    return this.syncCursor;
  }

  /**
   * Returns the highest delta id seen this session, for persistence on a clean
   * shutdown.
   */
  getLastSyncId(): number {
    return this.lastSyncId || 0;
  }
}
