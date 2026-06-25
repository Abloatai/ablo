/**
 * Ablo + AI SDK tools.
 *
 * The base pattern is intentionally one object all the way down:
 *
 *   1. AI SDK `inputSchema` describes what the model may send.
 *   2. `ablo.<model>.update({ id, data, claim })` performs the write.
 *   3. `claim.description` tells humans and other agents what the tool is doing.
 *
 * ```ts
 * import { tool, streamText } from 'ai';
 * import { z } from 'zod';
 *
 * const renameTask = tool({
 *   description: 'Rename a task.',
 *   inputSchema: z.object({
 *     id: z.string().describe('Task id'),
 *     title: z.string().describe('New task title'),
 *     description: z
 *       .string()
 *       .describe('Why this rename is being made'),
 *   }),
 *   execute: async ({ id, title, description }) => {
 *     await ablo.tasks.update({
 *       id,
 *       data: { title },
 *       wait: 'confirmed',
 *       claim: {
 *         field: 'title',
 *         reason: 'renaming',
 *         description,
 *       },
 *     });
 *
 *     return { id, title };
 *   },
 * });
 *
 * await streamText({
 *   model,
 *   messages,
 *   tools: { renameTask },
 * });
 * ```
 *
 * That is the common case. A claim passed directly to `update` is acquired,
 * attached to the write, and released by the SDK.
 *
 * For multi-step tools, take one handle and release it when the tool is done:
 *
 * ```ts
 * const claim = await ablo.tasks.claim({
 *   id,
 *   reason: 'rewriting',
 *   description: 'Rewriting the task brief before updating follow-up fields.',
 *   ttl: '2m',
 * });
 *
 * try {
 *   await ablo.tasks.update({ id, data: { title }, claim });
 *   await ablo.tasks.update({ id, data: { description: brief }, claim });
 * } finally {
 *   await claim.release();
 * }
 * ```
 *
 * `claim.state`, `claim.queue`, and `claim.reorder` are coordination reads and
 * scheduler controls. They are useful for UI or operators, but normal AI tools
 * should start with `update({ id, data, claim })` or a manual claim handle.
 *
 * `wrapWithMultiplayer` is optional. Use it when the whole model call is scoped
 * to one entity before any tool is chosen; tool implementations stay exactly
 * the same.
 */

export {
  coordinationContextMiddleware,
  type CoordinationContextMiddlewareOptions,
  type ClaimTarget,
} from './coordination-context.js';

export { wrapWithMultiplayer, type WrapWithMultiplayerOptions } from './wrap.js';
