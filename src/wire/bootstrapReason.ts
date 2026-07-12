import { z } from 'zod';

/** Machine-readable reasons a live delta stream must resume via catch-up. */
export const bootstrapReasonSchema = z.enum([
  'too_far_behind',
  'too_many_deltas',
  'missing_entities',
  'stream_gap',
]);
export type BootstrapReason = z.infer<typeof bootstrapReasonSchema>;
