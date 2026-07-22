/**
 * The persisted local action record consumed by `SyncActionStore`. It is a
 * client materialization artifact, not a transaction-layer wire shape: the
 * authoritative broadcast vocabulary is the settlement core's delta wire
 * schema, while this one adds the local `__class` discriminator IndexedDB uses.
 */

import { z } from 'zod';
import { syncDeltaActionSchema } from '../transaction/wire/delta.js';

export const syncActionSchema = z.object({
  id: z.number(),
  modelName: z.string(),
  modelId: z.string(),
  action: syncDeltaActionSchema,
  data: z.unknown(),
  __class: z.literal('SyncAction').default('SyncAction'),
});

export type SyncAction = z.infer<typeof syncActionSchema>;
export type SyncActionType = SyncAction['action'];
