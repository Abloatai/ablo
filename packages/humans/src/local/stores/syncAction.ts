/**
 * The persisted local action record consumed by `SyncActionStore`. It is a
 * client materialization artifact, not a transaction-layer wire shape: the
 * authoritative broadcast vocabulary is the confirmation core's delta wire
 * schema, while this one adds the local `__class` discriminator IndexedDB uses.
 */

import { z } from 'zod';
import { syncDeltaActionSchema } from '@abloatai/transaction/observation';

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
