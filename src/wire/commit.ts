/**
 * Canonical runtime contracts for commit settlement.
 *
 * A commit crosses several boundaries during its lifetime: the server's
 * execution cache, the HTTP/WS receipt, and the client's acknowledgement
 * tracker. Those boundaries intentionally have different envelopes, but they
 * all compose the same settlement vocabulary from this module:
 *
 *   - `confirmed` — the authoritative change is visible at a sync watermark.
 *   - `queued` — a connected source durably accepted the write and only its
 *     correlated authoritative source delta (WAL for direct, endpoint event
 *     for endpoint-only), identified by `correlationId`, may promote it.
 *
 * Keeping the variants discriminated here makes an impossible receipt (most
 * importantly, `queued` without a correlation) unrepresentable at every
 * untrusted boundary without collapsing the distinct lifecycle envelopes into
 * one giant object.
 */

import { z } from 'zod';
import { staleNotificationSchema } from '../coordination/schema.js';
import type { ErrorCode } from '../errorCodes.js';
import type { RequiredCapability } from '../errors.js';

/** Matches the permanent source/idempotency-key ceiling. */
export const COMMIT_CORRELATION_ID_MAX_LENGTH = 255;

/** Opaque server-authored identity shared by a queued receipt and its authoritative source delta. */
export const correlationIdSchema = z.string().min(1).max(COMMIT_CORRELATION_ID_MAX_LENGTH);
export type CorrelationId = z.infer<typeof correlationIdSchema>;

export const commitStatusSchema = z.enum(['queued', 'confirmed']);
export type CommitStatus = z.infer<typeof commitStatusSchema>;

const queuedSettlementShape = {
  status: z.literal('queued'),
  correlationId: correlationIdSchema,
} as const;

const confirmedSettlementShape = {
  status: z.literal('confirmed'),
  correlationId: correlationIdSchema.optional(),
} as const;

const queuedSettlementSchema = z.strictObject(queuedSettlementShape);
const confirmedSettlementSchema = z.strictObject(confirmedSettlementShape);

/** The one settlement discriminant shared by every commit boundary. */
export const commitSettlementSchema = z.discriminatedUnion('status', [
  queuedSettlementSchema,
  confirmedSettlementSchema,
]);
export type CommitSettlement = z.infer<typeof commitSettlementSchema>;

const missingIdsSchema = z.array(z.string().min(1));
const notificationsSchema = z.array(staleNotificationSchema);

const successfulReceiptCommonShape = {
  object: z.literal('commit_receipt'),
  /** Optional convenience id used by some HTTP surfaces. */
  id: z.string().min(1).optional(),
  clientTxId: z.string().min(1),
  serverTxId: z.string().min(1),
  success: z.literal(true),
  lastSyncId: z.number().int().nonnegative(),
  ops: z.number().int().nonnegative(),
  notifications: notificationsSchema.optional(),
  missingIds: missingIdsSchema.optional(),
} as const;

const queuedCommitReceiptSchema = z
  .object({
    ...successfulReceiptCommonShape,
    ...queuedSettlementShape,
  })
  .superRefine((receipt, context) => {
    if (receipt.lastSyncId !== 0) {
      context.addIssue({
        code: 'custom',
        path: ['lastSyncId'],
        message: 'A queued source receipt cannot claim a confirmed sync watermark',
      });
    }
  });

const confirmedCommitReceiptSchema = z
  .object({
    ...successfulReceiptCommonShape,
    ...confirmedSettlementShape,
  })
  .superRefine((receipt, context) => {
    if (receipt.correlationId && receipt.lastSyncId <= 0) {
      context.addIssue({
        code: 'custom',
        path: ['lastSyncId'],
        message: 'A source-confirmed receipt requires a positive sync watermark',
      });
    }
  });

/**
 * Successful HTTP/WS receipt. This schema is deliberately strict about the
 * settlement discriminant. Zod's default object behavior strips additive
 * fields, which is forward compatible without allowing server-internal
 * recovery evidence to leak through a parsed wire receipt.
 */
export const commitReceiptSchema = z.discriminatedUnion('status', [
  queuedCommitReceiptSchema,
  confirmedCommitReceiptSchema,
]);
export type CommitReceiptWire = z.infer<typeof commitReceiptSchema>;

