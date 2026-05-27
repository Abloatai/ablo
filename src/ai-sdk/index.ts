/**
 * `@abloatai/ablo/ai-sdk` — multiplayer-with-AI as language model
 * middleware.
 *
 * Two cross-cutting middlewares for any AI SDK consumer using
 * `streamText` / `generateText`:
 *
 *   - `intentBroadcastMiddleware` — agent declares what it's about
 *     to mutate via `intent_begin`, abandons the claim at stream end.
 *     Peers see the broadcast in their presence stream's
 *     `activeIntents` field and can defer / yield / surface
 *     "agent is editing this entity right now."
 *
 *   - `coordinationContextMiddleware` — reads peer intents from local
 *     presence cache before the LLM call, injects a
 *     `<multiplayer_context>` system note when peers are editing
 *     the same entity. The AI gets coordination awareness without
 *     extra round-trips.
 *
 * Compose them with the AI SDK's `wrapLanguageModel`:
 *
 * ```ts
 * import { wrapLanguageModel, streamText } from 'ai';
 * import {
 *   intentBroadcastMiddleware,
 *   coordinationContextMiddleware,
 * } from '@abloatai/ablo/ai-sdk';
 *
 * const target = { entityType: 'SlideDeck', entityId: 'deck-abc' };
 *
 * const wrappedModel = wrapLanguageModel({
 *   model: anthropic('claude-opus-4-7'),
 *   middleware: [
 *     coordinationContextMiddleware({ agent, target }),
 *     intentBroadcastMiddleware({ agent, target }),
 *   ],
 * });
 *
 * // Consumer keeps full control over messages, tools, system prompt:
 * const result = streamText({
 *   model: wrappedModel,
 *   messages: [...],
 *   tools: { ... },
 *   system: '...',
 * });
 * ```
 *
 * Or use the convenience composition for the common case:
 *
 * ```ts
 * import { wrapWithMultiplayer } from '@abloatai/ablo/ai-sdk';
 *
 * const wrappedModel = wrapWithMultiplayer({
 *   model: anthropic('claude-opus-4-7'),
 *   agent,
 *   target: { entityType: 'SlideDeck', entityId: 'deck-abc' },
 * });
 * ```
 *
 * Order matters: `coordinationContextMiddleware`'s `transformParams`
 * runs at param-transform time (before the model call), reading peer
 * intents *before* this agent's broadcast lands in its own cache.
 * `intentBroadcastMiddleware`'s `wrapStream` runs around the actual
 * call. Self-claim doesn't pollute the peer-intent read.
 */

export {
  intentBroadcastMiddleware,
  type IntentTarget,
  type IntentBroadcastMiddlewareOptions,
} from './intent-broadcast.js';

export {
  coordinationContextMiddleware,
  type CoordinationContextMiddlewareOptions,
} from './coordination-context.js';

export { wrapWithMultiplayer, type WrapWithMultiplayerOptions } from './wrap.js';
