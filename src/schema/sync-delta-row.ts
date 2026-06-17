/**
 * Canonical Zod description of the `sync_deltas` STORAGE ROW, decomposed by the
 * subsystem it belongs to and the database plane it lives in.
 *
 * `sync_deltas` fuses five control-plane subsystems onto one denormalized row
 * (see `docs/plans/sync-delta-zod-decomposition.md`). This module is **P0** of
 * that decomposition: it DESCRIBES the existing columns as Zod schemas — no DB
 * change, no rewiring — so the subsystem + plane boundaries become explicit and
 * type-enforced:
 *
 *   - {@link syncDeltaCoreSchema}    — the SYNC-PROTOCOL slice. `tenant` plane:
 *                                      the only part that must be written
 *                                      atomically with the app row, and the shape
 *                                      a BYO outbox marker carries (the portable
 *                                      slice).
 *   - {@link deltaAttributionSchema} — who / on whose authority. `control` plane.
 *   - {@link deltaProvenanceSchema}  — which AI task caused it. `control` plane.
 *
 * {@link syncDeltaRowSchema} is the full stored row (core ∪ attribution ∪
 * provenance). {@link DELTA_PLANES} declares each slice's plane so provisioning
 * (P1) can derive "what a customer DB gets" from the schema, not hand-code it.
 *
 * Distinct from the WIRE `SyncDelta` (`sync/SyncWebSocket.ts`, client-facing) and
 * `SourceDelta` (`source/index.ts`, source-mode input) — those are projections of
 * this row. Field names mirror those + `AuditChainRow` (`@ablo/audit-chain`).
 *
 * Monorepo is on Zod v4 — `.extend(...).shape` (not deprecated `.merge`).
 */

import { z } from 'zod';
import type { SchemaPlane } from './plane.js';

// ── Enums (mirror the Postgres enums; @@map name in the comment) ──────────────

/** `participant_kind` */
export const participantKindSchema = z.enum(['user', 'agent', 'system']);
export type ParticipantKind = z.infer<typeof participantKindSchema>;

/** `confirmation_state` */
export const confirmationStateSchema = z.enum([
  'auto',
  'previewed',
  'approved',
  'required_human_approval',
  'auto_historical',
]);
export type ConfirmationState = z.infer<typeof confirmationStateSchema>;

/** `backfill_provenance` */
export const backfillProvenanceSchema = z.enum(['exact', 'inferred', 'unknown']);
export type BackfillProvenance = z.infer<typeof backfillProvenanceSchema>;

/** A delta payload: the full post-mutation row (or null for deletes). */
const deltaDataSchema = z.record(z.string(), z.unknown()).nullable();

// ── Core — `tenant` plane (the sync-protocol slice) ───────────────────────────

/**
 * Everything a client needs to materialize the change, plus the tenant key. The
 * portable slice: the only part written atomically with the app row, and the
 * shape a BYO outbox marker carries. `id` / `createdAt` / `syncGroups` are
 * control-plane-assigned at enrich/append time, so they're optional here (an
 * outbox marker doesn't have them yet).
 */
export const syncDeltaCoreSchema = z.object({
  /** Monotonic sync id; assigned control-plane on append (absent on a marker). */
  id: z.union([z.bigint(), z.number()]).optional(),
  /** `action_type` — single char: `I` | `U` | `D`. */
  actionType: z.string().min(1).max(1),
  modelName: z.string().min(1),
  modelId: z.string().min(1),
  data: deltaDataSchema,
  previousData: deltaDataSchema.optional(),
  /** Sync-group routing keys; computed control-plane (`buildDeltaSyncGroups`). */
  syncGroups: z.array(z.string()).optional(),
  /** The TRUSTED committing org — the coarse tenant-isolation boundary. */
  organizationId: z.string().nullable(),
  /** ISO timestamp; control-plane-assigned at append. */
  createdAt: z.string().optional(),
  transactionId: z.string().nullable(),
});
export type SyncDeltaCore = z.infer<typeof syncDeltaCoreSchema>;

// ── Attribution — `control` plane ─────────────────────────────────────────────

export const deltaAttributionSchema = z.object({
  /** Legacy single-actor column, derived during the dual-write window. */
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

// ── Provenance — `control` plane (→ tasks) ────────────────────────────────────

export const deltaProvenanceSchema = z.object({
  /** FK to `Task.id` — the LLM turn that produced this commit. */
  causedByTaskId: z.string().nullable(),
});
export type DeltaProvenance = z.infer<typeof deltaProvenanceSchema>;

// ── Full stored row + plane map ───────────────────────────────────────────────

/** The complete `sync_deltas` row as stored today (core ∪ attribution ∪ provenance). */
export const syncDeltaRowSchema = syncDeltaCoreSchema
  .extend(deltaAttributionSchema.shape)
  .extend(deltaProvenanceSchema.shape);
export type SyncDeltaRow = z.infer<typeof syncDeltaRowSchema>;

/**
 * Each slice's database plane. The durable answer to "what does a BYO customer DB
 * get?" — only `tenant`-plane slices. Provisioning (P1) reads this instead of
 * hand-coding the boundary; the BYO outbox writes the `tenant` slice and the
 * relay enriches the `control` slices in Ablo's own database.
 */
export const DELTA_PLANES = {
  core: 'tenant',
  attribution: 'control',
  provenance: 'control',
} as const satisfies Record<string, SchemaPlane>;
