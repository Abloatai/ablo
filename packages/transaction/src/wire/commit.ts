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
import {
  onStaleModeSchema,
  readDependencySchema,
  staleNotificationSchema,
  trackDependencySchema,
} from '../coordination/schema.js';
import type { ErrorCode } from '../errorCodes.js';
import { requiredCapabilityWireSchema } from '../errors.js';

/** Matches the permanent source/idempotency-key ceiling. */
export const COMMIT_CORRELATION_ID_MAX_LENGTH = 255;

/** Opaque server-authored identity shared by a queued receipt and its authoritative source delta. */
export const correlationIdSchema = z.string().min(1).max(COMMIT_CORRELATION_ID_MAX_LENGTH);
export type CorrelationId = z.infer<typeof correlationIdSchema>;

export const commitStatusSchema = z.enum(['queued', 'confirmed']);
export type CommitStatus = z.infer<typeof commitStatusSchema>;

/**
 * The settlement states a write may block on — extracted from the reported
 * vocabulary above, never restated beside it. `commitStatusSchema` is every
 * state a server can report; this is the subset a caller can usefully wait for,
 * and the two are not the same question: one describes an outcome, the other a
 * request.
 *
 * `.extract` keeps the relationship mechanical in both directions. Renaming a
 * settlement state breaks this line at build time, and adding one that nobody
 * can block on — a commit parked for a human, say — does not become a legal
 * `wait` merely by being added above. Both the `wait` option's runtime
 * validator and its interface derive from here, so they cannot disagree.
 */
export const commitWaitSchema = commitStatusSchema.extract(['queued', 'confirmed']);
export type CommitWait = z.infer<typeof commitWaitSchema>;

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
 * The rejection code is deliberately not narrowed to the {@link ErrorCode}
 * registry. A newer server may reject a commit with a code this build predates,
 * and failing the whole receipt over an unrecognized string would turn a
 * readable rejection into an opaque parse error. `errorCodes.ts` sanctions this
 * single boundary cast; every code *producer* is constrained at the
 * `AbloError` constructor instead.
 */
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
    request_id: z.string().optional(),
    requiredCapability: requiredCapabilityWireSchema.optional(),
    details: z.record(z.string(), z.unknown()).optional(),
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

/**
 * The boundary an injected mutation executor returns through. It is the
 * acknowledgement schema itself: settlement is declared, never inferred from
 * an omission, so a transport cannot report a write as landed by staying
 * silent about how it landed.
 */
export const mutationCommitResultSchema = commitAckSchema;
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

// ─────────────────────────────────────────────────────────────────────────
//  The request side of the commit boundary
// ─────────────────────────────────────────────────────────────────────────
//
// `POST /v1/commits` is the chokepoint every write passes through, so its
// request shape is a boundary contract and belongs here beside the receipt it
// answers with — not in a route handler. The published OpenAPI reference is
// derived from these schemas rather than describing them separately, so the
// documented surface cannot drift from the validated one.
//
// The server layers its own decoder-only compatibility spellings on top for
// already-shipped clients; those are a rollout concern, not the contract.

/** Control fields any operation in a commit may carry. */
export const commitOperationControlShape = {
  id: z.string().nullish(),
  transactionId: z.string().nullish(),
  readAt: z.number().nullish(),
  onStale: onStaleModeSchema.nullish(),
  fenceToken: z.number().nullish(),
};

/** One write inside a commit, in the canonical spelling. */
export const commitOperationBodySchema = z.object({
  ...commitOperationControlShape,
  action: z.string(),
  model: z.string(),
  data: z.record(z.string(), z.unknown()).nullish(),
});
export type CommitOperationBody = z.infer<typeof commitOperationBodySchema>;

/**
 * The `POST /v1/commits` request body.
 *
 * `operations` carries the writes; `track` registers durable premises.
 * Neither is required on its own, because a body with `track` and no
 * `operations` is how a caller starts watching a row without writing to it.
 * Request identity travels in the `Idempotency-Key` header.
 */
export const commitRequestSchema = z.object({
  operations: z.array(commitOperationBodySchema).min(1).optional(),
  reads: z.array(readDependencySchema).nullish(),
  track: z.array(trackDependencySchema).nullish(),
});
export type CommitRequest = z.infer<typeof commitRequestSchema>;
