/**
 * Write batching — the scheduler that coalesces many small writes into fewer
 * commits. Mirrors the core's own `batching` module, on the SDK surface so an
 * application building a write pipeline does not import past the facade.
 */
export * from '@abloatai/transaction/batching';
