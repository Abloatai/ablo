/** Normalize the product-facing durable-write option and its legacy aliases. */

import { AbloValidationError } from '../errors.js';
import type { CommitOutboxScope } from '../transactions/commitEnvelope.js';
import {
  durableWritesConfigSchema,
  durableWriteStoreSchema,
  type DurableWriteStore,
  type DurableWritesConfig,
} from '../transactions/durableWriteStore.js';

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
