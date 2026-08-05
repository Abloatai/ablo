/**
 * The durable-write port moved to the confirmation core (ADR 0016): it is a
 * contract over commit envelopes and holds no local rows. Re-exported here so
 * the existing `transactions/mutations/durableWriteStore` import path keeps
 * resolving for the queue, the outbox, and the client options.
 *
 * The port and its config live in the core's `durableWrites` module (a behavior
 * contract, not a persisted shape); the records that cross it are owned by
 * `transactions/confirmation/pendingWrite`.
 */

export {
  durableWriteStoreSchema,
  durableWritesConfigSchema,
} from '@abloatai/transaction/durableWrites';
export type {
  DurableWriteStore,
  DurableWritesConfig,
} from '@abloatai/transaction/durableWrites';
export { pendingWriteSchema } from '@abloatai/transaction/transactions/confirmation/pendingWrite';
export type { PendingWrite } from '@abloatai/transaction/transactions/confirmation/pendingWrite';
