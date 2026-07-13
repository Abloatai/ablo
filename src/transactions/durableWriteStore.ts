/**
 * Product-facing persistence contract for writes that must survive a process
 * restart or an ambiguous network response.
 *
 * The engine implements this contract with a transactional outbox internally,
 * but callers should only need to think in terms of pending durable writes.
 */

import { z } from 'zod';
import { durableCommitEnvelopeSchema } from './commitEnvelope.js';
import { durableHttpCommitEnvelopeSchema } from './httpCommitEnvelope.js';

/** Every write shape that Ablo may ask an injected store to persist. */
export const pendingWriteSchema = z.union([
  durableCommitEnvelopeSchema,
  durableHttpCommitEnvelopeSchema,
]);

export type PendingWrite = z.infer<typeof pendingWriteSchema>;

/**
 * Persistence port used by `Ablo({ durableWrites })`.
 *
 * `seal` is the durability boundary: it must atomically persist the exact write
 * and consume the staged records that write supersedes. Resolving this promise
 * authorizes Ablo to dispatch the request, so adapters must never report success
 * before the data is durable.
 */
export interface DurableWriteStore {
  /**
   * Atomically reserve a pending write and consume the staged records it owns.
   * The same id + same request is idempotent; the same id + a different request
   * must be rejected.
   */
  seal(
    write: PendingWrite,
    consumedRecordIds: readonly string[],
  ): Promise<void>;
  /** Load all unacknowledged writes. Stored data is treated as untrusted. */
  list(): Promise<readonly unknown[]>;
  /** Remove one write only after its outcome is definitive. */
  remove(writeId: string): Promise<void>;
}

/** Runtime validation for injected adapters, including JavaScript consumers. */
export const durableWriteStoreSchema = z.custom<DurableWriteStore>(
  (value) => {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Record<string, unknown>;
    return (
      typeof candidate.seal === 'function' &&
      typeof candidate.list === 'function' &&
      typeof candidate.remove === 'function'
    );
  },
  { message: 'store must implement seal(), list(), and remove()' },
);

/** Options for crash-durable `create`, `update`, and `delete` calls. */
export const durableWritesConfigSchema = z.strictObject({
  store: durableWriteStoreSchema,
  /** Separates deployments or workflow lanes that share an authenticated actor. */
  namespace: z.string().trim().min(1).optional(),
});

export type DurableWritesConfig = z.infer<typeof durableWritesConfigSchema>;
