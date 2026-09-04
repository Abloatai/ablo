import { z } from 'zod';
import {
  presenceActivitySchema,
  presenceParticipantSchema,
} from './contract.js';

export const presenceActivityTombstoneSchema = z
  .object({
    activityId: z.string().min(1).max(128),
    version: z.number().int().nonnegative(),
    removedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type PresenceActivityTombstone = z.infer<typeof presenceActivityTombstoneSchema>;

const sessionProjectionFields = {
  presenceSessionId: z.string().min(1).max(128),
};

/** A complete server-authored projection for one logical session. */
export const presenceSnapshotSchema = z
  .object({
    ...sessionProjectionFields,
    participant: presenceParticipantSchema,
    revision: z.number().int().nonnegative(),
    activities: z.array(presenceActivitySchema).readonly(),
    tombstones: z.array(presenceActivityTombstoneSchema).readonly(),
  })
  .strict();
export type PresenceSnapshot = z.infer<typeof presenceSnapshotSchema>;

/**
 * An unordered incremental projection. There is deliberately no patch-level
 * revision: SyncGroup filtering may hide intermediate changes, while each
 * activity and tombstone converges by its own version.
 */
export const presencePatchSchema = z
  .object({
    ...sessionProjectionFields,
    /** Included when the receiver may not have seen this session before. */
    participant: presenceParticipantSchema.optional(),
    activities: z.array(presenceActivitySchema).readonly().optional(),
    tombstones: z.array(presenceActivityTombstoneSchema).readonly().optional(),
  })
  .strict();
export type PresencePatch = z.infer<typeof presencePatchSchema>;
