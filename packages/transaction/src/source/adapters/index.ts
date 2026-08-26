/**
 * Customer-database adapter subsystem.
 *
 * Start here and descend through the behavioral adapter port, mutation
 * contract, profiles, migrations, idempotency, authorization, conformance,
 * and concrete ORM bindings.
 */
export * from './adapter.js';
export * from './adapterFactory.js';
export * from './adapterProfile.js';
export * from './contract.js';
export * from './migration.js';
export * from './migrations.js';
export * from './idempotency.js';
export * from './subjectAuthorization.js';
export * from './conformance.js';
export * from './memory.js';
export * from './prisma.js';
export * from './drizzle.js';
export * from './kysely.js';
