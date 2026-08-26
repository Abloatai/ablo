/**
 * Defines the data an ORM adapter exchanges with Ablo, expressed as Zod schemas
 * rather than plain interfaces so every value is validated where it crosses the
 * boundary. A malformed operation or outbox row is rejected at the edge instead of
 * failing deep inside a transaction, and each TypeScript type is inferred from the
 * one schema that validates it.
 *
 * These schemas describe the adapter's mutation contract: the change set it
 * commits and the capabilities it advertises. The operation
 * vocabulary is not restated here — `operationSchema` is projected from the
 * core's `commitOperationSchema`, so an action or field added to the commit
 * contract reaches a data source by construction. The assertion at the end of
 * this file then pins the published `SourceOperation` interface to that
 * projection, which is what keeps the interface tied to the core rather than
 * merely tied to a second local copy of it.
 */

import { z } from 'zod';
import { correlationIdSchema } from '../../commit/contract.js';
import {
  commitOperationSchema,
  commitOperationTypeSchema,
} from '../../coordination/schema.js';
import {
  ABLO_SOURCE_CLIENT_TX_ID_MAX_LENGTH,
  ABLO_SOURCE_ECHO_MAX_OPERATIONS,
  ABLO_SOURCE_ECHO_MAX_PAYLOAD_BYTES,
  type SourceCommitEcho,
  type SourceCommitEchoMarker,
  type SourceOperation,
} from '../types.js';
import type { SourceRequestContext } from '../types.js';

const jsonObject = z.record(z.string(), z.unknown());

/**
 * Served, not mirrored. The commit vocabulary is declared once in the core; a
 * data source speaks the same five actions, so it re-exports them rather than
 * listing them again under a second name.
 */
export const operationTypeSchema = commitOperationTypeSchema;
export type OperationType = z.infer<typeof operationTypeSchema>;

/**
 * A single operation within a change set, and the runtime validator for it.
 *
 * The field set is projected from `commitOperationSchema` — an operation
 * reaching a data source is a commit operation minus the fencing field the
 * core settles internally. The two `min(1)` overrides are
 * deliberate and local: this is a customer-implemented boundary, so an empty
 * model name or row id is rejected here rather than forwarded. Stating them as
 * an extension keeps the tightening visible as a choice instead of hiding it
 * inside a second copy of the shape.
 */
export const operationSchema = commitOperationSchema
  .omit({ fenceToken: true })
  .extend({
    model: z.string().min(1),
    id: z.string().min(1).nullish(),
    input: jsonObject.nullish(),
  });
export type Operation = z.infer<typeof operationSchema>;

/** The supported customer-transaction echo mechanism. */
export const sourceCommitEchoSchema = z.object({
  kind: z.literal('postgres-wal'),
  payload: z
    .string()
    .min(1)
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= ABLO_SOURCE_ECHO_MAX_PAYLOAD_BYTES,
      `WAL echo payload exceeds ${ABLO_SOURCE_ECHO_MAX_PAYLOAD_BYTES} UTF-8 bytes`,
    ),
});

export const sourceCommitEchoOperationSchema = z.strictObject({
  model: z.string().min(1),
  id: z.string().min(1),
  action: z.enum(['I', 'U', 'D']),
  transactionId: z.string().min(1).max(ABLO_SOURCE_CLIENT_TX_ID_MAX_LENGTH),
});

/**
 * Pre-write correlation evidence. A database-generated CREATE has no row id
 * until its INSERT returns, so the adapter receives the same operation shape
 * with that one value absent and finalizes it inside the writing transaction.
 */
const sourceCommitEchoIntentOperationSchema = sourceCommitEchoOperationSchema.extend({
  id: z.string().min(1).nullish(),
});

export const sourceCommitEchoIntentSchema = z
  .strictObject({
    version: z.literal(1),
    correlationId: correlationIdSchema,
    operations: z
      .array(sourceCommitEchoIntentOperationSchema)
      .min(1)
      .max(ABLO_SOURCE_ECHO_MAX_OPERATIONS)
      .readonly(),
  })
  .superRefine(({ operations }, ctx) => {
    const seen = new Set<string>();
    for (const [index, operation] of operations.entries()) {
      if (seen.has(operation.transactionId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['operations', index, 'transactionId'],
          message: 'WAL echo operation transactionIds must be unique',
        });
      }
      seen.add(operation.transactionId);
    }
  });
