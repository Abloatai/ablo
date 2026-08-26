/** Crash-durable exact HTTP request used by the stateless agent client. */

import { z } from 'zod';
import { v5 as uuidv5 } from 'uuid';
import { snapshotJsonValue, stableStringify } from '../../utils/json.js';
import { correlationIdSchema } from '../contract.js';
import { PROTOCOL_VERSION } from '../../wire/protocolVersion.js';
import { idempotencyKeySchema } from './idempotencyKey.js';

export const HTTP_COMMIT_ENVELOPE_VERSION = 1 as const;
export const HTTP_COMMIT_ENVELOPE_PREFIX = 'http-commit-envelope:';
/** Stay one hour inside the server's 24-hour idempotency retention window. */
export const HTTP_COMMIT_REPLAY_WINDOW_MS = 23 * 60 * 60 * 1000;
const HTTP_COMMIT_SCOPE_ID_NAMESPACE = '043e8f73-86fc-5f62-af46-935d68fca729';

const commitPathSchema = z.literal('/v1/commits');
const modelCollectionPathSchema = z.string().regex(/^\/v1\/models\/[^/]+$/);
const modelEntityPathSchema = z.string().regex(/^\/v1\/models\/[^/]+\/[^/]+$/);

function hasSafeModelPathSegments(path: string): boolean {
  if (!path.startsWith('/v1/models/')) return true;
  try {
    return path
      .slice('/v1/models/'.length)
      .split('/')
      .every((segment) => {
        const decoded = decodeURIComponent(segment);
        return (
          decoded.length > 0 &&
          decoded !== '.' &&
          decoded !== '..' &&
          !decoded.includes('/') &&
          !decoded.includes('\\')
        );
      });
  } catch {
    return false;
  }
}

/** Snapshot the JSON contract once, then make object-key order canonical. */
export function canonicalHttpCommitBody(value: unknown): string {
  return stableStringify(snapshotJsonValue(value, '$.body'));
}

export const durableHttpCommitEnvelopeSchema = z
  .strictObject({
    id: z.string().startsWith(HTTP_COMMIT_ENVELOPE_PREFIX),
    type: z.literal('http_commit_envelope'),
    storageVersion: z.literal(HTTP_COMMIT_ENVELOPE_VERSION),
    idempotencyKey: idempotencyKeySchema,
    /**
     * The wire contract used when this exact request was sealed. Entries from
     * before protocol versioning omitted the field and are v1 by definition.
     */
    protocolVersion: z.number().int().positive().default(1),
    request: z.strictObject({
      method: z.enum(['POST', 'PATCH', 'DELETE']),
      path: z.string().startsWith('/'),
      body: z.string().refine((body) => {
        try {
          JSON.parse(body);
          return true;
        } catch {
          return false;
        }
      }, 'HTTP commit body must be valid JSON'),
    }),
    scopeNamespace: z.string().min(1),
    createdAt: z.number().int().nonnegative(),
    sealedAt: z.number().int().nonnegative(),
    /**
     * Monotonic evidence that the server accepted this exact request for a
     * connected source. Such server keys are permanent, so this envelope must
     * remain replayable past the ordinary hosted 24-hour window until its WAL
     * echo confirms.
     */
    acceptedAt: z.number().int().nonnegative().optional(),
    /** Opaque server-derived source-batch identity paired with `acceptedAt`. */
    correlationId: correlationIdSchema.optional(),
    /** Monotonic within one client; disambiguates writes sealed in the same ms. */
    sequence: z.number().int().nonnegative().optional(),
    timestamp: z.number().int().nonnegative(),
  })
  .superRefine((envelope, context) => {
    const legacyId = httpCommitEnvelopeRecordId(envelope.idempotencyKey);
    const scopedId = httpCommitEnvelopeRecordId(
      envelope.idempotencyKey,
      envelope.scopeNamespace,
    );
    if (envelope.id !== legacyId && envelope.id !== scopedId) {
      context.addIssue({
        code: 'custom',
        path: ['id'],
        message: 'HTTP envelope id must be derived from its idempotency key',
      });
    }
    if (envelope.sealedAt < envelope.createdAt) {
      context.addIssue({
        code: 'custom',
        path: ['sealedAt'],
        message: 'HTTP envelope cannot be sealed before it is created',
      });
    }
    if ((envelope.acceptedAt === undefined) !== (envelope.correlationId === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['acceptedAt'],
        message: 'Accepted HTTP envelopes require both acceptedAt and correlationId',
      });
    }
    if (
      envelope.acceptedAt !== undefined &&
      envelope.acceptedAt < envelope.sealedAt
    ) {
      context.addIssue({
        code: 'custom',
        path: ['acceptedAt'],
        message: 'HTTP envelope cannot be accepted before it is sealed',
      });
    }

    const { method, path } = envelope.request;
    const allowedPath =
      method === 'POST'
        ? commitPathSchema.safeParse(path).success ||
          modelCollectionPathSchema.safeParse(path).success
        : modelEntityPathSchema.safeParse(path).success;
    if (!allowedPath || !hasSafeModelPathSegments(path)) {
      context.addIssue({
        code: 'custom',
        path: ['request', 'path'],
        message: 'HTTP outbox records may target only commit or model-mutation routes',
      });
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(envelope.request.body) as unknown;
    } catch {
      return; // The field-level JSON refinement reports this.
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      context.addIssue({
        code: 'custom',
        path: ['request', 'body'],
        message: 'HTTP commit body must be a JSON object',
      });
      return;
    }
    const record = body as Record<string, unknown>;
    // `envelope.idempotencyKey` is replayed as the `Idempotency-Key` header.
    // Older sealed bodies may also carry `idempotencyKey`/`clientTxId`; accept
    // and replay them byte-for-byte, but current requests do not duplicate the
    // key in JSON.
    if (path === '/v1/commits') {
      if (!Array.isArray(record.operations) || record.operations.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['request', 'body'],
          message: 'Commit-route body must carry operations',
        });
      }
    } else if (method === 'POST' && typeof record.id !== 'string') {
      context.addIssue({
        code: 'custom',
        path: ['request', 'body', 'id'],
        message: 'Model-create body must carry its entity id',
      });
    } else if (
      method === 'PATCH' &&
      (typeof record.data !== 'object' || record.data === null || Array.isArray(record.data))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['request', 'body', 'data'],
        message: 'Model-update body must carry a JSON object patch',
      });
    }
  });

