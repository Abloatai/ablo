/**
 * Session subsystem.
 *
 * Start here and descend into the public contract, issuance, server handler,
 * source normalization, or credential lifecycle. Transports consume the
 * normalized access contract and do not reconstruct session policy.
 */
export * from './contract.js';
export * from './client.js';
export * from './create.js';
export * from './handler.js';
export * from './source.js';
export * from './lifecycle.js';
