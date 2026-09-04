import { z } from 'zod';
import { participantKindSchema } from '../coordination/schema.js';

export const presenceOperationSchema = z.enum([
  'read',
  'claim',
  'create',
  'update',
  'delete',
]);
export type PresenceOperation = z.infer<typeof presenceOperationSchema>;

export const presenceActivitySourceSchema = z.enum(['session', 'claim', 'delta']);
export type PresenceActivitySource = z.infer<typeof presenceActivitySourceSchema>;

export const presenceTargetSchema = z
  .object({
    model: z.string().trim().min(1).max(128),
    id: z.string().min(1).max(512).optional(),
    field: z.string().min(1).max(128).optional(),
    fields: z.array(z.string().min(1).max(128)).min(1).max(64).readonly().optional(),
  })
  .strict()
  .superRefine((target, context) => {
    if (target.field !== undefined && target.fields !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'target may contain field or fields, not both',
      });
    }
    if ((target.field !== undefined || target.fields !== undefined) && target.id === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'field targets require a record id',
      });
    }
  });
export type PresenceTarget = z.infer<typeof presenceTargetSchema>;

export const presenceActivitySchema = z
  .object({
    id: z.string().min(1).max(128),
    version: z.number().int().nonnegative(),
    operation: presenceOperationSchema,
    target: presenceTargetSchema,
    source: presenceActivitySourceSchema,
    startedAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type PresenceActivity = z.infer<typeof presenceActivitySchema>;

export const presenceParticipantSchema = z
  .object({
    id: z.string().min(1).max(512),
    kind: participantKindSchema,
  })
  .strict();
export type PresenceParticipant = z.infer<typeof presenceParticipantSchema>;

/** One attributable execution context. It does not encode self versus others. */
export const presenceSessionSchema = z
  .object({
    presenceSessionId: z.string().min(1).max(128),
    participant: presenceParticipantSchema,
    activities: z.array(presenceActivitySchema).readonly(),
  })
  .strict();
export type PresenceSession = z.infer<typeof presenceSessionSchema>;
