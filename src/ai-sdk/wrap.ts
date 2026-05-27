/**
 * Convenience composition for the common case — wraps a language
 * model with both multiplayer middlewares (intent broadcast +
 * coordination context) in the right order.
 *
 * Consumers who want full control over middleware composition (add
 * caching / observability / their own custom middleware) should use
 * the factories directly: `intentBroadcastMiddleware`,
 * `coordinationContextMiddleware`. This helper is the one-liner for
 * the 90% case.
 *
 * Stays explicit about its scope — wraps the MODEL only. Consumer
 * keeps full control over their `streamText` / `generateText` call
 * (messages, tools, system prompt, provider options, onFinish, etc.).
 *
 * ```ts
 * const wrapped = wrapWithMultiplayer({
 *   model: anthropic('claude-opus-4-7'),
 *   agent,
 *   target: { entityType: 'SlideDeck', entityId: 'deck-abc' },
 * });
 *
 * const result = streamText({
 *   model: wrapped,
 *   messages: myMessages,
 *   tools: myTools,
 *   system: mySystem,
 *   // ... anything else the consumer's app needs
 * });
 * ```
 */

import { wrapLanguageModel } from 'ai';
import type {
  LanguageModelV3,
  LanguageModelV3Middleware,
} from '@ai-sdk/provider';
import type { Ablo } from '../client/Ablo.js';
import type { SchemaRecord } from '../schema/schema.js';
import {
  intentBroadcastMiddleware,
  type IntentTarget,
} from './intent-broadcast.js';
import { coordinationContextMiddleware } from './coordination-context.js';

export interface WrapWithMultiplayerOptions {
  /** The base language model to wrap. Consumer brings their own. */
  readonly model: LanguageModelV3;
  /** Connected SyncAgent. Null = pass-through wrap (no broadcast, no read). */
  readonly agent: Ablo<SchemaRecord> | null;
  /** Target entity. Null = pass-through wrap. */
  readonly target: IntentTarget | null;
  /**
   * Optional action verb for the broadcast. Default `'edit'`.
   * Convention: `'edit'`, `'read'`, `'review'`, `'generate'`.
   */
  readonly action?: string;
  /**
   * Optional intentIds to exclude from the coordination-context
   * read — typically the caller's own claim if they're composing
   * multiple wrappings. Most consumers leave this empty.
   */
  readonly excludeIntentIds?: readonly string[];
  /**
   * Optional extra middleware to compose. Runs in the order given,
   * INSIDE the multiplayer middlewares (so the multiplayer wrap is
   * the outer-most). Useful for caching, observability, custom
   * transforms that should not affect the multiplayer signal.
   *
   * For full control over ordering, skip this helper and call
   * `wrapLanguageModel` directly with all middleware in the order
   * you want.
   */
  readonly extraMiddleware?: readonly LanguageModelV3Middleware[];
}

export function wrapWithMultiplayer(
  options: WrapWithMultiplayerOptions,
): ReturnType<typeof wrapLanguageModel> {
  const { model, agent, target, action, excludeIntentIds, extraMiddleware } =
    options;

  return wrapLanguageModel({
    model,
    middleware: [
      coordinationContextMiddleware({ agent, target, excludeIntentIds }),
      intentBroadcastMiddleware({ agent, target, action }),
      ...(extraMiddleware ?? []),
    ],
  });
}
