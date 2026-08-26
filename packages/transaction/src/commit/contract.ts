/**
 * Canonical runtime contracts for commit status.
 *
 * A commit crosses several boundaries during its lifetime: the server's
 * execution cache, the HTTP/WS receipt, and the client's acknowledgement
 * tracker. Those boundaries intentionally have different envelopes, but they
 * all compose the same lifecycle vocabulary from this module:
 *
 *   - `confirmed` — the authoritative change is visible through `lastSyncId`.
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
import { logPositionSchema } from '../syncLog/contract.js';
import {
  readDependencyListSchema,
  participantKindSchema,
} from '../coordination/schema.js';
import type { ErrorCode } from '../errorCodes.js';
import { requiredCapabilityWireSchema } from '../errors.js';
import { effectiveAuthoritySchema } from '../auth/capability.js';

/** Matches the permanent source/idempotency-key ceiling. */
export const COMMIT_CORRELATION_ID_MAX_LENGTH = 255;

/** Opaque server-authored identity shared by a queued receipt and its authoritative source delta. */
export const correlationIdSchema = z.string().min(1).max(COMMIT_CORRELATION_ID_MAX_LENGTH);
export type CorrelationId = z.infer<typeof correlationIdSchema>;

/** Public, server-authored commit timestamps. */
export const commitTimestampSchema = z.iso.datetime({ offset: true });

// These are the only lifecycle-literal declarations in transaction source.
// Every boundary below composes these schemas instead of spelling a status.
export const queuedStatusSchema = z.literal('queued');
export const confirmedStatusSchema = z.literal('confirmed');
export const rejectedStatusSchema = z.literal('rejected');

export const queuedCommitStatusSchema = z.strictObject({
  status: queuedStatusSchema,
  statusAt: commitTimestampSchema,
  lastSyncId: z.literal(0),
  correlationId: correlationIdSchema,
});

export const confirmedCommitStatusSchema = z
  .strictObject({
    status: confirmedStatusSchema,
    statusAt: commitTimestampSchema,
    lastSyncId: logPositionSchema,
    correlationId: correlationIdSchema.optional(),
  })
  .refine(({ correlationId, lastSyncId }) => correlationId === undefined || lastSyncId > 0, {
    path: ['lastSyncId'],
    message: 'A source-confirmed commit requires a positive lastSyncId',
  });

export const rejectedCommitStatusSchema = z.strictObject({
  status: rejectedStatusSchema,
  statusAt: commitTimestampSchema,
});

/** The single semantic owner of the complete commit lifecycle fact. */
export const commitStatusSchema = z.discriminatedUnion('status', [
  queuedCommitStatusSchema,
  confirmedCommitStatusSchema,
  rejectedCommitStatusSchema,
]);
export type CommitStatusValue = z.infer<typeof commitStatusSchema>;
export type CommitStatus = CommitStatusValue['status'];

/**
 * The lifecycle states a write may block on — extracted from the reported
 * vocabulary above, never restated beside it. `commitStatusSchema` is every
 * state a server can report; this is the subset a caller can usefully wait for,
 * and the two are not the same question: one describes an outcome, the other a
 * request.
 *
 * `.extract` keeps the relationship mechanical in both directions. Renaming a
 * lifecycle state breaks this line at build time, and adding one that nobody
 * can block on — a commit parked for a human, say — does not become a legal
 * `wait` merely by being added above. Both the `wait` option's runtime
 * validator and its interface derive from here, so they cannot disagree.
 */
export const commitWaitSchema = z.union([queuedStatusSchema, confirmedStatusSchema]);
export type CommitWait = z.infer<typeof commitWaitSchema>;

const missingIdsSchema = z.array(z.string().min(1));

export const commitOperationOutcomeSchema = z.enum([
  'created',
  'updated',
  'deleted',
  'archived',
  'unarchived',
]);

export const commitOperationResultSchema = z.strictObject({
  transactionId: z.string().min(1),
  outcome: commitOperationOutcomeSchema,
  row: z.record(z.string(), z.unknown()),
});
export type CommitOperationResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> = Omit<z.infer<typeof commitOperationResultSchema>, 'row'> & { readonly row: Row };

