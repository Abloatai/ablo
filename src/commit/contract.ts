/**
 * The transport-independent v2 commit contract.
 *
 * A commit is a caller's atomic write intent. It contains ordered operations,
 * a stable idempotency key, and explicit write preconditions. HTTP and
 * WebSocket transports wrap these schemas; they do not redefine their data.
 * Every public data type in this module is inferred from the Zod schema that
 * validates it at a trust boundary.
 */
import { z } from 'zod';
import { ERROR_CODES, type WireErrorCode } from '../errorCodes.js';

/** Current version of the transport-independent commit contract. */
export const COMMIT_CONTRACT_VERSION = 2 as const;

// ── Opaque identifiers ───────────────────────────────────────────────────

/** Stable identity of one logical commit. Reused unchanged for every retry. */
export const idempotencyKeySchema = z.string().min(1).max(255).brand<'IdempotencyKey'>();
export type IdempotencyKey = z.output<typeof idempotencyKeySchema>;

/** Server-issued identity of a durable commit execution. */
export const commitIdSchema = z.uuid().brand<'CommitId'>();
export type CommitId = z.output<typeof commitIdSchema>;

/** Stable identity of one operation within a commit. */
export const operationIdSchema = z.string().min(1).max(255).brand<'OperationId'>();
export type OperationId = z.output<typeof operationIdSchema>;

/** Identity of a pessimistic claim whose generation fences a write. */
export const claimIdSchema = z.string().min(1).max(255).brand<'ClaimId'>();
export type ClaimId = z.output<typeof claimIdSchema>;

/**
 * Internal committed-log offset. Decimal strings preserve PostgreSQL BIGINT
 * precision across JavaScript and JSON boundaries.
 */
export const syncOffsetSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/, 'Expected a non-negative decimal sync offset')
  .brand<'SyncOffset'>();
export type SyncOffset = z.output<typeof syncOffsetSchema>;

/** Opaque resumable cursor returned to clients; consumers must not inspect it. */
export const syncCursorSchema = z.string().min(1).max(4096).brand<'SyncCursor'>();
export type SyncCursor = z.output<typeof syncCursorSchema>;

// ── JSON values ──────────────────────────────────────────────────────────

/** JSON-safe value accepted by a persisted or fingerprinted commit payload. */
export const jsonValueSchema = z.json();
export type JsonValue = z.output<typeof jsonValueSchema>;

/** JSON object accepted for entity values, patches, and structured details. */
export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);
export type JsonObject = z.output<typeof jsonObjectSchema>;

const nonEmptyJsonObjectSchema = jsonObjectSchema.refine(
  (value) => Object.keys(value).length > 0,
  'Expected at least one changed field'
);

// ── Intent ───────────────────────────────────────────────────────────────

/** Model and row addressed by an operation. */
export const entityRefSchema = z.strictObject({
  model: z.string().min(1).max(255),
  id: z.string().min(1).max(1024),
});
export type EntityRef = z.output<typeof entityRefSchema>;

const fieldPathSchema = z.string().min(1).max(1024);

/**
 * A condition that must still hold when an operation is applied. Preconditions
 * are data rather than option flags so they are included in the request
 * fingerprint and can be reported precisely when a commit conflicts.
 */
export const writePreconditionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('unchanged_since'),
    cursor: syncOffsetSchema,
    fields: z.array(fieldPathSchema).min(1).max(256).optional(),
  }),
  z.strictObject({
    type: z.literal('version_matches'),
    version: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal('claim_fence'),
    claimId: claimIdSchema,
    generation: z.number().int().positive(),
  }),
]);
export type WritePrecondition = z.output<typeof writePreconditionSchema>;

const operationBaseShape = {
  operationId: operationIdSchema,
  target: entityRefSchema,
  preconditions: z.array(writePreconditionSchema).max(16).default([]),
} as const;

/**
 * One ordered entity change within a commit. The discriminant makes illegal
 * combinations unrepresentable: only create carries `value`, only patch
 * carries `changes`, and destructive actions carry neither.
 */
export const commitOperationSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...operationBaseShape,
    type: z.literal('create'),
    value: jsonObjectSchema,
  }),
  z.strictObject({
    ...operationBaseShape,
    type: z.literal('patch'),
    changes: nonEmptyJsonObjectSchema,
  }),
  z.strictObject({
    ...operationBaseShape,
    type: z.literal('delete'),
  }),
  z.strictObject({
    ...operationBaseShape,
    type: z.literal('archive'),
  }),
  z.strictObject({
    ...operationBaseShape,
    type: z.literal('unarchive'),
  }),
]);
export type CommitOperationInput = z.input<typeof commitOperationSchema>;
export type CommitOperation = z.output<typeof commitOperationSchema>;

