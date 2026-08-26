/**
 * The durable-write port and the option that installs it.
 *
 * Owns the persistence contract behind `Ablo({ durableWrites })` — a behavior
 * contract of methods, not a serialized shape, which is why it lives beside
 * rather than inside `confirmation/`. The records that cross this port
 * are owned by `confirmation/pendingWrite.ts`; this module never redescribes them.
 *
 * The engine consumes the port through `commitOutboxStore`, and the HTTP client
 * accepts the same option through `transport/http/options`.
 */

import { z } from 'zod';
import { AbloValidationError } from '../errors.js';
import type { CommitOutboxScope } from './confirmation/commitEnvelope.js';
import type { PendingWrite } from './confirmation/pendingWrite.js';

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
   * must be rejected. For a source-accepted envelope, a re-seal may add the
   * monotonic `acceptedAt`/`correlationId` evidence and the store must preserve
   * that upgrade atomically rather than ignoring it.
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

interface DurableWriteOptionInput {
  readonly durableWrites?: DurableWritesConfig;
  /** Compatibility input for pre-`durableWrites` clients. */
  readonly commitOutbox?: DurableWriteStore;
  /** Compatibility input and internal child-client identity seam. */
  readonly commitOutboxScope?: CommitOutboxScope;
}

export interface ResolvedDurableWrites {
  readonly store?: DurableWriteStore;
  readonly namespace?: string;
}

function invalidDurableWrites(message: string): AbloValidationError {
  return new AbloValidationError(`Ablo: invalid \`durableWrites\` option — ${message}.`, {
    code: 'invalid_options',
    param: 'durableWrites',
  });
}

/**
 * Resolves one canonical store configuration for both HTTP and WebSocket
 * clients. Mixed old/new configuration fails loudly so Ablo never persists to
 * one adapter while the caller believes another adapter is authoritative.
 */
export function resolveDurableWrites(
  options: DurableWriteOptionInput,
): ResolvedDurableWrites {
  if (options.durableWrites !== undefined && options.commitOutbox !== undefined) {
    throw invalidDurableWrites(
      'pass `durableWrites` or the deprecated `commitOutbox`, not both',
    );
  }

  if (options.durableWrites !== undefined) {
    const parsed = durableWritesConfigSchema.safeParse(options.durableWrites);
    if (!parsed.success) {
      throw invalidDurableWrites(
        parsed.error.issues.map((issue) => issue.message).join('; '),
      );
    }
    return {
      store: parsed.data.store,
      ...(parsed.data.namespace !== undefined
        ? { namespace: parsed.data.namespace }
        : options.commitOutboxScope?.namespace !== undefined
          ? { namespace: options.commitOutboxScope.namespace }
          : {}),
    };
  }

  if (options.commitOutbox !== undefined) {
    const parsed = durableWriteStoreSchema.safeParse(options.commitOutbox);
    if (!parsed.success) {
      throw invalidDurableWrites(
        parsed.error.issues.map((issue) => issue.message).join('; '),
      );
    }
    return {
      store: parsed.data,
      ...(options.commitOutboxScope?.namespace !== undefined
        ? { namespace: options.commitOutboxScope.namespace }
        : {}),
    };
  }

  return {};
}
