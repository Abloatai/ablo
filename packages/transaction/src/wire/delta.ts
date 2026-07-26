/**
 * The delta wire contract: the object the server broadcasts to a client as the
 * payload of a `delta` or `sync_response` frame. Both the client SDK and the
 * server derive their delta types from the schemas here, so the two ends share
 * one definition and cannot drift apart. This is the delta's home in the wire
 * layer, alongside the other protocol shapes in `wire/`.
 *
 * The wire delta is a projection of the stored `sync_deltas` row (the
 * `syncDeltaRowSchema` in `../log/syncDeltaRow.ts`) and differs from it
 * in three ways: it omits `organizationId` (the tenant-isolation predicate is
 * never broadcast), it uses the full action vocabulary (see
 * {@link syncDeltaActionSchema}) rather than plain create, update, and delete, and
 * it carries attribution as nested {@link ParticipantRef}s instead of flat columns.
 *
 * The schemas layer a shared core plus per-side extensions:
 *   - {@link syncDeltaWireCoreSchema} — the fields both sides agree on.
 *   - {@link clientSyncDeltaSchema} — the core plus the fields only the client reads.
 *   - {@link serverSyncDeltaSchema} — the core plus the audit attribution the server
 *     adds to each broadcast, which the client ignores.
 *
 * The participant vocabulary the delta carries is declared once elsewhere and
 * re-served here: the actor union lives in `types/participant.ts` and its
 * runtime validator in `coordination/schema.ts`. Only `confirmationState` has
 * its home in this module, since the approval stage of a committed change is
 * delta attribution and nothing else. All three mirror Postgres enums.
 */

import { z } from 'zod';
import { correlationIdSchema } from './commit.js';
import { participantKindSchema } from '../coordination/schema.js';
import type { ParticipantKind, ParticipantRef } from '../types/participant.js';
import type { AssertExact } from '../types/assertExact.js';

// ── Shared participant vocabulary (declared once; re-served on this subpath) ──

/** `participant_kind` — who a delta is attributed to. Declared in
 *  `coordination/schema.ts`; re-exported so the wire subpath serves the
 *  vocabulary its delta shapes carry. */
export { participantKindSchema } from '../coordination/schema.js';
export type { ParticipantKind } from '../types/participant.js';

/** `confirmation_state` — the approval stage a committed change was in. */
export const confirmationStateSchema = z.enum([
  'auto',
  'previewed',
  'approved',
  'required_human_approval',
  'auto_historical',
]);
export type ConfirmationState = z.infer<typeof confirmationStateSchema>;

// ── The delta wire shapes ─────────────────────────────────────────────────────

/**
 * The full set of action codes a wire delta can carry — a broader vocabulary than
 * the stored row's create, update, and delete. Each is a single character: `I`
 * insert, `U` update, `D` delete, `A` archive, `V` revive (unarchive), `C` covering
 * (the row just became visible to this subscriber), `G` group added, and `S` group
 * removed.
 */
export const syncDeltaActionSchema = z.enum(['I', 'U', 'D', 'A', 'V', 'C', 'G', 'S']);
export type SyncDeltaAction = z.infer<typeof syncDeltaActionSchema>;

/**
 * The payload carried on a wire delta: the post-mutation row as an object, a
 * serialized string (used by the group-change frames on `G` and `S` deltas), or
 * `null` on deletes. This is wider than the stored row's payload — which is only a
 * row or null — because the group-change frames encode their payload as a string.
 *
 * The record branch costs more than its contract suggests: it walks
 * `Reflect.ownKeys` and rebuilds the payload into a fresh object on every parse,
 * so client-side validation scales with a row's field count on a path that runs
 * once per delta (2.7 microseconds at 23 fields, against 0.15 for a predicate).
 * Replacing it was tried and reverted, because every faster spelling gives up
 * something this contract owns: `z.custom` cannot be represented in JSON Schema
 * and breaks the derived spec, and `z.unknown().refine` derives to an empty
 * schema and infers `unknown`, which would widen {@link WireDeltaData}. A
 * predicate must also match this schema's real acceptance, which is
 * plain-object: `z.record` rejects `Date`, `Map`, and class instances.
 */
export const wireDeltaDataSchema = z
  .union([z.record(z.string(), z.unknown()), z.string()])
  .nullable();
export type WireDeltaData = z.infer<typeof wireDeltaDataSchema>;

