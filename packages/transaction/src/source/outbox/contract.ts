import { z } from 'zod';
import { commitOperationTypeSchema } from '../../coordination/schema.js';
import { correlationIdSchema } from '../../commit/contract.js';
import { ABLO_SOURCE_CLIENT_TX_ID_MAX_LENGTH } from '../types.js';

const jsonObject = z.record(z.string(), z.unknown());

/** The immutable, versioned event envelope stored in `ablo_outbox`. */
export const outboxEventSchema = z.object({
  /** Version 1 predates durable routes; version 2 captures them atomically. */
  version: z.union([z.literal(1), z.literal(2)]),
  /** Stable, globally unique replay-protection identity. */
  id: z.string().min(1),
  model: z.string().min(1),
  entityId: z.string().min(1),
  type: commitOperationTypeSchema,
  /** Declared schema-field names, never physical database column names. */
  data: jsonObject.nullish(),
  /** Exact routes captured in the writing transaction; version 2 requires them. */
  syncGroups: z.array(z.string().min(1)).readonly().optional(),
  organizationId: z.string().nullish(),
  clientTxId: z.string().nullish(),
  correlationId: correlationIdSchema.nullish(),
  transactionId: z
    .string()
    .min(1)
    .max(ABLO_SOURCE_CLIENT_TX_ID_MAX_LENGTH)
    .nullish(),
  occurredAt: z.number().nullish(),
  /** Monotonic database position, represented as a string to preserve bigint. */
  cursor: z.string().min(1),
}).superRefine((event, ctx) => {
  if (event.version === 1 && event.syncGroups !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['syncGroups'],
      message: 'Outbox event version 1 cannot carry syncGroups',
    });
  }
  if (event.version === 2 && event.syncGroups === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['syncGroups'],
      message: 'Outbox event version 2 requires durable syncGroups',
    });
  }
});

export type OutboxEvent = z.infer<typeof outboxEventSchema>;

export const eventsPageSchema = z.object({
  events: z.array(outboxEventSchema),
  nextCursor: z.string().nullable(),
});

export type EventsPage = z.infer<typeof eventsPageSchema>;
