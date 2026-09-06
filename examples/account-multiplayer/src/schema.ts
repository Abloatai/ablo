import { defineSchema, model, z } from '@abloatai/ablo/schema';

export const schema = defineSchema({
  conversations: model({
    accountId: z.string().min(1),
    title: z.string(),
    executionOwner: z.string().nullable(),
    executionState: z.enum(['idle', 'generating']),
  }, { subject: { field: 'accountId', group: 'account' } }),
});
export default schema;
