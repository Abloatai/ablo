/**
 * The three independent axes of a customer-database adapter.
 *
 * An ORM binding is not a database, and a database is not an observation
 * strategy. Keeping them separate prevents a Prisma or Kysely adapter from
 * looking portable while depending on PostgreSQL SQL or WAL underneath.
 */

import { z } from 'zod';

export const databaseKindSchema = z.enum(['postgresql', 'memory']);
export type DatabaseKind = z.infer<typeof databaseKindSchema>;

export const adapterBindingSchema = z.enum([
  'prisma',
  'drizzle',
  'kysely',
  'memory',
  'custom',
]);
export type AdapterBinding = z.infer<typeof adapterBindingSchema>;

export const observationProfileSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('transactional-outbox'),
    externalWrites: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('postgres-wal'),
    externalWrites: z.literal(true),
  }),
]);
export type ObservationProfile = z.infer<typeof observationProfileSchema>;

export const databaseAdapterProfileSchema = z.strictObject({
  id: z.string().min(1),
  database: databaseKindSchema,
  binding: adapterBindingSchema,
  observation: observationProfileSchema,
});
export type DatabaseAdapterProfile = z.infer<
  typeof databaseAdapterProfileSchema
>;

export type PostgresBinding = Extract<
  AdapterBinding,
  'prisma' | 'drizzle' | 'kysely' | 'custom'
>;

export function postgresAdapterProfile(
  binding: PostgresBinding,
  observation: 'transactional-outbox' | 'postgres-wal',
): DatabaseAdapterProfile {
  return {
    id: `postgresql-${binding}-${observation}`,
    database: 'postgresql',
    binding,
    observation:
      observation === 'postgres-wal'
        ? { kind: 'postgres-wal', externalWrites: true }
        : { kind: 'transactional-outbox', externalWrites: false },
  };
}

export function memoryAdapterProfile(): DatabaseAdapterProfile {
  return {
    id: 'memory-native-transactional-outbox',
    database: 'memory',
    binding: 'memory',
    observation: {
      kind: 'transactional-outbox',
      externalWrites: false,
    },
  };
}