/** Semantic lineage included in the durable intent and its fingerprint. */
export const commitMetadataSchema = z.strictObject({
  label: z.string().min(1).max(255).optional(),
  causedByTaskId: z.string().min(1).max(255).optional(),
});
export type CommitMetadata = z.output<typeof commitMetadataSchema>;

const commitIntentShape = {
  schemaVersion: z.literal(COMMIT_CONTRACT_VERSION),
  operations: z.array(commitOperationSchema).min(1).max(500),
  metadata: commitMetadataSchema.optional(),
} as const;

/** The portion of a request that is fingerprinted, preserving operation order. */
export const commitIntentSchema = z.strictObject(commitIntentShape);
export type CommitIntentInput = z.input<typeof commitIntentSchema>;
export type CommitIntent = z.output<typeof commitIntentSchema>;

/** A caller's stable idempotency identity plus the intent it identifies. */
export const commitRequestSchema = z.strictObject({
  ...commitIntentShape,
  idempotencyKey: idempotencyKeySchema,
});
export type CommitRequestInput = z.input<typeof commitRequestSchema>;
export type CommitRequest = z.output<typeof commitRequestSchema>;

/** Returns the exact semantic value that an idempotency fingerprint covers. */
export function commitIntentOf(request: CommitRequest): CommitIntent {
  const { idempotencyKey, ...intent } = request;
  void idempotencyKey;
  return intent;
}

// ── Result ───────────────────────────────────────────────────────────────

const registeredWireErrorCodes = Object.entries(ERROR_CODES)
  .filter(([, spec]) => spec.surface === 'wire')
  .map(([code]) => code) as [WireErrorCode, ...WireErrorCode[]];

const policyErrorCodeSchema = z.custom<`policy:${string}`>(
  (value) => typeof value === 'string' && /^policy:.+$/.test(value),
  'Expected a registered error code or policy:<reason>'
);

/** Machine-readable failure code carried by a rejected v2 commit. */
export const commitErrorCodeSchema = z.union([
  z.enum(registeredWireErrorCodes),
  policyErrorCodeSchema,
]);
export type CommitErrorCode = z.output<typeof commitErrorCodeSchema>;

/** Structured capability a rejected commit would require on retry. */
export const requiredCapabilitySchema = z.strictObject({
  scope: z.string().min(1),
  constraints: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  issuer: z.string().min(1).optional(),
  ttlSeconds: z.number().int().positive().optional(),
  nonce: z.string().min(1).optional(),
});
export type RequiredCapability = z.output<typeof requiredCapabilitySchema>;

/** Structured terminal error for a commit that did not apply. */
export const commitErrorSchema = z.strictObject({
  code: commitErrorCodeSchema,
  message: z.string().min(1),
  field: fieldPathSchema.optional(),
  requiredCapability: requiredCapabilitySchema.optional(),
  details: jsonObjectSchema.optional(),
});
export type CommitError = z.output<typeof commitErrorSchema>;

/** One failed precondition and the smallest current state needed to reconcile. */
export const commitConflictSchema = z.strictObject({
  operationId: operationIdSchema,
  target: entityRefSchema,
  fields: z.array(fieldPathSchema).max(256),
  currentValues: jsonObjectSchema,
  observedAt: syncOffsetSchema,
});
export type CommitConflict = z.output<typeof commitConflictSchema>;

const commitReceiptBaseShape = {
  object: z.literal('commit_receipt'),
  schemaVersion: z.literal(COMMIT_CONTRACT_VERSION),
  idempotencyKey: idempotencyKeySchema,
  commitId: commitIdSchema,
} as const;

/**
 * Terminal result of a commit execution. Expected outcomes are a discriminated
 * union, so committed, conflicted, and rejected results cannot expose fields
 * belonging to another state.
 */
export const commitReceiptSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...commitReceiptBaseShape,
    status: z.literal('committed'),
    syncCursor: syncCursorSchema,
    operationCount: z.number().int().min(1).max(500),
  }),
  z.strictObject({
    ...commitReceiptBaseShape,
    status: z.literal('conflicted'),
    syncCursor: syncCursorSchema,
    conflicts: z.array(commitConflictSchema).min(1).max(500),
  }),
  z.strictObject({
    ...commitReceiptBaseShape,
    status: z.literal('rejected'),
    error: commitErrorSchema,
  }),
]);
export type CommitReceiptInput = z.input<typeof commitReceiptSchema>;
export type CommitReceipt = z.output<typeof commitReceiptSchema>;
export type CommittedCommitReceipt = Extract<CommitReceipt, { status: 'committed' }>;
export type ConflictedCommitReceipt = Extract<CommitReceipt, { status: 'conflicted' }>;
export type RejectedCommitReceipt = Extract<CommitReceipt, { status: 'rejected' }>;