/**
 * Compatibility decoder for pre-contract WebSocket acknowledgements. It
 * supplies fields old servers omitted and normalizes their string sync ids,
 * then hands the result to the exact same canonical receipt schema. It never
 * invents a source correlation: an old/malformed queued receipt still fails
 * closed.
 */
export const legacyCompatibleCommitReceiptSchema = z.preprocess((value) => {
  if (typeof value !== 'object' || value === null) return value;
  const receipt = value as Record<string, unknown>;
  if (receipt.success !== true) return value;

  const rawLastSyncId = receipt.lastSyncId;
  const numericLastSyncId =
    typeof rawLastSyncId === 'string' && rawLastSyncId.trim().length > 0
      ? Number(rawLastSyncId)
      : rawLastSyncId;
  const normalizedLastSyncId =
    typeof numericLastSyncId === 'number' &&
    Number.isSafeInteger(numericLastSyncId) &&
    numericLastSyncId >= 0
      ? numericLastSyncId
      : undefined;

  return {
    ...receipt,
    object: receipt.object ?? 'commit_receipt',
    status: receipt.status ?? 'confirmed',
    serverTxId:
      typeof receipt.serverTxId === 'string'
        ? receipt.serverTxId
        : String(normalizedLastSyncId ?? 0),
    ops: typeof receipt.ops === 'number' && Number.isSafeInteger(receipt.ops) ? receipt.ops : 0,
    lastSyncId: normalizedLastSyncId ?? 0,
  };
}, commitReceiptSchema);

const requiredCapabilitySchema = z.custom<RequiredCapability>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { scope?: unknown }).scope === 'string',
  { message: 'requiredCapability must contain a scope' }
);

const errorCodeSchema = z.custom<ErrorCode>(
  (value) => typeof value === 'string' && value.length > 0,
  { message: 'commit rejection code must be a non-empty string' }
);

/** The failure arm is separate: queued/confirmed always imply `success:true`. */
export const rejectedCommitReceiptSchema = z.object({
  object: z.literal('commit_receipt'),
  clientTxId: z.string(),
  serverTxId: z.string(),
  success: z.literal(false),
  status: z.literal('rejected'),
  lastSyncId: z.number().int().nonnegative().optional(),
  ops: z.number().int().nonnegative().optional(),
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    field: z.string().optional(),
    requiredCapability: requiredCapabilitySchema.optional(),
  }),
});
export type RejectedCommitReceiptWire = z.infer<typeof rejectedCommitReceiptSchema>;

export const mutationResultPayloadSchema = z.union([
  commitReceiptSchema,
  rejectedCommitReceiptSchema,
]);
export type MutationResultPayload = z.infer<typeof mutationResultPayloadSchema>;

export const mutationResultMessageSchema = z.object({
  type: z.literal('mutation_result'),
  payload: mutationResultPayloadSchema,
});
export type MutationResultMessageWire = z.infer<typeof mutationResultMessageSchema>;

const confirmationTransactionIdsSchema = z
  .array(z.string().min(1))
  .min(1)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: 'confirmation transaction ids must be unique',
  });

/**
 * Server-internal execution result persisted in `mutation_log`.
 *
 * `status` remains optional only for pre-settlement hosted rows. At runtime an
 * omitted value has the established meaning `confirmed`; new source-forwarded
 * rows must use the explicit queued arm with both public correlation and exact
 * internal storage ids.
 */
