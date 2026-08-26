/**
 * What the ACCOUNT routes answer with — the surface you reach through the
 * `ablo` CLI rather than through a model: `GET /v1/projects`, `GET /api/schema`,
 * `GET /v1/logs`, `GET /v1/usage`.
 *
 * These are the shapes the server, the CLI, and the MCP server all have to
 * agree on. Before this module each of them spelled the shape out again — the
 * server inline in `c.json({ … })`, the others in hand-written interfaces — so
 * a renamed field broke a consumer at runtime with nothing failing in between.
 *
 * None of these endpoints appear in the published OpenAPI contract yet (they
 * sit in the spec test's `NOT_YET_PUBLISHED` set). Deriving the spec from these
 * schemas is what removes them from it.
 */

import { z } from 'zod';
import { listEnvelopeSchema } from './listEnvelope.js';
// Composed, never restated: these are the artifact's own shapes, and a
// hand-written mirror here would be a second copy of the exact record this
// response exists to stop withholding.
import { fieldMetaSchema, relationMetaSchema } from './modelShape.js';
// The price's own vocabulary. A dashboard that restated the tier names or the
// meter set would be a second definition of what the invoice is computed from.
import { meterEventSchema, planTierSchema, rateBracketSchema } from './pricing.js';
import type { SyncDeltaAction } from '../observation/contract.js';
import { deltaSchema } from '../observation/contract.js';
// Kept for the {@link ListEnvelope} references below; `GET /v1/logs`'s own
// envelope moved to `feedEvent.ts`, which owns the union it wraps.
import type { ListEnvelope } from './listEnvelope.js';

/**
 * One project — an app's own schema, data planes, and keys. `default` marks the
 * organization's implicit project, whose id is the organization's own.
 */
export const projectResponseSchema = z.object({
  object: z.literal('project'),
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  default: z.boolean(),
  created_at: z.string(),
});
export type ProjectResponse = z.infer<typeof projectResponseSchema>;

/**
 * `GET /v1/projects`.
 *
 * Uses the canonical paginated list envelope shared by every collection.
 */
export const projectListResponseSchema = listEnvelopeSchema(projectResponseSchema);
export type ProjectListResponse = z.infer<typeof projectListResponseSchema>;

/** One minted key, returned exactly once — the plaintext is never readable again. */
export const provisionedKeySchema = z.object({
  apiKey: z.string(),
  expiresAt: z.string().optional(),
});
export type ProvisionedKey = z.infer<typeof provisionedKeySchema>;

/**
 * What the CLI device flow gets back once a browser approval is exchanged for
 * a project-scoped control-plane management credential. Runtime branch
 * credentials are minted separately by `ablo dev` / `ablo branch credential`.
 *
 * `project` is the project the management credential is scoped to, resolved SERVER-SIDE from
 * the requested slug — null means the organization's default. The server's
 * answer is authoritative because it is what resolved the slug to an id, so the
 * CLI stores the credential under the project named here rather than the one it asked
 * for.
 */
export const provisionKeyResponseSchema = z.object({
  management: provisionedKeySchema,
  organizationId: z.string().optional(),
  organizationSlug: z.string().optional(),
  project: z.object({ id: z.string(), slug: z.string() }).nullable().optional(),
});
export type ProvisionKeyResponse = z.infer<typeof provisionKeyResponseSchema>;

/**
 * A model's declared conflict disposition as it travels on the wire, keyed by
 * committer kind.
 *
 * Spelled here rather than imported from the policy layer, which states the same
 * three members as a TypeScript interface: `wire/` holds runtime-validatable
 * schemas, and it is the protocol leaf — everything depends on it and it depends
 * on nothing. The check that the two never drift therefore lives on the policy
 * side of that edge, next to the interface, in `../claims/policy.ts`.
 */
/** One model in the deployed schema, as the schema read reports it. */
export const schemaModelResponseSchema = z.object({
  /** The key local code addresses (`ablo.records`). */
  key: z.string(),
  /** The wire typename the engine routes and gates on. */
  typename: z.string(),
  /**
   * Per-model content hash — the unit of the client's drift check, and the
   * revalidation key for everything below it.
   *
   * `fields` and `relations` change only when this does, so a client reads the
   * shape once and thereafter compares hashes: a cheap poll that refetches on a
   * push and never otherwise. Introspection that costs one request per schema
   * version rather than one per question.
   */
  hash: z.string(),
  /**
   * The model's fields, by name.
   *
   * The schema artifact has always carried these and this response dropped
   * them, so a caller with no local schema declaration — which is every caller
   * that is not TypeScript — had no way to learn that `item.title` is a
   * required string. It found out from a 400 at the end of a round trip.
   *
   * For an agent that is not merely slow, it is a reasoning detour: a typo
   * discovered through a rejected write costs a turn and an explanation, where
   * the same typo checked locally costs a millisecond.
   *
   * Absent on an artifact written before this was reported, which is why it is
   * optional rather than empty — "this server does not tell me" and "this model
   * has no fields" are different facts.
   */
  fields: z.record(z.string(), fieldMetaSchema).optional(),
  /**
   * The model's relations, by name — what a caller may expand, and into what.
   *
   * Optional for the same reason as {@link fields}.
   */
  relations: z.record(z.string(), relationMetaSchema).optional(),
});
export type SchemaModelResponse = z.infer<typeof schemaModelResponseSchema>;

