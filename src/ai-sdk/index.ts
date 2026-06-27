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
 *
 * ## Multi-agent coordination — the canonical way
 *
 * When several agents (or agents + humans) write the SAME row concurrently, the
 * outcome is decided by **(write path) × (the model's conflict policy)**, NOT by
 * how smart the model is. The same model silently loses 3 of 4 concurrent
 * contributions through a blind whole-row write, and lands all 4 through a
 * coordinated one — because the coordinated write returns a *signal* the model
 * (or the runtime) acts on. Two empirical laws fall out:
 *
 *   1. **Surface the signal.** A write that swallows the conflict and reports
 *      success is the footgun. Every robust path returns a legible result
 *      (`reject` → re-read & retry; `claimed` → the model tries again) instead of
 *      clobbering. Reaching for a bigger model does not fix a silent write.
 *   2. **Back off.** Under N-way contention, writers that retry in lock-step just
 *      re-collide. The shared reconcile loop already jitters its backoff; any
 *      hand-rolled retry must too, or it exhausts its budget and drops a writer.
 *
 * `coordinatedTool` (below) encodes both. Prefer it over a hand-written tool for
 * "save the agent's contribution into the shared row":
 *
 * ```ts
 * import { coordinatedTool } from '@abloatai/ablo/ai-sdk';
 * const saveSection = coordinatedTool(ablo.documents, {
 *   description: 'Save your section into the shared document.',
 *   inputSchema: z.object({ text: z.string() }),
 *   id: () => DOC_ID,
 *   apply: (current, { text }) => ({ content: appendBlock(current.content, text) }),
 *   strategy: 'merge', // 'merge' (default, self-healing) | 'claim' | 'queue'
 * });
 * ```
 *
 * | strategy | writers relate by | on contention | model conflict policy |
 * |----------|-------------------|---------------|------------------------|
 * | `merge`  | accumulate (CAS)  | re-read + re-apply (silent, backed off) | must be `reject` (default) |
 * | `claim`  | mutual exclusion  | returns `{status:'claimed'}` → model retries | any |
 * | `queue`  | FIFO-ish (SQS)    | poll-acquire until granted / timeout | any |
 *
 * Note: a model declaring `agentsNotify()` HOLDS a losing write instead of
 * rejecting it, which defeats `merge`'s reconcile (the loser is dropped, not
 * retried). Use `agentsReject()` for accumulate semantics, or `claim`/`queue`.
 */

export {
  coordinationContextMiddleware,
  type CoordinationContextMiddlewareOptions,
  type ClaimTarget,
} from './coordination-context.js';

export { wrapWithMultiplayer, type WrapWithMultiplayerOptions } from './wrap.js';

export {
  coordinatedTool,
  type CoordinationStrategy,
  type CoordinatedToolOptions,
  type CoordinatedWriteResult,
} from './coordinated-tool.js';