const rawCommitExecutionResultSchema = z
  .strictObject({
    lastSyncId: z.number().int().nonnegative(),
    firstSyncId: z.number().int().nonnegative(),
    status: commitStatusSchema.optional(),
    correlationId: correlationIdSchema.optional(),
    confirmationTransactionIds: confirmationTransactionIdsSchema.optional(),
    notifications: notificationsSchema.optional(),
    missingIds: missingIdsSchema.optional(),
  })
  .superRefine((result, context) => {
    const validRange =
      (result.firstSyncId === 0 && result.lastSyncId === 0) ||
      (result.firstSyncId > 0 && result.firstSyncId <= result.lastSyncId);
    if (!validRange) {
      context.addIssue({
        code: 'custom',
        path: ['firstSyncId'],
        message: 'CommitResult sync range is inconsistent',
      });
    }

    if (result.status === 'queued') {
      if (!result.correlationId) {
        context.addIssue({
          code: 'custom',
          path: ['correlationId'],
          message: 'A queued source result requires a correlationId',
        });
      }
      if (!result.confirmationTransactionIds) {
        context.addIssue({
          code: 'custom',
          path: ['confirmationTransactionIds'],
          message: 'A queued source result requires durable confirmation ids',
        });
      }
      if (result.firstSyncId !== 0 || result.lastSyncId !== 0) {
        context.addIssue({
          code: 'custom',
          path: ['lastSyncId'],
          message: 'A queued source result cannot claim a confirmed sync range',
        });
      }
    }

    if (result.confirmationTransactionIds && !result.correlationId) {
      context.addIssue({
        code: 'custom',
        path: ['correlationId'],
        message: 'Confirmation transaction ids require their source correlation',
      });
    }
    if (result.correlationId && !result.confirmationTransactionIds) {
      context.addIssue({
        code: 'custom',
        path: ['confirmationTransactionIds'],
        message: 'A source correlation requires exact confirmation transaction ids',
      });
    }
    if (result.correlationId && result.status === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'Source-correlated results require explicit settlement status',
      });
    }
    if (
      result.status === 'confirmed' &&
      result.correlationId &&
      (result.firstSyncId <= 0 || result.lastSyncId <= 0)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['lastSyncId'],
        message: 'A source-confirmed result requires a durable positive sync range',
      });
    }
  });
export const commitExecutionResultSchema = rawCommitExecutionResultSchema.transform((result) => ({
  ...result,
  status: result.status ?? ('confirmed' as const),
}));
export type CommitExecutionResultInput = z.input<typeof commitExecutionResultSchema>;
export type CommitExecutionResult = z.infer<typeof commitExecutionResultSchema>;

const ackCommonShape = {
  lastSyncId: z.number().int().nonnegative(),
  notifications: notificationsSchema.optional(),
  missingIds: missingIdsSchema.optional(),
} as const;

/** Normalized acknowledgement handed from a mutation transport to the queue. */
export const commitAckSchema = z.discriminatedUnion('status', [
  z
    .strictObject({
      ...ackCommonShape,
      ...queuedSettlementShape,
    })
    .refine(({ lastSyncId }) => lastSyncId === 0, {
      path: ['lastSyncId'],
      message: 'A queued acknowledgement cannot claim a sync watermark',
    }),
  z
    .strictObject({
      ...ackCommonShape,
      ...confirmedSettlementShape,
    })
    .refine(({ correlationId, lastSyncId }) => correlationId === undefined || lastSyncId > 0, {
      path: ['lastSyncId'],
      message: 'A source-confirmed acknowledgement requires a sync watermark',
    }),
]);
export type CommitAck = z.infer<typeof commitAckSchema>;

const legacyMutationCommitResultSchema = z.strictObject({
  ...ackCommonShape,
  status: z.undefined().optional(),
  correlationId: z.undefined().optional(),
});

/**
 * Compatibility boundary for injected/older mutation executors. New
 * transports return `commitAckSchema`; a legacy `{lastSyncId}` is normalized
 * to explicit confirmed settlement before queue code branches on it.
 */
export const mutationCommitResultSchema = z
  .union([commitAckSchema, legacyMutationCommitResultSchema])
  .transform((result) => (result.status ? result : { ...result, status: 'confirmed' as const }));
export type MutationCommitResultInput = z.input<typeof mutationCommitResultSchema>;
export type MutationCommitResult = z.infer<typeof mutationCommitResultSchema>;

/**
 * Public SDK projection returned by `ablo.commits` and model mutations.
 *
 * This intentionally does not compose `commitSettlementSchema`: on the WS
 * facade, `wait:'queued'` currently means locally sealed/enqueued, before a
 * server has necessarily accepted the write. Renaming that public state to
 * `enqueued` is a separate protocol change; the authoritative settlement
 * union above is reserved for server acknowledgements.
 */
export const clientCommitReceiptSchema = z.strictObject({
  id: z.string().min(1),
  status: commitStatusSchema,
  lastSyncId: z.number().int().nonnegative().optional(),
  notifications: notificationsSchema.optional(),
  missingIds: missingIdsSchema.optional(),
});
export type ClientCommitReceipt = z.infer<typeof clientCommitReceiptSchema>;