const operationResultsSchema = z
  .array(commitOperationResultSchema)
  .min(1)
  .refine(
    (results) => new Set(results.map((result) => result.transactionId)).size === results.length,
    'operation result transactionIds must be unique',
  );

export const commitActorSchema = z.strictObject({
  kind: participantKindSchema,
  id: z.string().min(1),
});
export type CommitActor = z.infer<typeof commitActorSchema>;

export const commitAttemptSchema = z.strictObject({
  id: z.string().min(1),
  observedAt: commitTimestampSchema,
  transport: z.enum(['http', 'websocket', 'internal']),
  kind: z.enum(['execution', 'replay']),
});
export type CommitAttempt = z.infer<typeof commitAttemptSchema>;

export const commitClaimReferenceSchema = z.strictObject({
  id: z.string().min(1),
  target: z.strictObject({
    scope: z.literal('row'),
    model: z.string(),
    id: z.string(),
    fields: z.array(z.string()).readonly().optional(),
  }),
  fenceToken: z.number().int().nonnegative(),
});
export type CommitClaimReference = z.infer<typeof commitClaimReferenceSchema>;

const commitEvidenceShape = {
  attempts: z.array(commitAttemptSchema).min(1).readonly(),
  actor: commitActorSchema,
  authority: effectiveAuthoritySchema,
  claims: z.array(commitClaimReferenceSchema).readonly(),
} as const;

function requireNonnegativeStatusLatency(
  value: { readonly createdAt: string; readonly statusAt: string },
  context: z.RefinementCtx,
): void {
  if (Date.parse(value.statusAt) < Date.parse(value.createdAt)) {
    context.addIssue({
      code: 'custom',
      path: ['statusAt'],
      message: 'Commit statusAt cannot precede createdAt',
    });
  }
}

const successfulReceiptCommonShape = {
  object: z.literal('commit_receipt'),
  /** Optional convenience id used by some HTTP surfaces. */
  id: z.string().min(1).optional(),
  clientTxId: z.string().min(1),
  serverTxId: z.string().min(1),
  createdAt: commitTimestampSchema,
  success: z.literal(true),
  ops: z.number().int().nonnegative(),
  authority: effectiveAuthoritySchema,
  missingIds: missingIdsSchema.optional(),
  /** Exact rows returned by the writing transaction; absent on durable replay. */
  operationResults: operationResultsSchema.optional(),
} as const;

const queuedCommitReceiptSchema = queuedCommitStatusSchema.safeExtend(
  successfulReceiptCommonShape,
);

const confirmedCommitReceiptSchema = confirmedCommitStatusSchema.safeExtend(
  successfulReceiptCommonShape,
);

/**
 * Successful HTTP/WS receipt. This schema is deliberately strict about the
 * lifecycle discriminant. Zod's default object behavior strips additive
 * fields, which is forward compatible without allowing server-internal
 * recovery evidence to leak through a parsed wire receipt.
 */
export const commitReceiptSchema = z
  .discriminatedUnion('status', [queuedCommitReceiptSchema, confirmedCommitReceiptSchema])
  .superRefine(requireNonnegativeStatusLatency);
export type CommitReceiptWire = z.infer<typeof commitReceiptSchema>;

/**
 * The rejection code is deliberately not narrowed to the {@link ErrorCode}
 * registry. A newer server may reject a commit with a code this build predates,
 * and failing the whole receipt over an unrecognized string would turn a
 * readable rejection into an opaque parse error. `errorCodes.ts` sanctions this
 * single boundary cast; every code *producer* is constrained at the
 * `AbloError` constructor instead.
 */
const errorCodeSchema = z.string().min(1) as z.ZodType<ErrorCode>;
const commitErrorSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  field: z.string().optional(),
  request_id: z.string().optional(),
  event_id: z.string().optional(),
  requiredCapability: requiredCapabilityWireSchema.optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

