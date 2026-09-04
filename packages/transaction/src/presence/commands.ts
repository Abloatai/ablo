import { z } from 'zod';
import { presenceTargetSchema } from './contract.js';

export const MIN_READ_PRESENCE_TTL_MS = 1_000;
export const MAX_READ_PRESENCE_TTL_MS = 10 * 60_000;

const activityIdSchema = z.string().min(1).max(128);
const readTtlSchema = z.number().int()
  .min(MIN_READ_PRESENCE_TTL_MS)
  .max(MAX_READ_PRESENCE_TTL_MS);

export const readPresenceUpsertCommandSchema = z
  .object({
    type: z.literal('read.upsert'),
    activityId: activityIdSchema,
    target: presenceTargetSchema,
    ttlMs: readTtlSchema,
  })
  .strict();

export const readPresenceRefreshCommandSchema = z
  .object({
    type: z.literal('read.refresh'),
    activityId: activityIdSchema,
    ttlMs: readTtlSchema,
  })
  .strict();

export const readPresenceRemoveCommandSchema = z
  .object({
    type: z.literal('read.remove'),
    activityId: activityIdSchema,
  })
  .strict();

/** The complete client-authored presence vocabulary. */
export const presenceCommandSchema = z.discriminatedUnion('type', [
  readPresenceUpsertCommandSchema,
  readPresenceRefreshCommandSchema,
  readPresenceRemoveCommandSchema,
]);

export type ReadPresenceUpsertCommand = z.infer<typeof readPresenceUpsertCommandSchema>;
export type ReadPresenceRefreshCommand = z.infer<typeof readPresenceRefreshCommandSchema>;
export type ReadPresenceRemoveCommand = z.infer<typeof readPresenceRemoveCommandSchema>;
export type PresenceCommand = z.infer<typeof presenceCommandSchema>;
