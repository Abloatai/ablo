/**
 * The delta wire contract: the object the server broadcasts to a client as the
 * payload of a `delta` or `sync_response` frame. Both the client SDK and the
 * server derive their delta types from the schemas here, so the two ends share
 * one definition and cannot drift apart. This is the delta's home in the wire
 * layer, alongside the other protocol shapes in `wire/`.
 *
 * The wire delta is a projection of the stored `sync_deltas` row (see
 * {@link import('../schema/syncDeltaRow.js').syncDeltaRowSchema}) and differs from
 * it in three ways: it omits `organizationId` (the tenant-isolation predicate is
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
 * The two participant enums below (`participantKind`, `confirmationState`) are the
 * shared vocabulary of the protocol. They live here, at the wire layer, so the
 * stored-row schema can import them downward rather than the wire delta reaching
 * up into the schema DSL for them.
 */

import { z } from 'zod';
import { correlationIdSchema } from './commit.js';

// ── Shared participant vocabulary (mirrors the corresponding Postgres enums) ──

/** `participant_kind` — who a delta is attributed to. */
export const participantKindSchema = z.enum(['user', 'agent', 'system']);
export type ParticipantKind = z.infer<typeof participantKindSchema>;

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
 */
export const wireDeltaDataSchema = z
  .union([z.record(z.string(), z.unknown()), z.string()])
  .nullable();
export type WireDeltaData = z.infer<typeof wireDeltaDataSchema>;

/**
 * A participant reference as carried on a broadcast delta. The server expands the
 * flat `actor_id` and `actor_kind` stored columns into this nested `{ kind, id }`
 * shape.
 */
export const participantRefSchema = z.object({
  kind: participantKindSchema,
  id: z.string(),
});
export type ParticipantRef = z.infer<typeof participantRefSchema>;

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
  /** Foreign key to the task for the AI turn whose prompt caused this delta. */
  causedByTaskId: z.string().nullable(),
});
export type ServerSyncDelta = z.infer<typeof serverSyncDeltaSchema>;
