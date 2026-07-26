/**
 * Normalizes and validates a database adapter declaration.
 *
 * Database integrations should return through this function rather than
 * assembling an object directly. It is the single place that relates database,
 * binding, observation, and advertised guarantees.
 */

import { AbloValidationError } from '../errors.js';
import type { MutationAdapter } from './adapter.js';
import { databaseAdapterProfileSchema } from './adapterProfile.js';

export function defineDatabaseAdapter<T extends MutationAdapter>(
  adapter: T,
): T {
  const profile = databaseAdapterProfileSchema.parse(adapter.profile);
  const { capabilities } = adapter;

  if (!capabilities.transactions) {
    throw new AbloValidationError(
      `Database adapter "${profile.id}" cannot provide Ablo commits without atomic transactions`,
      { code: 'source_adapter_misconfigured' },
    );
  }

  if (
    capabilities.postgresWalEcho === true &&
    profile.database !== 'postgresql'
  ) {
    throw new AbloValidationError(
      `Database adapter "${profile.id}" advertises a PostgreSQL WAL marker on ${profile.database}`,
      { code: 'source_adapter_misconfigured' },
    );
  }

  if (profile.observation.kind === 'postgres-wal') {
    if (
      profile.database !== 'postgresql' ||
      capabilities.postgresWalEcho !== true ||
      capabilities.outboxEvents
    ) {
      throw new AbloValidationError(
        `Database adapter "${profile.id}" has an invalid PostgreSQL WAL capability combination`,
        { code: 'source_adapter_misconfigured' },
      );
    }
  }

  if (
    profile.observation.kind === 'transactional-outbox' &&
    !capabilities.outboxEvents
  ) {
    throw new AbloValidationError(
      `Database adapter "${profile.id}" declares an outbox observation profile without outbox events`,
      { code: 'source_adapter_misconfigured' },
    );
  }

  return { ...adapter, profile } as T;
}
