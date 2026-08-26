/**
 * Runtime contracts for retry-safe commits.
 *
 * `commitEnvelopeMemberSchema` is the compact pointer stored on an in-memory
 * transaction. `durableCommitEnvelopeSchema` is the actual outbox record: one
 * atomic IndexedDB value containing the stable request key, exact ordered wire
 * operations, and the source mutations it supersedes.
 */

import { z } from 'zod';
import { readDependencyListSchema } from '../../coordination/schema.js';
import { wireCommitOperationSchema } from '../../wire/frames.js';
import { correlationIdSchema } from '../contract.js';
import { idempotencyKeySchema } from './idempotencyKey.js';
import { snapshotJsonValue } from '../../utils/json.js';

export const COMMIT_ENVELOPE_VERSION = 1 as const;
export const COMMIT_ENVELOPE_RECORD_PREFIX = 'commit-envelope:';

/** One transaction's position in a commit; this is not the envelope itself. */
export const commitEnvelopeMemberSchema = z
  .strictObject({
    idempotencyKey: idempotencyKeySchema,
    operationIndex: z.number().int().nonnegative(),
    operationCount: z.number().int().positive(),
    sealedAt: z.number().int().nonnegative().optional(),
    sequence: z.number().int().nonnegative().optional(),
  })
  .refine(
    ({ operationIndex, operationCount }) => operationIndex < operationCount,
    { message: 'operationIndex must be smaller than operationCount' },
  );

export type CommitEnvelopeMember = z.infer<typeof commitEnvelopeMemberSchema>;

/** One operation stored exactly as the current commit transport sends it. */
export const durableCommitOperationSchema = wireCommitOperationSchema
  .pick({
    type: true,
    model: true,
    id: true,
    input: true,
    transactionId: true,
    claimId: true,
    readAt: true,
    fenceToken: true,
  })
  .extend({
    model: z.string().min(1),
    id: z.string().min(1),
    input: z.record(z.string(), z.unknown()).optional(),
    transactionId: z.string().min(1).optional(),
    claimId: z.string().min(1).optional(),
    options: z
      .strictObject({
        idempotencyKey: z.string().min(1).max(255).nullable().optional(),
        label: z.string().min(1).max(255).optional(),
      })
      .optional(),
  });

export type DurableCommitOperation = z.infer<typeof durableCommitOperationSchema>;
export type DurableCommitOperationInput = z.input<typeof durableCommitOperationSchema>;

const durableCommitOptionsSchema = z.strictObject({
  reads: readDependencyListSchema.nullable().optional(),
});

export const commitOutboxScopeSchema = z.strictObject({
  organizationId: z.string().min(1),
  participantId: z.string().min(1),
  namespace: z.string().min(1),
});
export type CommitOutboxScope = z.infer<typeof commitOutboxScopeSchema>;

/**
 * One crash-durable logical commit. Keeping every operation in one record makes
 * membership and order atomic: recovery can observe the old record or the new
 * record, never half an envelope.
 */
export const durableCommitEnvelopeSchema = z
  .strictObject({
    id: z.string().startsWith(COMMIT_ENVELOPE_RECORD_PREFIX),
    type: z.literal('commit_envelope'),
    storageVersion: z.literal(COMMIT_ENVELOPE_VERSION),
    origin: z.enum(['model_batch', 'atomic_commit']),
    idempotencyKey: idempotencyKeySchema,
    operations: z.array(durableCommitOperationSchema).min(1).max(500),
    // Bookkeeping cardinality is independent of the 500 wire-operation cap:
    // hundreds of same-row offline patches may coalesce into one operation.
    sourceMutationIds: z.array(z.string().min(1)).default([]),
    commitOptions: durableCommitOptionsSchema.default({}),
    scope: commitOutboxScopeSchema.optional(),
    createdAt: z.number().int().nonnegative(),
    sealedAt: z.number().int().nonnegative(),
    /**
     * Monotonic evidence that a connected source accepted this exact request.
     * Its server and customer idempotency keys are permanent, so an accepted
     * envelope remains replayable until the WAL echo confirms it.
     */
    acceptedAt: z.number().int().nonnegative().optional(),
    /** Opaque server-derived source-batch identity paired with `acceptedAt`. */
    correlationId: correlationIdSchema.optional(),
    /** Monotonic within one client; disambiguates writes sealed in the same ms. */
    sequence: z.number().int().nonnegative().optional(),
    timestamp: z.number().int().nonnegative(),
  })
  .superRefine((envelope, context) => {
    if (envelope.id !== commitEnvelopeRecordId(envelope.idempotencyKey)) {
      context.addIssue({
        code: 'custom',
        path: ['id'],
        message: 'Envelope record id must be derived from its idempotency key',
      });
    }
    if (new Set(envelope.sourceMutationIds).size !== envelope.sourceMutationIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['sourceMutationIds'],
        message: 'Source mutation ids must be unique',
      });
    }
    if ((envelope.acceptedAt === undefined) !== (envelope.correlationId === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['acceptedAt'],
        message: 'Accepted commit envelopes require both acceptedAt and correlationId',
      });
    }
    if (
      envelope.acceptedAt !== undefined &&
      envelope.acceptedAt < envelope.sealedAt
    ) {
      context.addIssue({
        code: 'custom',
        path: ['acceptedAt'],
        message: 'Commit envelope cannot be accepted before it is sealed',
      });
    }
    if (envelope.origin === 'model_batch') {
      const transactionIds = envelope.operations.map((operation) => operation.transactionId);
      if (transactionIds.some((id) => typeof id !== 'string' || id.length === 0)) {
        context.addIssue({
          code: 'custom',
          path: ['operations'],
          message: 'Every model-batch operation must carry a transactionId',
        });
      } else if (new Set(transactionIds).size !== transactionIds.length) {
        context.addIssue({
          code: 'custom',
          path: ['operations'],
          message: 'Model-batch transactionIds must be unique',
        });
      }
    }
  });

export type DurableCommitEnvelope = z.infer<typeof durableCommitEnvelopeSchema>;

export function commitEnvelopeRecordId(idempotencyKey: string): string {
  return `${COMMIT_ENVELOPE_RECORD_PREFIX}${idempotencyKey}`;
}

/** Constructs validated member metadata when an in-memory batch is formed. */
export function createCommitEnvelopeMember(
  value: z.input<typeof commitEnvelopeMemberSchema>,
): CommitEnvelopeMember {
  return commitEnvelopeMemberSchema.parse(value);
}

/**
 * Freezes the exact JSON request that will be persisted and sent. The shared
 * snapshot contract makes framework proxies plain and rejects values that
 * would be lost or corrupted by JSON serialization.
 */
export function createDurableCommitEnvelope(
  value: Omit<
    z.input<typeof durableCommitEnvelopeSchema>,
    'id' | 'type' | 'storageVersion' | 'timestamp'
  >,
): DurableCommitEnvelope {
  const candidate = {
    ...value,
    id: commitEnvelopeRecordId(value.idempotencyKey),
    type: 'commit_envelope' as const,
    storageVersion: COMMIT_ENVELOPE_VERSION,
    timestamp: value.sealedAt,
  };
  return durableCommitEnvelopeSchema.parse(
    snapshotJsonValue(candidate, '$.commitEnvelope'),
  );
}
