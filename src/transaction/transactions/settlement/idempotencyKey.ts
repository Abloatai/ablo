/**
 * Identity shared by the durable write records.
 *
 * A retry must reuse the same non-empty key so the server can recognize the
 * same logical write. This is a persistence invariant, not a second commit
 * protocol.
 */
import { z } from 'zod';

export const idempotencyKeySchema = z.string().min(1).max(255).brand<'IdempotencyKey'>();
export type IdempotencyKey = z.output<typeof idempotencyKeySchema>;
