/**
 * Compatibility entry point for the durable `sync_deltas` row contract, which
 * is owned by the transaction layer. The schema barrel continues to re-export
 * this path so existing `@abloatai/ablo/schema` consumers do not change.
 */

export * from '../transaction/log/syncDeltaRow.js';
