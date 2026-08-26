/**
 * Zod schemas that describe the `sync_deltas` storage row — the durable record of
 * one committed change. The row is split into two slices by the concern each one
 * serves:
 *
 *   - {@link syncDeltaCoreSchema} — the sync-protocol slice: everything a client
 *     needs to reconstruct the change, plus the tenant key. This is a portable
 *     payload shape; it is not a statement that the row is physically stored in
 *     the customer's database.
 *   - {@link deltaAttributionSchema} — who made the change, and on whose authority.
 *
 * {@link syncDeltaRowSchema} composes both into the full stored row.
 * {@link DELTA_DATA_CLASSIFICATION} states which slices contain customer data,
 * while {@link DELTA_PHYSICAL_STORAGE} states where the runtime persists them.
 * Keeping those axes separate prevents a portable schema slice from being cited
 * incorrectly as a physical-residency guarantee.
 *
 * This is the stored shape. The delta broadcast to clients is a narrower projection
 * of it — see {@link import('../contract.js').syncDeltaWireCoreSchema} — and
 * the field names here mirror those on that wire delta.
 */

import { z } from 'zod';
import type { ModelResidency } from '../../schema/residency.js';
import {
  participantKindSchema,
  confirmationStateSchema,
  syncDeltaActionSchema,
} from '../contract.js';

// ── Enumerations that mirror the corresponding Postgres enum types ────────────

// `participant_kind` and `confirmation_state` are shared with the wire delta and
// live in the observation contract (see `../contract.js`); they are re-exported here so
// code that imports them from `schema` keeps resolving.
export { participantKindSchema, confirmationStateSchema } from '../contract.js';
export type { ParticipantKind, ConfirmationState } from '../contract.js';

/** `backfill_provenance` */
export const backfillProvenanceSchema = z.enum(['exact', 'inferred', 'unknown']);
export type BackfillProvenance = z.infer<typeof backfillProvenanceSchema>;

/** A delta payload: the full post-mutation row (or null for deletes). */
const deltaDataSchema = z.record(z.string(), z.unknown()).nullable();

// ── Core — the sync-protocol slice ────────────────────────────────────────────

/**
 * Everything a client needs to materialize the change, plus the tenant key. This
 * is the portable shape an authoritative WAL change or endpoint event carries.
 * The runtime persists the resulting full row in Ablo's tenant-scoped ordered
 * sync log; it is not written atomically with a direct application-row mutation.
 * `id`, `createdAt`, and `syncGroups` are assigned when the source change is
 * appended, so they are optional at the ingestion boundary.
 */
export const syncDeltaCoreSchema = z.object({
  /** Monotonically increasing sync id, assigned by the server when the delta is appended; absent on an outbox marker. */
  id: z.union([z.bigint(), z.number()]).optional(),
  /** The `action_type` column; its eight values are owned by the wire delta contract. */
  actionType: syncDeltaActionSchema,
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
  /**
   * Stable identity of the authoritative WAL row or endpoint event. It is
   * nullable for hosted/legacy rows and is never exposed as the optimistic
   * client transaction id.
   */
  sourceChangeId: z.string().min(1).nullable().optional(),
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

// ── Full stored row, classification, and physical storage ─────────────────────

/** The complete `sync_deltas` row: core and attribution combined. */
export const syncDeltaRowSchema = syncDeltaCoreSchema.extend(deltaAttributionSchema.shape);
export type SyncDeltaRow = z.infer<typeof syncDeltaRowSchema>;

/** Which slices contain retained customer row data versus control metadata. */
export const DELTA_DATA_CLASSIFICATION = {
  core: 'customer-data',
  attribution: 'control-metadata',
} as const;

/**
 * Where the current runtime physically persists each slice. Both live in
 * Ablo's tenant-scoped `sync_deltas` log. `core` contains full post-change row
 * payloads (and optional previous payloads), so `control` here must not be read
 * as "metadata only."
 */
export const DELTA_PHYSICAL_STORAGE = {
  core: 'control',
  attribution: 'control',
} as const satisfies Record<string, ModelResidency>;
