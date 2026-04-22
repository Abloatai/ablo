/**
 * Shared schema for the three example files. Real integrations bring
 * their own — `defineSchema({...})` is the only boundary between Ablo
 * and the customer's domain.
 */

import { defineSchema, mutable, z } from '@ablo/sync-engine/schema';

export const schema = defineSchema({
  matters: mutable.lazy(
    { name: z.string(), jurisdiction: z.string() },
    {
      typename: 'Matter',
      tableName: 'matters',
      syncGroupFormat: 'matter:{id}',
    },
  ),
  clauses: mutable.lazy(
    { matterId: z.string(), text: z.string(), status: z.enum(['draft', 'review', 'final']) },
    { typename: 'Clause', tableName: 'clauses' },
  ),
});
