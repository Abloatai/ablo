/**
 * @abloatai/ablo/agent — Agent SDK helpers
 *
 * Two entry points depending on agent lifetime:
 *
 * ─────────────────────────────────────────────────────────────────────────
 * LONG-LIVED AGENT (browser, daemon, persistent Node process)
 * ─────────────────────────────────────────────────────────────────────────
 * Use the unified `Ablo({...})` factory directly with `kind: 'agent'`.
 * The factory holds the WebSocket, reactive subscriptions, mutations, and
 * presence/intents — same surface as a browser user, just with a
 * server-issued capability token instead of session cookies.
 *
 * ```ts
 * import Ablo from '@abloatai/ablo';
 *
 * const ablo = Ablo({
 *   schema,
 *   url: 'wss://api.example.com',
 *   organizationId,
 *   kind: 'agent',
 *   agentId: 'reviewer-bot',
 *   capabilityToken: mintedToken,
 *   syncGroups: [`org:${organizationId}`],
 *   inMemory: true,  // Node has no IndexedDB
 * });
 *
 * await ablo.ready();
 * for (const task of ablo.tasks.list({ where: { status: 'pending_review' } })) {
 *   await ablo.tasks.update(task.id, { status: 'reviewed' });
 * }
 * ```
 *
 * For server-side caching across requests, use {@link Agent.session}
 * — it caches one engine per identity and refreshes capability tokens
 * before expiry.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SHORT-LIVED AGENT (SQS consumer, serverless, API route)
 * ─────────────────────────────────────────────────────────────────────────
 * Use {@link Agent}. Stateless REST hooks that slot directly into
 * the Vercel AI SDK's `generateText` / `streamText`. No WebSocket. Ideal
 * for agent-worker jobs that process one task and exit.
 *
 * ```ts
 * import { generateText, tool, stepCountIs } from 'ai';
 * import { Agent } from '@abloatai/ablo/agent';
 *
 * const perception = new Agent({
 *   syncServerUrl: 'http://localhost:8080',
 *   agentId: job.id,
 *   organizationId: job.organizationId,
 *   syncGroups: [`org:${job.organizationId}`],
 * });
 *
 * await generateText({
 *   model: 'anthropic/claude-sonnet-4.5',
 *   messages,
 *   stopWhen: stepCountIs(10),
 *   tools: {
 *     updateSlide: perception.wrapTool(tool({ ... }), {
 *       entityType: 'Slide',
 *       getEntityId: (args) => args.id,
 *     }),
 *   },
 *   prepareStep: perception.prepareStep(),
 *   onStepFinish: perception.onStepFinish(),
 * });
 * ```
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IDIOMATIC TOOL PATTERN (ported from vercel-labs/open-agents)
 * ─────────────────────────────────────────────────────────────────────────
 * Tools are factory functions that pull ambient state from
 * `experimental_context`. The caller builds an {@link AgentContext} once
 * and passes it to `generateText`; every tool reaches in.
 *
 * ```ts
 * import { tool } from 'ai';
 * import { z } from 'zod';
 * import { Agent, type AgentContext } from '@abloatai/ablo/agent';
 *
 * export const updateSlideTool = () => tool({
 *   description: 'Update a slide title',
 *   inputSchema: z.object({ id: z.string(), title: z.string() }),
 *   execute: async (args, { experimental_context }) => {
 *     const perception = Agent.fromContext(experimental_context, 'updateSlide');
 *     const check = await perception.checkFreshness('Slide', args.id, Date.now() - 5000);
 *     if (check.stale) return check.summary;
 *     return { ok: true };
 *   },
 * });
 * ```
 *
 * ─────────────────────────────────────────────────────────────────────────
 * COMPOSED (long-lived `Ablo({kind:'agent'})` + Agent together)
 * ─────────────────────────────────────────────────────────────────────────
 * If you have a long-lived `Ablo` instance AND want AI SDK hooks, pass it
 * as the `announcer` to Agent — presence announcements route
 * through the existing WebSocket instead of opening new HTTP calls.
 *
 * ```ts
 * const ablo = Ablo({ kind: 'agent', schema, capabilityToken, ... });
 * await ablo.ready();
 *
 * const perception = new Agent({
 *   ...sharedConfig,
 *   announcer: ablo,  // reuse the WebSocket
 * });
 * ```
 *
 * Both `Ablo` and `Agent` implement the
 * {@link PresenceAnnouncer} interface.
 */

// ── The entire `/agent` surface — one symbol ────────────────────────────
//
// `Agent` is the class AND the namespace for its types. Reach for
// options, context, and session options via dot access:
//
//   import { Agent } from '@abloatai/ablo/agent';
//   const opts: Agent.Options = { ... };
//   const ctx:  Agent.Context = { perception };
//   const s:    Agent.SessionOptions = { ... };
//
// Everything else (Activity, Claim, Turn, Peer, ActiveIntent, ...)
// lives on the `Ablo.*` namespace via
// `import type { Ablo } from '@abloatai/ablo'`.

export { Agent } from './Agent.js';
