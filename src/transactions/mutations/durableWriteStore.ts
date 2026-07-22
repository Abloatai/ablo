/**
 * The durable-write port moved to the settlement core (ADR 0016): it is a
 * contract over commit envelopes and holds no local rows. Re-exported here so
 * the existing `transactions/mutations/durableWriteStore` import path keeps
 * resolving for the queue, the outbox, and the client options.
 *
 * The port and its config live in the core's `durableWrites` module (a behavior
 * contract, not a persisted shape); the records that cross it are owned by
 * `transactions/settlement/pendingWrite`.
 */

export {
  durableWriteStoreSchema,
  durableWritesConfigSchema,
} from '../../transaction/durableWrites.js';
export type {
  DurableWriteStore,
  DurableWritesConfig,
} from '../../transaction/durableWrites.js';
export { pendingWriteSchema } from '../../transaction/transactions/settlement/pendingWrite.js';
export type { PendingWrite } from '../../transaction/transactions/settlement/pendingWrite.js';
