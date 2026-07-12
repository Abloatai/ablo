/** Crash-durable exact HTTP request used by the stateless agent client. */

import { z } from 'zod';
import { v5 as uuidv5 } from 'uuid';
import { idempotencyKeySchema } from '../commit/contract.js';
import { stableStringify } from '../utils/json.js';

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

/** Apply normal JSON semantics once, then make object-key order canonical. */
export function canonicalHttpCommitBody(value: unknown): string {
  const serialized = JSON.stringify(value) as string | undefined;
  if (serialized === undefined) {
    throw new TypeError('HTTP commit body is not JSON serializable');
  }
  return stableStringify(JSON.parse(serialized) as unknown);
}

export const durableHttpCommitEnvelopeSchema = z
  .strictObject({
    id: z.string().startsWith(HTTP_COMMIT_ENVELOPE_PREFIX),
    type: z.literal('http_commit_envelope'),
    storageVersion: z.literal(HTTP_COMMIT_ENVELOPE_VERSION),
    idempotencyKey: idempotencyKeySchema,
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
    if (record.idempotencyKey !== envelope.idempotencyKey) {
      context.addIssue({
        code: 'custom',
        path: ['request', 'body', 'idempotencyKey'],
        message: 'HTTP body idempotency key must match its envelope',
      });
    }
    if (path === '/v1/commits') {
      if (
        record.clientTxId !== envelope.idempotencyKey ||
        !Array.isArray(record.operations) ||
        record.operations.length === 0
      ) {
        context.addIssue({
          code: 'custom',
          path: ['request', 'body'],
          message: 'Commit-route body must carry the same clientTxId and operations',
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
    method: 'POST' | 'PATCH' | 'DELETE';
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
  envelope: Pick<DurableHttpCommitEnvelope, 'sealedAt'>,
  now = Date.now(),
): boolean {
  return now - envelope.sealedAt >= HTTP_COMMIT_REPLAY_WINDOW_MS;
}