/** The failure arm is separate: queued/confirmed always imply `success:true`. */
export const rejectedCommitReceiptSchema = rejectedCommitStatusSchema
  .safeExtend({
    object: z.literal('commit_receipt'),
    clientTxId: z.string(),
    serverTxId: z.string(),
    createdAt: commitTimestampSchema,
    success: z.literal(false),
    ops: z.number().int().nonnegative().optional(),
    /** Server-stamped authority; request bodies have no authority field. */
    authority: effectiveAuthoritySchema,
    error: commitErrorSchema,
  })
  .superRefine(requireNonnegativeStatusLatency);
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
 * Server-internal execution result persisted in `mutation_log`. It composes
 * the same required status fact as the public boundaries plus internal sync
 * range and recovery evidence.
 */
const executionEvidenceShape = {
    firstSyncId: z.number().int().nonnegative(),
    createdAt: commitTimestampSchema,
    confirmationTransactionIds: confirmationTransactionIdsSchema.optional(),
    missingIds: missingIdsSchema.optional(),
} as const;

const queuedCommitExecutionResultSchema = queuedCommitStatusSchema.safeExtend(
  executionEvidenceShape,
);
const confirmedCommitExecutionResultSchema = confirmedCommitStatusSchema.safeExtend(
  executionEvidenceShape,
);

