export * from '@abloatai/transaction';
export { Ablo as default } from '@abloatai/transaction';

/**
 * The logger shape a caller passes in, and the no-op it can pass instead.
 *
 * Anything that supplies its own logging to the client has to name this type,
 * so it belongs on the surface the client itself is imported from.
 */
export { noopLogger } from '@abloatai/transaction/logger';
export type { Logger } from '@abloatai/transaction/logger';