export type SourceCommitEchoIntent = z.infer<typeof sourceCommitEchoIntentSchema>;

export const sourceCommitEchoMarkerSchema = z
  .strictObject({
    version: z.literal(1),
    correlationId: correlationIdSchema,
    operations: z
      .array(sourceCommitEchoOperationSchema)
      .min(1)
      .max(ABLO_SOURCE_ECHO_MAX_OPERATIONS)
      .readonly(),
  })
  .superRefine(({ operations }, ctx) => {
    const seen = new Set<string>();
    for (const [index, operation] of operations.entries()) {
      if (seen.has(operation.transactionId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['operations', index, 'transactionId'],
          message: 'WAL echo operation transactionIds must be unique',
        });
      }
      seen.add(operation.transactionId);
    }
  });
export type SourceCommitEchoMarkerWire = z.infer<typeof sourceCommitEchoMarkerSchema>;

/**
 * The unit a mutation wrapper commits atomically. `correlationId` is derived by
 * Ablo from the authenticated plane, participant, and public idempotency key; it
 * is the customer-ledger identity. It is intentionally not a raw caller-authored
 * `clientTxId` or an operation transaction id.
 */
export const changeSetSchema = z.object({
  operations: z.array(operationSchema).min(1),
  correlationId: correlationIdSchema,
  intentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  echo: sourceCommitEchoSchema.optional(),
  scope: z.object({
    participantId: z.string().optional(),
    participantKind: z.enum(['user', 'agent', 'system']).optional(),
    organizationId: z.string().optional(),
    branchId: z.string().optional(),
    projectId: z.string().optional(),
    syncGroups: z.array(z.string()).optional(),
  }).optional() satisfies z.ZodType<SourceRequestContext | undefined>,
});
export type ChangeSet = z.infer<typeof changeSetSchema>;

/** Describes what an adapter's backend supports, so callers check a capability rather than infer it from behavior. */
export const adapterCapabilitiesSchema = z.object({
  /** `commit` is atomic across all operations in the change set. */
  transactions: z.boolean(),
  /** A dry-run `propose` is available; when false, proposing a change happens before the adapter is called. */
  propose: z.boolean(),
  /** The backend can be introspected for its schema. */
  schemaIntrospection: z.boolean(),
  /** The adapter can atomically emit the requested Postgres WAL marker. */
  postgresWalEcho: z.boolean().optional(),
  /** The wrapper atomically writes and serves an endpoint transactional outbox. */
  outboxEvents: z.boolean(),
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

type _AssertEchoMatchesWire = z.infer<typeof sourceCommitEchoSchema> extends SourceCommitEcho
  ? true
  : never;
type _AssertWireMatchesEcho = SourceCommitEcho extends z.infer<typeof sourceCommitEchoSchema>
  ? true
  : never;
const _echoContractInSync: [_AssertEchoMatchesWire, _AssertWireMatchesEcho] = [
  true,
  true,
];
void _echoContractInSync;

// Compatibility façade. New implementation code follows the owned subsystem
// downward from `outbox/index.ts` and imports migrations from `migration.ts`.
export { eventsPageSchema, outboxEventSchema } from '../outbox/contract.js';
export type { EventsPage, OutboxEvent } from '../outbox/contract.js';
export { migrationSchema } from './migration.js';
export type { Migration } from './migration.js';

type _AssertEchoMarkerMatchesWire = SourceCommitEchoMarkerWire extends SourceCommitEchoMarker
  ? true
  : never;
type _AssertWireMatchesEchoMarker = SourceCommitEchoMarker extends SourceCommitEchoMarkerWire
  ? true
  : never;
const _echoMarkerContractInSync: [
  _AssertEchoMarkerMatchesWire,
  _AssertWireMatchesEchoMarker,
] = [true, true];
void _echoMarkerContractInSync;
