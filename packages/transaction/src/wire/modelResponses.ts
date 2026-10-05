/**
 * What the model read routes answer with — `GET /v1/models/{model}/{id}` and
 * `GET /v1/models/{model}`.
 *
 * `data` is `unknown` here on purpose. The transport that reads these responses
 * is schema-agnostic: it moves rows for whatever schema the caller declared, so
 * it validates the envelope around a row and leaves the row itself to the typed
 * surface above it. Everything outside `data` — the watermark, the claims, the
 * pagination — is protocol, and protocol is validated here.
 */

import { z } from 'zod';
import { modelClaimSchema } from '../coordination/schema.js';
import { listEnvelopeSchema } from './listEnvelope.js';
import { errorEnvelopeSchema } from './errorEnvelope.js';

/** Evidence for one row returned by a collection snapshot. */
export const modelListEvidenceSchema = z.object({
  id: z.string().min(1),
  stamp: z.number().int().nonnegative(),
});
export type ModelListEvidence = z.infer<typeof modelListEvidenceSchema>;

/**
 * `GET /v1/models/{model}/{id}`.
 *
 * `stamp` is the row's watermark: the log position the read reflects. A write
 * that guards on this premise (`readAt`) is rejected if the row moved on in
 * between, which is what makes a read→decide→write sequence safe without a
 * lock. A missing row carries `data: null` so its absence watermark survives
 * the transport boundary.
 */
export const modelReadResponseSchema = z.object({
  object: z.literal('model'),
  model: z.string(),
  id: z.string(),
  data: z.unknown(),
  stamp: z.number(),
  /** Who holds this row right now — empty when no claim store is configured. */
  claims: z.array(modelClaimSchema).readonly(),
});
export type ModelReadResponse = z.infer<typeof modelReadResponseSchema>;

/**
 * `GET /v1/models/{model}` — the list envelope, with the two fields the model
 * routes add to it: the model's name and the org-wide watermark the page was
 * read at.
 *
 * The envelope is derived, not restated. A schema-agnostic row is `z.unknown()`,
 * which the generic helper accepts like any other item schema, so there is no
 * layer at which the shared fields have to be spelled a second time.
 */
export const modelListResponseSchema = listEnvelopeSchema(z.unknown()).extend({
  model: z.string(),
  stamp: z.number(),
  /**
   * Per-row watermarks captured no later than the collection snapshot. Optional
   * only so a newer client can diagnose an older server explicitly.
   */
  evidence: z.array(modelListEvidenceSchema).readonly().optional(),
});
export type ModelListResponse = z.infer<typeof modelListResponseSchema>;

/** Bounded model reads with the same envelopes as the individual GET routes. */
export const MODEL_READ_BATCH_SIZE = 50;
export const MODEL_READ_BATCH_MAX_BYTES = 1024 * 1024;
export const modelReadBatchItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('read'), model: z.string().min(1), id: z.string().min(1) }),
  z.object({ kind: z.literal('list'), model: z.string().min(1), query: z.record(z.string(), z.string()) }),
]);
export type ModelReadBatchItem = z.infer<typeof modelReadBatchItemSchema>;
export const modelReadBatchRequestSchema = z.object({
  reads: z.array(modelReadBatchItemSchema).min(1).max(MODEL_READ_BATCH_SIZE),
});
export const modelReadBatchResponseSchema = z.object({
  results: z.array(z.union([
    z.object({ result: z.union([modelReadResponseSchema, modelListResponseSchema]) }),
    z.object({ status: z.number().int().min(400).max(599), error: errorEnvelopeSchema }),
  ])).min(1).max(MODEL_READ_BATCH_SIZE),
});
export type ModelReadBatchResponse = z.infer<typeof modelReadBatchResponseSchema>;
