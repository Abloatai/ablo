/**
 * Agent feedback — the one definition of what a stuck agent reports, and the
 * one rule for how two reports of the same wall are recognized as the same wall.
 *
 * This is deliberately NOT a product event. Events (`events.ts`) are a closed
 * enum of counters over `shortToken` primitives, collected by default, and the
 * schema itself is what guarantees no free text ever reaches the ledger.
 * Feedback is the inverse shape: prose, written by an agent, about a wall it
 * hit. It travels on its own route, under its own consent, and is never queued
 * beside a counter — so `ablo telemetry disable` cannot silently mean "and stop
 * reporting bugs", and the counters' privacy contract stays provable.
 *
 * The two properties that make a channel like this survivable at agent volume
 * live here rather than at either use site:
 *
 *   - {@link feedbackClusterKey} — agents are tireless and unembarrassed, so
 *     the same missing field arrives two hundred times. The cluster key is what
 *     turns that into one ticket with a count. It is stamped by the server, not
 *     the reporter, because the reporter does not own the fact.
 *   - the `context` block — an agent knows the typed `errorCode` it just saw.
 *     Attaching it turns prose into a pre-grouped ticket without anyone having
 *     to read the prose first.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cliArchitectureSchema, cliOsSchema } from './events';

export const AGENT_FEEDBACK_VERSION = 1 as const;

export const MAX_FEEDBACK_SUMMARY_LENGTH = 200;
export const MAX_FEEDBACK_DETAIL_LENGTH = 4_000;

/**
 * What kind of wall the agent hit. Ablo owns this taxonomy, so it is a closed
 * enum: a reporter picks from it and cannot invent a fifth. Each name is one an
 * issue tracker already uses, except `friction` — the case worth having and the
 * one no tracker names: it worked, and it was still hard.
 */
export const FEEDBACK_KINDS = ['bug', 'docs', 'feature', 'friction'] as const;
export const feedbackKindSchema = z.enum(FEEDBACK_KINDS);
export type FeedbackKind = z.infer<typeof feedbackKindSchema>;

/**
 * What each kind is for, in the words every surface prints.
 *
 * These live beside the taxonomy rather than in the CLI's usage text, because a
 * help screen that spells the kinds out by hand is a second definition: add a
 * fifth kind and the reporter is told about four. `Record<FeedbackKind, …>`
 * makes that a compile error instead — a kind with no sentence does not build,
 * and every surface renders from this one map.
 */
export const FEEDBACK_KIND_DESCRIPTIONS: Readonly<Record<FeedbackKind, string>> = {
  bug: 'It broke, or did something other than what it said it would.',
  docs: 'The answer was missing from the docs, or the docs were wrong.',
  feature: 'The thing you needed does not exist yet.',
  friction: 'It worked, and it was harder than it should have been.',
};

const shortToken = z.string().trim().min(1).max(100);

/**
 * Where the reporter was standing. Every field is optional because the most
 * valuable report comes from an agent stuck part-way through `ablo init`, which
 * knows almost nothing yet.
 */
export const feedbackContextSchema = z.strictObject({
  /** The command in play, e.g. `push` — the registry name, not the full argv. */
  command: shortToken.optional(),
  /** A code from the `ERROR_CODES` registry. The strongest clustering signal
   *  there is: it groups reports by the failure, not by how it was worded. */
  errorCode: shortToken.optional(),
  /** Which agent is reporting, e.g. `claude-code`. The world owns this set and
   *  adds to it faster than we could ship an enum, so it stays an open token. */
  reportedBy: shortToken.optional(),
  cliVersion: shortToken.optional(),
  os: cliOsSchema.optional(),
  architecture: cliArchitectureSchema.optional(),
  nodeMajorVersion: z.number().int().min(18).max(100).optional(),
});

export type FeedbackContext = z.infer<typeof feedbackContextSchema>;

/** One report. The wire shape, and the only definition of it. */
export const agentFeedbackSchema = z.strictObject({
  feedbackVersion: z.literal(AGENT_FEEDBACK_VERSION),
  /** Idempotency: a retried submission is the same report, not a second one. */
  submissionId: z.uuid(),
  occurredAt: z.iso.datetime({ offset: true }),
  kind: feedbackKindSchema,
  /** One line. This is the ticket title a human reads in a list. */
  summary: z.string().trim().min(1).max(MAX_FEEDBACK_SUMMARY_LENGTH),
  /** What happened, in the reporter's own words. */
  detail: z.string().trim().min(1).max(MAX_FEEDBACK_DETAIL_LENGTH).optional(),
  context: feedbackContextSchema.default({}),
});

export type AgentFeedback = z.infer<typeof agentFeedbackSchema>;

/** The request body. One report per request: feedback is a deliberate act, so
 *  a batch would be a mistake rather than an optimization. */
export const agentFeedbackSubmissionSchema = z.strictObject({
  feedback: agentFeedbackSchema,
});

export type AgentFeedbackSubmission = z.infer<typeof agentFeedbackSubmissionSchema>;

/** What the server answers. `clusterCount` lets the reporter learn it is the
 *  twelfth to hit this without a second round trip, which is also the honest
 *  thing to show it. */
export const agentFeedbackReceiptSchema = z.strictObject({
  submissionId: z.uuid(),
  accepted: z.boolean(),
  duplicate: z.boolean(),
  clusterKey: z.string(),
  clusterCount: z.number().int().positive(),
});

export type AgentFeedbackReceipt = z.infer<typeof agentFeedbackReceiptSchema>;

/**
 * Reduce a summary to the part that identifies the wall rather than the run.
 *
 * Two agents hitting one missing column write "column user_id_3 not found" and
 * "column user_id_7 not found". Those are one ticket. Digits, quoted fragments,
 * UUIDs, and hex blobs are the parts that vary per run, so they fold to a
 * placeholder before hashing; what remains is the signal.
 */
function normalizeSummary(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '#')
    .replace(/["'][^"']*["']/g, '#')
    .replace(/\b[0-9a-f]{7,}\b/g, '#')
    .replace(/\d+/g, '#')
    .replace(/[^a-z#\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The identity of the wall, not of the report. Stamped by the server, because
 * grouping is a fact about the corpus and a reporter cannot see the corpus.
 */
export function feedbackClusterKey(
  feedback: Pick<AgentFeedback, 'kind' | 'summary' | 'context'>
): string {
  const parts = [
    feedback.kind,
    feedback.context.errorCode ?? '',
    feedback.context.command ?? '',
    normalizeSummary(feedback.summary),
  ];
  return createHash('sha256').update(parts.join(' '), 'utf8').digest('hex').slice(0, 32);
}
