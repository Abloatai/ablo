/**
 * Data Source adapter contract — Zod-first.
 *
 * The wire shapes an ORM adapter (Prisma/Drizzle/Kysely) consumes and produces
 * are defined here as Zod schemas, not hand-typed interfaces, so they are
 * VALIDATED at the boundary (a malformed op / outbox row is rejected at the
 * edge, not deep inside a transaction) and every inferred type flows from one
 * source. This mirrors the server's `tenant-connection.schema.ts` convention:
 * schema-validate what crosses a trust boundary, infer the TS types from it.
 *
 * Scope note: the existing `SourceOperation` / `SourceEvent` interfaces in
 * `index.ts` are the established cross-package wire types — this module does NOT
 * redefine them. It owns the ADAPTER-level contract (the change envelope the
 * adapter commits, the outbox row it persists, the migration it ships) and keeps
 * `operationSchema` structurally compatible with `SourceOperation` (asserted at
 * the bottom of the file) so the two never drift.
 */

import { z } from 'zod';
import type { SourceOperation } from './index.js';

const jsonObject = z.record(z.string(), z.unknown());

/** Mirrors `SourceOperation['type']`. */
export const operationTypeSchema = z.enum([
  'CREATE',
  'UPDATE',
  'DELETE',
  'ARCHIVE',
  'UNARCHIVE',
]);
export type OperationType = z.infer<typeof operationTypeSchema>;

/**
 * One operation in a change set. Structurally compatible with `SourceOperation`
 * (see the assertion below) — this is its runtime validator.
 */
export const operationSchema = z.object({
  type: operationTypeSchema,
  model: z.string().min(1),
  id: z.string().min(1).nullish(),
  input: jsonObject.nullish(),
  transactionId: z.string().nullish(),
  readAt: z.number().nullish(),
  onStale: z.enum(['reject', 'overwrite', 'notify']).nullish(),
});
export type Operation = z.infer<typeof operationSchema>;

/**
 * The atomic unit an adapter commits: one or more operations under a single
 * `clientTxId`. The `clientTxId` is the idempotency key — committing the same
 * change set twice must produce the same result exactly once.
 */
export const changeSetSchema = z.object({
  operations: z.array(operationSchema).min(1),
  clientTxId: z.string().min(1),
});
export type ChangeSet = z.infer<typeof changeSetSchema>;

/**
 * A row in the adapter-owned `ablo_outbox` table. Written in the SAME
 * transaction as the app-row mutation (transactional outbox), then read back by
 * `events()` and handed to Ablo. `cursor` is the monotonic ordering key Ablo
 * round-trips to resume.
 */
export const outboxEventSchema = z.object({
  /** Stable, globally-unique id — Ablo's replay-protection key. */
  id: z.string().min(1),
  model: z.string().min(1),
  entityId: z.string().min(1),
  type: operationTypeSchema,
  data: jsonObject.nullish(),
  organizationId: z.string().nullish(),
  /** Round-tripped so Ablo can filter SDK-origin echoes after a direct append. */
  clientTxId: z.string().nullish(),
  occurredAt: z.number().nullish(),
  /** Monotonic ordering key (bigint as string). `events()` pages by `cursor > ?`. */
  cursor: z.string().min(1),
});
export type OutboxEvent = z.infer<typeof outboxEventSchema>;

/** A page of outbox events returned by `events()`. */
export const eventsPageSchema = z.object({
  events: z.array(outboxEventSchema),
  nextCursor: z.string().nullable(),
});
export type EventsPage = z.infer<typeof eventsPageSchema>;

/**
 * A table-creation migration an adapter ships so a customer never hand-writes the
 * `ablo_idempotency` / `ablo_outbox` tables — the adapter returns them from
 * `migrations()`.
 */
export const migrationSchema = z.object({
  /** Stable name, used as the migration filename + applied-ledger key. */
  name: z.string().min(1),
  /** The forward SQL. */
  up: z.string().min(1),
});
export type Migration = z.infer<typeof migrationSchema>;

/** What an adapter's backend can do — a capability profile (no behavior inference). */
export const adapterCapabilitiesSchema = z.object({
  /** `commit` is atomic across all operations in the change set. */
  transactions: z.boolean(),
  /** A dry-run `propose` is supported (else proposal lives above the adapter). */
  propose: z.boolean(),
  /** The backend can be introspected for its schema. */
  schemaIntrospection: z.boolean(),
});
export type AdapterCapabilities = z.infer<typeof adapterCapabilitiesSchema>;

// ── Drift guard ──────────────────────────────────────────────────────────────
// Compile-time proof that `operationSchema` stays assignment-compatible with the
// canonical `SourceOperation` wire type. If either side changes shape, this
// stops compiling — the schema and the interface can never silently diverge.
type _AssertOperationMatchesWire = Operation extends SourceOperation ? true : never;
type _AssertWireMatchesOperation = SourceOperation extends Operation ? true : never;
const _operationContractInSync: [_AssertOperationMatchesWire, _AssertWireMatchesOperation] = [
  true,
  true,
];
void _operationContractInSync;
