/**
 * Language-model middleware that tells the model when other participants are
 * editing the same entity. It reads peer claims on the target from the agent's
 * live presence stream and, when it finds any, injects a short coordination note
 * into the prompt before the model runs.
 *
 * This is the counterpart to the claim-broadcast middleware: that one announces
 * what this agent is about to do, while this one reads what others are doing and
 * passes it to the model. Together they let the model notice when a person or
 * another agent is mid-edit and respond — deferring, framing its work as
 * complementary, or suggesting it wait.
 *
 * It depends only on the AI SDK's provider types and a connected agent from this
 * package, and you compose it with the AI SDK's `wrapLanguageModel`. Reading
 * peers costs no extra model calls: the presence stream is already in memory from
 * the agent's subscription. It adds only a few sentences to the system prompt,
 * and only while peers are actively editing.
 */

import type {
  LanguageModelV3Middleware,
  LanguageModelV3Prompt,
} from '@ai-sdk/provider';
import type { Ablo } from '../client/Ablo.js';
import type { SchemaRecord } from '../transaction/schema/schema.js';
import type { Claim, ClaimTarget } from '../transaction/types/streams.js';

export type { ClaimTarget };

export interface CoordinationContextMiddlewareOptions<R extends SchemaRecord = SchemaRecord> {
  readonly agent: Ablo<R> | null;
  readonly target: ClaimTarget | null;
  /**
   * Claim identifiers to leave out of the read, typically this agent's own active
   * claim so the note doesn't report that the agent is editing against itself. In
   * the usual composition with the claim-broadcast middleware, `transformParams`
   * runs before that middleware declares its claim, so the agent's own claim
   * isn't in the presence stream yet and no filtering is needed. This option is
   * here for callers that compose the middleware differently, or that coordinate a
   * fleet and want to exclude sibling workers' claims.
   */
  readonly excludeClaimIds?: readonly string[];
}

/**
 * Builds the coordination-context middleware. If `agent` or `target` is null, the
 * middleware passes the prompt through unchanged.
 *
 * The generic over the schema record matches the claim-broadcast middleware: a
 * typed `Ablo<S>` and the widened `Ablo<SchemaRecord>` are not structurally
 * assignable, so the parameter stays generic to spare callers a cast.
 */
export function coordinationContextMiddleware<R extends SchemaRecord = SchemaRecord>(
  options: CoordinationContextMiddlewareOptions<R>,
): LanguageModelV3Middleware {
  const { agent, target } = options;
  const excludeClaimIds = new Set(options.excludeClaimIds ?? []);

  return {
    specificationVersion: 'v3',
    transformParams: async ({ params }) => {
      if (!agent || !target) return params;

      // Look up peer claims on the same target. This reads the agent's reactive
      // `claims.others` array in memory, with no I/O. The type is compared
      // case-insensitively: observed claims carry a lowercased type name (such as
      // `report`) while callers write the schema's type name (`Report`).
      const wantedType = target.type.toLowerCase();
      const peerClaims = agent.claims.others.filter(
        (claim) =>
          claim.target.type.toLowerCase() === wantedType &&
          claim.target.id === target.id &&
          targetsOverlap(claim.target, target) &&
          !excludeClaimIds.has(claim.id),
      );

      if (peerClaims.length === 0) return params;

      const note = formatCoordinationNote(peerClaims, target);
      return injectSystemNote(params, note);
    },
  };
}

function hasSubtarget(target: {
  readonly path?: string;
  readonly field?: string;
  readonly range?: { readonly startLine: number; readonly endLine: number };
}): boolean {
  return Boolean(target.path || target.field || target.range);
}

function rangesOverlap(
  a: { readonly startLine: number; readonly endLine: number },
  b: { readonly startLine: number; readonly endLine: number },
): boolean {
  return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

function targetsOverlap(
  claimTarget: Claim['target'],
  target: ClaimTarget,
): boolean {
  if (!hasSubtarget(claimTarget) || !hasSubtarget(target)) return true;
  if (
    claimTarget.path &&
    target.path &&
    claimTarget.path.toLowerCase() !== target.path.toLowerCase()
  ) {
    return false;
  }
  const fieldOverlaps =
    !claimTarget.field ||
    !target.field ||
    claimTarget.field.toLowerCase() === target.field.toLowerCase();
  const rangeOverlaps =
    !claimTarget.range ||
    !target.range ||
    rangesOverlap(claimTarget.range, target.range);
  return fieldOverlaps && rangeOverlaps;
}

/**
 * Formats a one-paragraph coordination note for the model. It names who is
 * editing and, when known, what they are doing. The note stays short: the goal is
 * to make the model aware, not to flood the prompt.
 */
function formatCoordinationNote(
  claims: readonly Claim[],
  target: ClaimTarget,
): string {
  const entityLabel = target.type.toLowerCase();
  const c = claims.length === 1 ? claims[0] : undefined;
  if (c) {
    return (
      `<multiplayer_context>\n` +
      `Another participant is currently editing this ${entityLabel}. ` +
      `Declared work: ${c.description}. ` +
      `Defer to their concurrent changes when reasonable, or note your work as complementary to theirs. ` +
      `Avoid stomping their in-flight edits.\n` +
      `</multiplayer_context>`
    );
  }
  const descriptions = Array.from(
    new Set(claims.map((c) => c.description).filter(Boolean)),
  ).join('; ');
  return (
    `<multiplayer_context>\n` +
    `${claims.length} other participants are currently editing this ${entityLabel}. ` +
    (descriptions ? `Declared work: ${descriptions}. ` : '') +
    `Coordinate with their in-flight work — defer where reasonable, ` +
    `or describe your work as complementary.\n` +
    `</multiplayer_context>`
  );
}

/**
 * Append a system-role message to the prompt array. The AI SDK's
 * `LanguageModelV3Prompt` is an ordered list of messages.
 */
function injectSystemNote(
  params: { prompt: LanguageModelV3Prompt; [k: string]: unknown },
  note: string,
): typeof params {
  return {
    ...params,
    prompt: [...params.prompt, { role: 'system', content: note }],
  };
}
