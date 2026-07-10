/**
 * Zod schemas that describe the `sync_deltas` storage row — the durable record of
 * one committed change. The row is split into three slices by the concern each one
 * serves:
 *
 *   - {@link syncDeltaCoreSchema} — the sync-protocol slice: everything a client
 *     needs to reconstruct the change, plus the tenant key. This is the portable
 *     part, and the only part written atomically with the application row.
 *   - {@link deltaAttributionSchema} — who made the change, and on whose authority.
 *   - {@link deltaProvenanceSchema} — which AI task, if any, produced it.
 *
 * {@link syncDeltaRowSchema} composes all three into the full stored row.
 * {@link DELTA_RESIDENCY} records which database each slice lives in, so
 * provisioning can derive that boundary from the schema instead of hand-coding it.
 *
 * This is the stored shape. The delta broadcast to clients is a narrower projection
 * of it — see {@link import('../wire/delta.js').syncDeltaWireCoreSchema} — and
 * the field names here mirror those on that wire delta.
 */

import { z } from 'zod';
import type { ModelResidency } from './residency.js';
import { participantKindSchema, confirmationStateSchema } from '../wire/delta.js';

// ── Enumerations that mirror the corresponding Postgres enum types ────────────

// `participant_kind` and `confirmation_state` are shared with the wire delta and
// live at the wire layer (see `../wire/delta.js`); they are re-exported here so
// code that imports them from `schema` keeps resolving.
export { participantKindSchema, confirmationStateSchema } from '../wire/delta.js';
export type { ParticipantKind, ConfirmationState } from '../wire/delta.js';

/** `backfill_provenance` */
export const backfillProvenanceSchema = z.enum(['exact', 'inferred', 'unknown']);
export type BackfillProvenance = z.infer<typeof backfillProvenanceSchema>;

/** A delta payload: the full post-mutation row (or null for deletes). */
const deltaDataSchema = z.record(z.string(), z.unknown()).nullable();

// ── Core — the sync-protocol slice ────────────────────────────────────────────

/**
 * Everything a client needs to materialize the change, plus the tenant key. This
 * is the portable slice: the only part written atomically with the application
 * row, and the shape an outbox marker in a customer's own database carries. `id`,
 * `createdAt`, and `syncGroups` are assigned by the server when the delta is
 * appended, so they are optional here — an outbox marker does not have them yet.
 */
export const syncDeltaCoreSchema = z.object({
  /** Monotonically increasing sync id, assigned by the server when the delta is appended; absent on an outbox marker. */
  id: z.union([z.bigint(), z.number()]).optional(),
  /** The `action_type` column: a single character, `I` (insert), `U` (update), or `D` (delete). */
  actionType: z.string().min(1).max(1),
  modelName: z.string().min(1),
  modelId: z.string().min(1),
  data: deltaDataSchema,
  previousData: deltaDataSchema.optional(),
  /** Routing keys that decide which subscribers receive this delta; computed by the server at append time. */
  syncGroups: z.array(z.string()).optional(),
  /** The committing organization id — the coarse-grained tenant-isolation boundary. */
  organizationId: z.string().nullable(),
  /** ISO 8601 timestamp, assigned by the server when the delta is appended. */
  createdAt: z.string().optional(),
  transactionId: z.string().nullable(),
});
export type SyncDeltaCore = z.infer<typeof syncDeltaCoreSchema>;

// ── Attribution — who made the change, and on whose authority ─────────────────

export const deltaAttributionSchema = z.object({
  /** The acting participant, recorded as a single column for compatibility; the structured pair below is the richer form. */
  createdBy: z.string().nullable(),
  actorId: z.string().nullable(),
  actorKind: participantKindSchema.nullable(),
  onBehalfOfId: z.string().nullable(),
  onBehalfOfKind: participantKindSchema.nullable(),
  capabilityId: z.string().nullable(),
  delegationChainRootUserId: z.string().nullable().optional(),
  confirmationState: confirmationStateSchema.nullable(),
  backfillProvenance: backfillProvenanceSchema.nullable(),
});
export type DeltaAttribution = z.infer<typeof deltaAttributionSchema>;

// ── Provenance — which AI task produced the change ────────────────────────────

export const deltaProvenanceSchema = z.object({
  /** Foreign key to the task record for the AI turn that produced this commit; null when no task applies. */
  causedByTaskId: z.string().nullable(),
});
export type DeltaProvenance = z.infer<typeof deltaProvenanceSchema>;

// ── Full stored row and its residency map ─────────────────────────────────────

/** The complete `sync_deltas` row: core, attribution, and provenance combined. */
export const syncDeltaRowSchema = syncDeltaCoreSchema
  .extend(deltaAttributionSchema.shape)
  .extend(deltaProvenanceSchema.shape);
export type SyncDeltaRow = z.infer<typeof syncDeltaRowSchema>;

/**
 * Maps each slice to the database it belongs in. A customer's own database holds
 * only the `tenant` slice; the `control` slices are enriched and stored in the
 * host's own database. Provisioning reads this map to decide which columns a given
 * database receives, rather than hand-coding the boundary.
 */
export const DELTA_RESIDENCY = {
  core: 'tenant',
  attribution: 'control',
  provenance: 'control',
} as const satisfies Record<string, ModelResidency>;