/**
 * A participant reference as carried on a broadcast delta. The server expands the
 * flat `actor_id` and `actor_kind` stored columns into this nested `{ kind, id }`
 * shape. The type is the canonical {@link ParticipantRef} from
 * `types/participant.ts`; the pin below fails to compile if this schema and the
 * canonical shape ever drift.
 */
export const participantRefSchema = z.object({
  kind: participantKindSchema,
  id: z.string(),
});
export type { ParticipantRef } from '../types/participant.js';
const _participantRefContract: AssertExact<
  z.infer<typeof participantRefSchema>,
  ParticipantRef
> = true;
void _participantRefContract;

/**
 * The fields the server and client agree on for a broadcast delta — the shared core
 * both projections extend. `transactionId` is typed as the client sees it (an
 * optional string); {@link serverSyncDeltaSchema} widens it to nullable. There is no
 * `organizationId` here (it is never broadcast) and no attribution — those fields
 * differ between the two sides and live in the extensions below.
 */
export const syncDeltaWireCoreSchema = z.object({
  id: z.number(),
  actionType: syncDeltaActionSchema,
  modelName: z.string().min(1),
  modelId: z.string().min(1),
  data: wireDeltaDataSchema,
  previousData: wireDeltaDataSchema.optional(),
  syncGroups: z.array(z.string()),
  transactionId: z.string().optional(),
  /** Opaque source-batch identity present only on decoded customer-WAL echoes. */
  correlationId: correlationIdSchema.optional(),
  createdAt: z.string(),
});
export type SyncDeltaWireCore = z.infer<typeof syncDeltaWireCoreSchema>;

/**
 * The client's view of a wire delta: the shared core plus the fields only the
 * client reads. Inferring this schema gives the SDK's `SyncDelta` type.
 */
export const clientSyncDeltaSchema = syncDeltaWireCoreSchema.extend({
  /** @deprecated The actor id as a flat string; superseded by the server's nested
   *  `actor`. The client does not read it — it exists only so the wire shape round-trips. */
  createdBy: z.string().optional(),
  /** A payload slot the client reads locally, such as group-change metadata. */
  metadata: wireDeltaDataSchema.optional(),
  /** Echo-matching id the client correlates against its optimistic mutation. */
  clientMutationId: z.string().optional(),
});
export type ClientSyncDelta = z.infer<typeof clientSyncDeltaSchema>;

/**
 * The server's view of a wire delta: the shared core plus the audit attribution the
 * server adds to each broadcast. The client structurally ignores these fields. This
 * projection also narrows `transactionId` to nullable, matching the stored column.
 */
export const serverSyncDeltaSchema = syncDeltaWireCoreSchema.extend({
  /** The plane project the delta was committed on (`''` = the org's default
   *  project). Server-only: the broadcaster uses it to fan a mixed-project batch
   *  out ONLY to same-project subscribers. It rides on the frame but the client's
   *  `clientSyncDeltaSchema` (a non-strict object) strips it — a client only ever
   *  receives its own project's deltas, so the value is redundant to it. */
  projectId: z.string(),
  transactionId: z.string().nullable(),
  /** @deprecated Duplicates `actor`; read `actor` instead. */
  createdBy: participantRefSchema.nullable(),
  /** The participant who performed the action. */
  actor: participantRefSchema.nullable(),
  /** The participant on whose authority the actor acted; equal to `actor` for direct human commits. */
  onBehalfOf: participantRefSchema.nullable(),
  /** Foreign key to the authorizing capability; non-null for agent and system commits. */
  capabilityId: z.string().nullable(),
  confirmationState: confirmationStateSchema.nullable(),
});
export type ServerSyncDelta = z.infer<typeof serverSyncDeltaSchema>;

/**
 * The transaction-layer seam's transport-neutral projection of a broadcast
 * delta. It removes delivery plumbing (`syncGroups`, `transactionId`, and
 * `correlationId`) while retaining the row change and optional audit
 * attribution. `TransactionLayer.observe()` yields this shape.
 */
export const deltaSchema = syncDeltaWireCoreSchema
  .omit({
    syncGroups: true,
    transactionId: true,
    correlationId: true,
  })
  .extend({
    actor: participantRefSchema.nullable().optional(),
    onBehalfOf: participantRefSchema.nullable().optional(),
    capabilityId: z.string().nullable().optional(),
    confirmationState: confirmationStateSchema.nullable().optional(),
  });
export type Delta = z.infer<typeof deltaSchema>;
