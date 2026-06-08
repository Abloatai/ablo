/**
 * Optional model wrapper for entity-scoped turns.
 *
 * Tool implementations do not change. Keep tools as normal AI SDK tools; use
 * `ablo.<model>.update({ id, data, claim })` inside `execute`. This wrapper is
 * only for the surrounding model call, when the UI already knows "this turn is
 * about deck_abc" before the model chooses a tool.
 *
 * It declares one realtime claim while the model is generating and injects a
 * short note if someone else is already working on the same target.
 *
 * ```ts
 * const wrapped = wrapWithMultiplayer({
 *   model: anthropic('claude-opus-4-7'),
 *   agent,
 *   target: { entityType: 'SlideDeck', entityId: 'deck-abc' },
 *   action: 'renaming',
 *   description: 'Renaming the deck title to match the project brief.',
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
   * Peer-visible explanation of the specific work this model call is about to
   * perform. Other agents receive it in their coordination context.
   */
  readonly description?: string;
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
  const { model, agent, target, action, description, excludeIntentIds, extraMiddleware } =
    options;

  return wrapLanguageModel({
    model,
    middleware: [
      coordinationContextMiddleware({ agent, target, excludeIntentIds }),
      intentBroadcastMiddleware({ agent, target, action, description }),
      ...(extraMiddleware ?? []),
    ],
  });
}
