import { z } from 'zod';

/** One forward-only infrastructure migration shipped by an adapter. */
export const migrationSchema = z.object({
  /** Stable name, used as the migration filename + applied-ledger key. */
  name: z.string().min(1),
  /** The forward SQL. */
  up: z.string().min(1),
});

export type Migration = z.infer<typeof migrationSchema>;
