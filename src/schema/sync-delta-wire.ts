/**
 * Canonical Zod contract for the WIRE delta — the broadcast object that travels
 * server → client (the `delta` / `sync_response` frame payload). This is the
 * "same contract across both" seam: the SDK client and the sync-server each
 * derive their `SyncDelta` type from THESE schemas via `z.infer`, instead of
 * hand-maintaining two interfaces that drift (they had: the server typed
 * `actionType` as `string` and `createdBy` as a nested ref; the client typed
 * `actionType` as the 8-value union and `createdBy` as a flat string — a silent
 * divergence the client never noticed because it ignores attribution).
 *
 * Distinct from {@link import('./sync-delta-row.js').syncDeltaRowSchema} — that
 * is the STORED ROW (has `organizationId`, flat `actor_id`/`actor_kind`
 * columns, single-char action). The wire delta is a PROJECTION: no
 * `organizationId` (the server-trusted isolation predicate is never broadcast),
 * the full Linear action vocabulary, and attribution hydrated into nested
 * {@link ParticipantRef}s.
 *
 * Shape (per the "shared core + layer extensions" decision):
 *   - {@link syncDeltaWireCoreSchema} — the fields BOTH sides agree on.
 *   - {@link clientSyncDeltaSchema}    — core + the SDK-only extras.
 *   - {@link serverSyncDeltaSchema}    — core + the audit attribution the server
 *                                        enriches each broadcast with (the client
 *                                        structurally ignores these).
 *
 * Monorepo is on Zod v4.
 */

import { z } from 'zod';
import { participantKindSchema, confirmationStateSchema } from './sync-delta-row.js';

/**
 * `action_type` on the WIRE — the full Linear-compatible vocabulary a broadcast
 * carries (vs the stored row's core CRUD). `I`nsert, `U`pdate, `D`elete,
 * `A`rchive, `V` reVive/unarchive, `C`overing (gained visibility), `G`roupAdded,
 * `S` groupRemoved.
 */
export const syncDeltaActionSchema = z.enum(['I', 'U', 'D', 'A', 'V', 'C', 'G', 'S']);
export type SyncDeltaAction = z.infer<typeof syncDeltaActionSchema>;

/**
 * A wire delta payload: the post-mutation row object, a control-frame STRING
 * (e.g. a serialized group-change payload on `G`/`S` deltas), or `null` (on
 * deletes). Wider than the stored `data` (row-or-null) precisely because the
 * group/permission frames serialize a string.
 */
export const wireDeltaDataSchema = z
  .union([z.record(z.string(), z.unknown()), z.string()])
  .nullable();
export type WireDeltaData = z.infer<typeof wireDeltaDataSchema>;

/**
 * A nested participant reference as carried on a BROADCAST delta. The server
 * hydrates the flat `actor_id`/`actor_kind` stored columns into this.
 */
export const participantRefSchema = z.object({
  kind: participantKindSchema,
  id: z.string(),
});
export type ParticipantRef = z.infer<typeof participantRefSchema>;

/**
 * The fields BOTH server and client agree on for a broadcast delta — the shared
 * contract. `transactionId` is modelled as the client sees it (optional string);
 * the server projection widens it to nullable. No `organizationId` (never
 * broadcast). No `createdBy`/attribution here — those types differ per layer and
 * live in the extensions below.
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
  createdAt: z.string(),
});
export type SyncDeltaWireCore = z.infer<typeof syncDeltaWireCoreSchema>;

/**
 * Client projection — core + the SDK-only fields the client reads locally.
 * `z.infer` of this is the SDK's `SyncDelta` (see `sync/SyncWebSocket.ts`).
 */
export const clientSyncDeltaSchema = syncDeltaWireCoreSchema.extend({
  /** @deprecated Flat actor id; superseded by the server's nested `actor`. The
   *  client never reads it — kept only so the wire shape round-trips. */
  createdBy: z.string().optional(),
  /** Client-only payload slot (e.g. legacy group-change metadata). */
  metadata: wireDeltaDataSchema.optional(),
  /** Echo-matching id the client correlates against its optimistic mutation. */
  clientMutationId: z.string().optional(),
});
export type ClientSyncDelta = z.infer<typeof clientSyncDeltaSchema>;

/**
 * Server projection — core + the audit attribution the server enriches each
 * broadcast with (for the audit pane). The client ignores all of it. Overrides
 * `transactionId` to nullable (the server's stored-column reality).
 */
export const serverSyncDeltaSchema = syncDeltaWireCoreSchema.extend({
  transactionId: z.string().nullable(),
  /** @deprecated Mirrors `actor` 1:1. */
  createdBy: participantRefSchema.nullable(),
  /** Who DID the action. */
  actor: participantRefSchema.nullable(),
  /** On WHOSE AUTHORITY they acted (equals `actor` for human-direct commits). */
  onBehalfOf: participantRefSchema.nullable(),
  /** FK to AgentCapabilityRoot.capabilityId; non-null for agent/system commits. */
  capabilityId: z.string().nullable(),
  confirmationState: confirmationStateSchema.nullable(),
  /** FK to AgentTurn.id — the prompt that caused this delta. */
  causedByTaskId: z.string().nullable(),
});
export type ServerSyncDelta = z.infer<typeof serverSyncDeltaSchema>;