/**
 * `GET /api/schema` — the schema active on the caller's plane.
 *
 * A discriminated union because the two answers carry different fields, and the
 * difference is the one a caller must act on: `active: false` means nothing has
 * been pushed to this plane, so `models` is empty and `ablo push` is the fix.
 * Reporting that as an inactive artifact with absent metadata, rather than as
 * optional fields on one shape, is what stops a consumer from reading a missing
 * `version` as a version of zero.
 */
export const schemaReadResponseSchema = z.discriminatedUnion('active', [
  z.object({
    active: z.literal(false),
    environment: z.string(),
    project: z.string().nullable(),
    models: z.array(schemaModelResponseSchema).readonly(),
  }),
  z.object({
    active: z.literal(true),
    environment: z.string(),
    project: z.string().nullable(),
    models: z.array(schemaModelResponseSchema).readonly(),
    schemaId: z.string(),
    version: z.number(),
    hash: z.string(),
    pushedAt: z.string().nullable(),
  }),
]);
export type SchemaReadResponse = z.infer<typeof schemaReadResponseSchema>;

/**
 * What a log reader calls each kind of entry.
 *
 * The log carries the full delta vocabulary, not just writes, so this has a
 * word for every one of them — a reader should never be shown the stored
 * letter. The eight are the plain-language face of {@link SyncDeltaAction}.
 */
export const logOpSchema = z.enum([
  'create',
  'update',
  'delete',
  'archive',
  'revive',
  'visible',
  'group_added',
  'group_removed',
]);
export type LogOp = z.infer<typeof logOpSchema>;

/**
 * The stored action letter, as a log reader sees it.
 *
 * Typed against {@link SyncDeltaAction} so it is total by construction: adding
 * a ninth action to the vocabulary stops this compiling until it has a word.
 * The alternative — a lookup with a fallback — is what let `A` reach callers
 * as the bare letter "a".
 */
export const LOG_OP_BY_ACTION: Readonly<Record<SyncDeltaAction, LogOp>> = {
  I: 'create',
  U: 'update',
  D: 'delete',
  A: 'archive',
  V: 'revive',
  C: 'visible',
  G: 'group_added',
  S: 'group_removed',
};

/** One entry in the log: what changed, and who changed it. */
export const logEventSchema = z.object({
  /**
   * Which arm of the feed this is. `GET /v1/logs` can carry claim transitions
   * alongside commits, and the two are told apart by this tag rather than by
   * sniffing for `op` versus `status` — a discriminator a consumer has to infer
   * is one every consumer infers differently.
   */
  object: z.literal('log_event'),
  id: z.number(),
  at: z.string(),
  model: z.string(),
  op: logOpSchema,
  recordId: z.string(),
  /** `kind:id` of the committer, or null when the log recorded none. */
  actor: z.string().nullable(),
  /** Authoritative row change for durable consumers. */
  delta: deltaSchema.optional(),
});
export type LogEvent = z.infer<typeof logEventSchema>;

/**
 * One day's usage. `results` is one row per `group_by` combination, carrying
 * the requested dimensions plus `total` and `count`; with no `group_by` it is a
 * single ungrouped row. The keys therefore depend on the request, which is why
 * the row stays open rather than claiming a fixed shape.
 *
 * `total` arrives as a string — it is a bigint in the database, and JSON has no
 * lossless number for it.
 */
export const usageBucketSchema = z.object({
  starting_at: z.string(),
  ending_at: z.string(),
  results: z.array(z.record(z.string(), z.unknown())).readonly(),
});
export type UsageBucket = z.infer<typeof usageBucketSchema>;

/**
 * One of the org's keys, as a management surface may show it.
 *
 * Everything here is safe to display: the prefix identifies a key without being
 * one. There is deliberately no field for the key itself — plaintext exists only
 * in the response to the mint that created it, and the store keeps a SHA-256
 * hash, so no later read can return it.
 */
