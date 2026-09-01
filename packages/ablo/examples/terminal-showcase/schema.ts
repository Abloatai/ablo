/** The isolated model used by the terminal product proof. */
import { defineSchema, model, z } from '@abloatai/ablo/schema';

export const schema = defineSchema({
  deals: model({
    name: z.string(),
    stage: z.enum(['open', 'reviewing', 'approved']),
    value: z.number(),
    revision: z.number(),
    note: z.string(),
  }),
});
