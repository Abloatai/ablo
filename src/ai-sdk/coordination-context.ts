/**
 * Coordination context middleware — reads peer intents on the same
 * entity from the sync engine's presence stream and injects a brief
 * coordination note into the prompt before the LLM call.
 *
 * The complement of `intent-broadcast.ts`: that one declares what
 * THIS agent is about to do; this one reads what OTHERS are doing
 * and tells the LLM about it. Together they make multiplayer-with-
 * AI structurally real — the AI knows when a human or another
 * agent is mid-edit and can defer / phrase its work as
 * "while you finish that, I'll …" / suggest waiting / coordinate
 * explicitly.
 *
 * Open-source-clean: depends only on `@ai-sdk/provider` types and
 * the package's own `SyncAgent`. Consumers compose via the AI
 * SDK's `wrapLanguageModel`.
 *
 * Cost: zero extra LLM calls (read happens locally from the agent's
 * cached presence stream — already in memory from the WS subscription).
 * Adds a few sentences to the system prompt (typically <100 tokens)
 * only when peers are actively editing.
 */

import type {
  LanguageModelV3Middleware,
  LanguageModelV3Prompt,
} from '@ai-sdk/provider';
import type { Ablo } from '../client/Ablo.js';
import type { SchemaRecord } from '../schema/schema.js';
import type { ActiveIntent } from '../types/streams.js';
import type { IntentTarget } from './intent-broadcast.js';

export interface CoordinationContextMiddlewareOptions<R extends SchemaRecord = SchemaRecord> {
  readonly agent: Ablo<R> | null;
  readonly target: IntentTarget | null;
  /**
   * Optional intentId(s) to exclude from the read — typically this
   * agent's own active claim so the coordination note doesn't tell
   * the AI "you yourself are editing this." When middleware is
   * composed with `intentBroadcastMiddleware` in the standard order,
   * `transformParams` runs BEFORE the broadcast's `wrapStream`
   * declares its claim, so the agent's own claim isn't yet in the
   * cached presence and self-filtering isn't needed. The hook is
   * here for callers that compose differently or for fleet
   * coordination (filter sibling worker intents).
   */
  readonly excludeIntentIds?: readonly string[];
}

/**
 * Build the middleware. When `agent` or `target` is null, returns a
 * pass-through.
 *
 * Generic over the schema record — see `intentBroadcastMiddleware`
 * for why `Ablo<S>` and `Ablo<SchemaRecord>` aren't structurally
 * assignable.
 */
export function coordinationContextMiddleware<R extends SchemaRecord = SchemaRecord>(
  options: CoordinationContextMiddlewareOptions<R>,
): LanguageModelV3Middleware {
  const { agent, target } = options;
  const excludeIntentIds = new Set(options.excludeIntentIds ?? []);

  return {
    specificationVersion: 'v3',
    transformParams: async ({ params }) => {
      if (!agent || !target) return params;

      // Read peer intents on the same target. Synchronous lookup
      // against the engine's reactive intents.others array — no I/O.
      const peerClaims = agent.intents.others.filter(
        (claim) =>
          claim.target.type === target.entityType &&
          claim.target.id === target.entityId &&
          targetsOverlap(claim.target, target) &&
          !excludeIntentIds.has(claim.id),
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
  claimTarget: ActiveIntent['target'],
  target: IntentTarget,
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
 * Format a one-paragraph coordination note for the LLM. Includes
 * who's editing and what (when known). Kept short — the goal is
 * "AI knows," not "AI gets a wall of text."
 */
function formatCoordinationNote(
  claims: readonly ActiveIntent[],
  target: IntentTarget,
): string {
  const entityLabel = target.entityType.toLowerCase();
  if (claims.length === 1) {
    const c = claims[0];
    return (
      `<multiplayer_context>\n` +
      `Another participant is currently editing this ${entityLabel}. ` +
      `Action declared: ${c.reason}. ` +
      `Defer to their concurrent changes when reasonable, or note your work as complementary to theirs. ` +
      `Avoid stomping their in-flight edits.\n` +
      `</multiplayer_context>`
    );
  }
  const actions = Array.from(new Set(claims.map((c) => c.reason))).join(', ');
  return (
    `<multiplayer_context>\n` +
    `${claims.length} other participants are currently editing this ${entityLabel}. ` +
    `Active actions: ${actions}. ` +
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