const canonicalCommitExecutionResultSchema = z
  .discriminatedUnion('status', [
    queuedCommitExecutionResultSchema,
    confirmedCommitExecutionResultSchema,
  ])
  .superRefine((result, context) => {
    requireNonnegativeStatusLatency(result, context);
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

    if (result.status === queuedStatusSchema.value) {
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
    if (result.status === confirmedStatusSchema.value && result.correlationId && result.firstSyncId <= 0) {
      context.addIssue({
        code: 'custom',
        path: ['lastSyncId'],
        message: 'A source-confirmed result requires a durable positive sync range',
      });
    }
  });

/** Canonical storage contract. Status is never optional or reconstructed. */
export const commitExecutionResultSchema = canonicalCommitExecutionResultSchema;
export type CommitExecutionResultInput = z.input<typeof commitExecutionResultSchema>;
export type CommitExecutionResult = z.infer<typeof commitExecutionResultSchema>;

const ackCommonShape = {
  missingIds: missingIdsSchema.optional(),
  operationResults: operationResultsSchema.optional(),
} as const;

/** Normalized acknowledgement handed from a mutation transport to the queue. */
export const commitAckSchema = z.discriminatedUnion('status', [
  queuedCommitStatusSchema.safeExtend(ackCommonShape),
  confirmedCommitStatusSchema.safeExtend(ackCommonShape),
]);
export type CommitAck = z.infer<typeof commitAckSchema>;

/**
 * The boundary an injected mutation executor returns through. It is the
 * acknowledgement schema itself: status is declared, never inferred from
 * an omission, so a transport cannot report a write as landed by staying
 * silent about how it landed.
 */
export const mutationCommitResultSchema = commitAckSchema;
export type MutationCommitResultInput = z.input<typeof mutationCommitResultSchema>;
export type MutationCommitResult = z.infer<typeof mutationCommitResultSchema>;

/**
 * Public SDK projection returned by `ablo.commits` and model mutations.
 *
 * This intentionally carries only the status name: on the WS
 * facade, `wait:'queued'` currently means locally sealed/enqueued, before a
 * server has necessarily accepted the write. Renaming that public state to
 * `enqueued` is a separate protocol change; the authoritative status
 * union above is reserved for server acknowledgements.
 */
export const clientCommitReceiptSchema = z.strictObject({
  id: z.string().min(1),
  status: z.union([queuedStatusSchema, confirmedStatusSchema]),
  lastSyncId: logPositionSchema.optional(),
  missingIds: missingIdsSchema.optional(),
  operationResults: operationResultsSchema.optional(),
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
  claimId: z.string().min(1).nullish(),
  readAt: logPositionSchema.nullish(),
  fenceToken: z.number().nullish(),
};

/** Canonical public spelling of a model operation. */
export const modelOperationActionSchema = z.enum([
  'create',
  'update',
  'delete',
  'archive',
  'unarchive',
]);
export type ModelOperationAction = z.infer<typeof modelOperationActionSchema>;

/** Convert a storage operation verb into the canonical lowercase commit action. */
export function normalizeStorageOperationAction(value: string): ModelOperationAction {
  return modelOperationActionSchema.parse(value.toLowerCase());
}

/** One write inside a commit, in the canonical spelling. */
export const commitOperationBodySchema = z.object({
  ...commitOperationControlShape,
  action: modelOperationActionSchema,
  model: z.string(),
  data: z.record(z.string(), z.unknown()).nullish(),
  where: z.record(z.string().min(1), z.unknown()).nullish(),
});
export type CommitOperationBody = z.infer<typeof commitOperationBodySchema>;

/** Commit records retain intent metadata but never copy customer mutation data. */
export const COMMIT_OPERATION_DATA_RETENTION = 'redacted' as const;
export const commitRecordOperationSchema = commitOperationBodySchema
  .omit({ data: true, where: true })
  .safeExtend({ data: z.strictObject({ retention: z.literal(COMMIT_OPERATION_DATA_RETENTION) }) });
export type CommitRecordOperation = z.infer<typeof commitRecordOperationSchema>;

/** Transport/result evidence nested beneath the canonical record status. */
export const commitReceiptEvidenceSchema = z.strictObject({
  clientTxId: z.string().min(1),
  serverTxId: z.string(),
  ops: z.number().int().nonnegative().optional(),
  missingIds: missingIdsSchema.optional(),
  error: commitErrorSchema.optional(),
});
export type CommitReceiptEvidence = z.infer<typeof commitReceiptEvidenceSchema>;

/**
 * The `POST /v1/commits` request body.
 *
 * `operations` carries the writes and `reads` carries the compact row evidence
 * those writes were based on. Request identity travels in the
 * `Idempotency-Key` header.
 */
export const commitRequestSchema = z.strictObject({
  operations: z.array(commitOperationBodySchema).min(1),
  reads: readDependencyListSchema.nullish(),
});
export type CommitRequest = z.infer<typeof commitRequestSchema>;

/**
 * Current canonical commit projection. Status, time, lastSyncId, and source
 * correlation occur once at the top level; receipt retains transport evidence.
 */
const commitRecordEvidenceShape = {
    id: z.string().min(1),
    ...commitEvidenceShape,
    createdAt: commitTimestampSchema,
    reads: readDependencyListSchema.readonly(),
    operations: z.array(commitRecordOperationSchema).readonly(),
    receipt: commitReceiptEvidenceSchema,
} as const;

export const commitRecordSchema = z
  .discriminatedUnion('status', [
    queuedCommitStatusSchema.safeExtend(commitRecordEvidenceShape),
    confirmedCommitStatusSchema.safeExtend(commitRecordEvidenceShape),
    rejectedCommitStatusSchema.safeExtend({
      ...commitRecordEvidenceShape,
      lastSyncId: z.literal(0),
    }),
  ])
  .superRefine((record, context) => {
    requireNonnegativeStatusLatency(record, context);
    if (record.status === rejectedStatusSchema.value && !record.receipt.error) {
      context.addIssue({
        code: 'custom',
        path: ['receipt', 'error'],
        message: 'A rejected CommitRecord requires rejection evidence',
      });
    }
    if (record.status !== rejectedStatusSchema.value && record.receipt.error) {
      context.addIssue({
        code: 'custom',
        path: ['receipt', 'error'],
        message: 'An accepted CommitRecord cannot carry rejection evidence',
      });
    }
  });
export type CommitRecord = z.infer<typeof commitRecordSchema>;

export const commitRecordWhereSchema = z.strictObject({
  actorId: z.string().min(1).optional(),
  status: z.union([queuedStatusSchema, confirmedStatusSchema, rejectedStatusSchema]).optional(),
});
export type CommitRecordWhere = z.infer<typeof commitRecordWhereSchema>;

export const commitRecordListOptionsSchema = z.strictObject({
  where: commitRecordWhereSchema.optional(),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type CommitRecordListOptions = z.infer<typeof commitRecordListOptionsSchema>;

export const commitRecordListSchema = z.strictObject({
  data: z.array(commitRecordSchema).readonly(),
  nextCursor: z.string().min(1).nullable(),
});
export type CommitRecordList = z.infer<typeof commitRecordListSchema>;
