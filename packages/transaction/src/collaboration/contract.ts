import { z } from 'zod';
import { presenceParticipantSchema } from '../presence/contract.js';
import { presenceSessionIdSchema } from '../presence/session.js';

/** Authenticated attribution attached by the server to one application event. */
export const collaborationEventSenderSchema = z
  .object({
    presenceSessionId: presenceSessionIdSchema,
    participant: presenceParticipantSchema,
  })
  .strict();
export type CollaborationEventSender = z.infer<typeof collaborationEventSenderSchema>;

/** Metadata delivered separately from the application's unchanged payload. */
export const collaborationEventContextSchema = z
  .object({
    sender: collaborationEventSenderSchema,
    sentAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type CollaborationEventContext = z.infer<typeof collaborationEventContextSchema>;

/** The server-authored wire envelope for an application collaboration event. */
export const collaborationEventEnvelopeSchema = z
  .object({
    type: z.string().min(1),
    payload: z.unknown(),
    sender: collaborationEventSenderSchema,
    sentAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type CollaborationEventEnvelope = z.infer<typeof collaborationEventEnvelopeSchema>;

/** A model record plus its already-authorized delivery group. */
export const modelEventTargetSchema = z
  .object({
    model: z.string().trim().min(1).max(128),
    id: z.string().min(1).max(512),
    syncGroup: z.string().min(1).max(1024),
  })
  .strict();
export type ModelEventTarget = z.infer<typeof modelEventTargetSchema>;

/** Client-authored model event before the server adds attribution. */
export const modelEventInputSchema = z
  .object({
    target: modelEventTargetSchema,
    event: z.string().trim().min(1).max(128),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ModelEventInput = z.infer<typeof modelEventInputSchema>;

/** Server-authored model event delivered to record-scoped subscribers. */
export const modelEventEnvelopeSchema = modelEventInputSchema.extend({
  sender: collaborationEventSenderSchema,
  sentAt: z.iso.datetime({ offset: true }),
}).strict();
export type ModelEventEnvelope = z.infer<typeof modelEventEnvelopeSchema>;

export function collaborationEventContext(
  envelope: Pick<CollaborationEventEnvelope, 'sender' | 'sentAt'>,
): CollaborationEventContext {
  return {
    sender: envelope.sender,
    sentAt: envelope.sentAt,
  };
}