export type DurableHttpCommitEnvelope = z.infer<
  typeof durableHttpCommitEnvelopeSchema
>;

/**
 * The HTTP verbs a durable commit envelope can carry, projected out of the
 * persisted schema above. Callers that build, seal, or dispatch an envelope
 * take this rather than restating the verbs: the envelope is a stored contract,
 * so a verb the schema does not accept must not be constructible.
 */
export type DurableHttpCommitMethod = DurableHttpCommitEnvelope['request']['method'];

export function httpCommitEnvelopeRecordId(
  idempotencyKey: string,
  scopeNamespace?: string,
): string {
  if (!scopeNamespace) {
    return `${HTTP_COMMIT_ENVELOPE_PREFIX}${idempotencyKey}`;
  }
  const scopeId = uuidv5(scopeNamespace, HTTP_COMMIT_SCOPE_ID_NAMESPACE);
  return `${HTTP_COMMIT_ENVELOPE_PREFIX}${scopeId}:${idempotencyKey}`;
}

export function createDurableHttpCommitEnvelope(input: {
  idempotencyKey: string;
  request: {
    method: DurableHttpCommitMethod;
    path: string;
    body: unknown;
  };
  scopeNamespace: string;
  createdAt?: number;
  sealedAt?: number;
  sequence?: number;
}): DurableHttpCommitEnvelope {
  const now = Date.now();
  const createdAt = input.createdAt ?? now;
  const sealedAt = input.sealedAt ?? now;
  const body = canonicalHttpCommitBody(input.request.body);
  return durableHttpCommitEnvelopeSchema.parse({
    id: httpCommitEnvelopeRecordId(input.idempotencyKey, input.scopeNamespace),
    type: 'http_commit_envelope',
    storageVersion: HTTP_COMMIT_ENVELOPE_VERSION,
    idempotencyKey: input.idempotencyKey,
    protocolVersion: PROTOCOL_VERSION,
    request: {
      method: input.request.method,
      path: input.request.path,
      body,
    },
    scopeNamespace: input.scopeNamespace,
    createdAt,
    sealedAt,
    ...(input.sequence !== undefined ? { sequence: input.sequence } : {}),
    timestamp: sealedAt,
  });
}

export function isHttpCommitReplayExpired(
  envelope: Pick<DurableHttpCommitEnvelope, 'sealedAt' | 'acceptedAt'>,
  now = Date.now(),
): boolean {
  // Connected-source mutation-log and customer idempotency keys are
  // permanent. Once acceptance is durable, age can no longer make replay
  // ambiguous; only the matching WAL echo may settle the envelope.
  if (envelope.acceptedAt !== undefined) return false;
  return now - envelope.sealedAt >= HTTP_COMMIT_REPLAY_WINDOW_MS;
}
