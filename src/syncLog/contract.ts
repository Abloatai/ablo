/** Canonical sync-log identity and position contracts shared by client/server. */

import { z } from 'zod';
import { environmentSchema } from '../environment.js';

export const deltaPositionSchema = z.number().int().nonnegative().safe();
export type DeltaPosition = z.infer<typeof deltaPositionSchema>;

export const clientMutationIdSchema = z.string().min(1).max(255);
export type ClientMutationId = z.infer<typeof clientMutationIdSchema>;

export const sourceCorrelationIdSchema = z.string().min(1).max(255);
export type SourceCorrelationId = z.infer<typeof sourceCorrelationIdSchema>;

export const sourceChangeIdSchema = z.string().min(1).max(512);
export type SourceChangeId = z.infer<typeof sourceChangeIdSchema>;

export const replicationLsnSchema = z.string().regex(/^[0-9A-Fa-f]+\/[0-9A-Fa-f]+$/);
export type ReplicationLSN = z.infer<typeof replicationLsnSchema>;

export const commitDispatchMarkerSchema = z.strictObject({
  kind: z.literal('sync_deltas'),
  organizationId: z.string().min(1),
  environment: environmentSchema,
  firstSyncId: deltaPositionSchema,
  lastSyncId: deltaPositionSchema,
}).superRefine((value, ctx) => {
  if (value.firstSyncId <= 0 || value.lastSyncId < value.firstSyncId) {
    ctx.addIssue({ code: 'custom', message: 'invalid delta position range' });
  }
});
export type CommitDispatchMarker = z.infer<typeof commitDispatchMarkerSchema>;