export const controlKeySchema = z.object({
  id: z.string(),
  /** The leading, non-secret segment — enough to recognise a key by. */
  keyPrefix: z.string(),
  label: z.string().nullable(),
  kind: z.string(),
  scopes: z.array(z.string()).readonly(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  /** The project this key is scoped to; null = the org-default project. */
  projectId: z.string().nullable(),
});
export type ControlKey = z.infer<typeof controlKeySchema>;

/**
 * `GET /v1/dashboard/keys` — the org's live, hand-managed keys.
 *
 * Like the project list, this is not the canonical {@link ListEnvelope}: it
 * answers with a bare `keys` array. Stated as it is rather than as the envelope
 * it resembles.
 */
export const controlKeyListResponseSchema = z.object({
  keys: z.array(controlKeySchema).readonly(),
});
export type ControlKeyListResponse = z.infer<typeof controlKeyListResponseSchema>;

/**
 * `POST /v1/dashboard/keys` — the mint.
 *
 * `plaintext` is the only place the secret ever appears. The store keeps a
 * SHA-256 hash, so nothing can return it again: a consumer that reads the wrong
 * field name here does not get an error, it gets `undefined`, and the key is
 * gone. That is the whole reason this shape is defined once rather than
 * described at each end.
 */
export const keyMintedResponseSchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
  keyPrefix: z.string(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
  projectId: z.string().nullable(),
  /** The secret, in the only response that will ever carry it. */
  plaintext: z.string(),
});
export type KeyMintedResponse = z.infer<typeof keyMintedResponseSchema>;

/**
 * `DELETE /v1/dashboard/keys/:id`. `activeSessionsClosed` reports how many live
 * connections the revocation cut, so a caller can see it took effect on sessions
 * already open rather than only on future ones. A second revoke of the same key
 * is not an error — it answers `alreadyRevoked` and closes nothing.
 */
export const keyRevokedResponseSchema = z.object({
  id: z.string(),
  revoked: z.literal(true),
  revokedAt: z.string().optional(),
  alreadyRevoked: z.boolean().optional(),
  activeSessionsClosed: z.number().optional(),
});
export type KeyRevokedResponse = z.infer<typeof keyRevokedResponseSchema>;

/** `GET /v1/usage` — daily buckets, shaped after a usage report. */
export const usageReportResponseSchema = z.object({
  object: z.literal('usage_report'),
  buckets: z.array(usageBucketSchema).readonly(),
  has_more: z.boolean(),
  /** How stale the rollup behind these numbers may be. */
  data_freshness_seconds: z.number(),
});
export type UsageReportResponse = z.infer<typeof usageReportResponseSchema>;

/**
 * One meter's month-to-date usage, as a management surface shows it.
 *
 * `eventName` is the pricing contract's closed set rather than a free string,
 * so a surface cannot render a meter the price does not recognise. `billable`
 * says whether the meter reaches an invoice at all: bootstraps are recorded and
 * gated but never charged, and a usage table that does not say so reads as a
 * bill nobody sent.
 */
export const meterUsageSchema = z.object({
  eventName: meterEventSchema,
  displayName: z.string(),
  /** Operations counted this period. */
  total: z.number(),
  /** Requests behind that total. A commit of 500 operations counts once here. */
  count: z.number(),
  /** The plan's monthly allowance for this meter; null where it is ungated. */
  monthlyMax: z.number().nullable(),
  billable: z.boolean(),
});
export type MeterUsage = z.infer<typeof meterUsageSchema>;

/**
 * What the period costs, computed once by the server from the pricing contract.
 *
 * The client renders these rather than recomputing them. A dashboard that does
 * its own arithmetic is a second implementation of the price, and the one a
 * customer reads before they are billed, so it is the copy that has to be
 * right and the one nothing checks.
 */
export const billingSummarySchema = z.object({
  tier: planTierSchema,
  /** The tier as it reads on the pricing page. */
  label: z.string(),
  /** The monthly floor in USD; null where terms are contractual. */
  monthlyMinimumUsd: z.number().nullable(),
  /** Operations the floor already covers, or the hard cap on a capped tier. */
  includedOps: z.number().nullable(),
  /** Where the tier stops rather than bills; null on every metered tier. */
  hardCapOps: z.number().nullable(),
  /** The daily burst guard; null on every metered tier. */
  dailyCapOps: z.number().nullable(),
  /** Every billable meter, collapsed into the one number the price uses. */
  opsUsed: z.number(),
  /** The floor or the metered usage, whichever is greater. null = contract. */
  projectedBillUsd: z.number().nullable(),
  /** True where the published card is a starting point, not the terms. */
  contractPriced: z.boolean(),
  /**
   * The rate card in force, so a surface can show what the next operation
   * costs without shipping a copy of the price to the browser.
   */
  rateCard: z.array(rateBracketSchema).readonly(),
});
export type BillingSummary = z.infer<typeof billingSummarySchema>;

/**
 * `GET /v1/dashboard/usage-summary` — month-to-date usage and what it costs.
 *
 * Distinct from {@link usageReportResponseSchema}, which answers the public
 * `GET /v1/usage` with daily buckets for a caller doing its own analysis. This
 * one answers the question a person opens a dashboard to ask: what have I used,
 * and what will it cost.
 */
export const usageSummaryResponseSchema = z.object({
  plan: planTierSchema,
  /** Start of the billing period the numbers cover, ISO-8601. */
  periodStart: z.string(),
  meters: z.array(meterUsageSchema).readonly(),
  billing: billingSummarySchema,
});
export type UsageSummaryResponse = z.infer<typeof usageSummaryResponseSchema>;
