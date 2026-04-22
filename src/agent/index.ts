/**
 * @ablo/sync-engine/agent — AI Agent SDK
 *
 * Two entry points depending on how long your agent lives:
 *
 * ─────────────────────────────────────────────────────────────────────────
 * LONG-LIVED AGENT (browser, daemon, persistent Node process)
 * ─────────────────────────────────────────────────────────────────────────
 * Use {@link SyncAgent}. Holds a WebSocket connection, reactive subscriptions
 * via `.watch()`, real-time delta handlers via `.on()`, mutations via
 * batchAck. Lowest latency — presence and deltas flow in real-time.
 *
 * ```ts
 * import { SyncAgent } from '@ablo/sync-engine/agent';
 *
 * const agent = new SyncAgent({
 *   url: 'wss://api.example.com',
 *   token: process.env.AGENT_TOKEN,
 *   agentId: 'reviewer-bot',
 *   syncGroups: ['org:acme'],
 * });
 *
 * agent.on('tasks', { where: { status: 'pending_review' } }, async (task) => {
 *   await agent.update('tasks', task.id, { status: 'reviewed' });
 * });
 *
 * await agent.connect();
 * ```
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SHORT-LIVED AGENT (SQS consumer, serverless, API route)
 * ─────────────────────────────────────────────────────────────────────────
 * Use {@link AgentPerception}. Stateless REST hooks that slot directly into
 * AI SDK v6's `generateText` / `streamText` / `ToolLoopAgent`. No WebSocket.
 * Ideal for agent-worker jobs that process one task and exit.
 *
 * ```ts
 * import { generateText, tool, stepCountIs } from 'ai';
 * import { AgentPerception } from '@ablo/sync-engine/agent';
 *
 * const perception = new AgentPerception({
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
 *     updateSlide: perception.guardTool(tool({ ... }), {
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
 * import { AgentPerception, type AgentContext } from '@ablo/sync-engine/agent';
 *
 * // Factory — tools are functions returning a Tool
 * export const updateSlideTool = () => tool({
 *   description: 'Update a slide title',
 *   inputSchema: z.object({ id: z.string(), title: z.string() }),
 *   execute: async (args, { experimental_context }) => {
 *     const perception = AgentPerception.fromContext(experimental_context, 'updateSlide');
 *     const check = await perception.checkFreshness('Slide', args.id, Date.now() - 5000);
 *     if (check.stale) return check.summary;
 *     // ... actual mutation
 *     return { ok: true };
 *   },
 * });
 *
 * // Caller wires context once
 * await generateText({
 *   model,
 *   tools: { updateSlide: updateSlideTool() },
 *   experimental_context: { perception, organizationId } satisfies AgentContext,
 *   prepareStep: perception.prepareStep(),
 *   onStepFinish: perception.onStepFinish(),
 * });
 * ```
 *
 * Why factories? Tools become portable — they can be shipped as module
 * exports and reused across agents without closure-capturing per-call state.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * COMPOSED (long-lived agent that also uses AI SDK)
 * ─────────────────────────────────────────────────────────────────────────
 * Have a SyncAgent AND want the AI SDK hooks? Inject the SyncAgent as the
 * `announcer` — presence announcements route through the WebSocket instead
 * of spawning new HTTP calls every step.
 *
 * ```ts
 * const agent = new SyncAgent({ ... });
 * await agent.connect();
 *
 * const perception = new AgentPerception({
 *   ...sharedConfig,
 *   announcer: agent,  // reuse the WebSocket
 * });
 * ```
 *
 * Both classes implement the {@link PresenceAnnouncer} interface, so any
 * caller that only needs `announce(status, activity)` can accept either.
 */

// ── Shared types (used by both SyncAgent and AgentPerception) ────────────

export type {
  AgentActivity,
  PresenceEntry,
  PresenceUpdatePayload,
  PresenceAnnouncer,
  AgentContext,
} from './types';

// ── Long-lived: WebSocket-based agent ────────────────────────────────────

export {
  SyncAgent,
  type SyncAgentOptions,
  type AgentDelta,
  type EntityFilter,
  type DeltaHandler,
  type IntentHandle,
  type MutationOptions,
} from './SyncAgent';

// ── Reactive views (used by SyncAgent; also usable standalone) ───────────

export {
  AgentQueryView,
  type AgentQueryViewOptions,
} from './AgentQueryView';

export { AgentViewRegistry } from './AgentViewRegistry';

// ── Short-lived: REST-based hooks for AI SDK ─────────────────────────────

export {
  AgentPerception,
  type AgentPerceptionOptions,
  type GatherOptions,
  type GatherResult,
  type PerceptionSnapshot,
  type FreshnessCheck,
  type PrepareStepOptions,
  type OnStepFinishOptions,
  type GuardToolConfig,
  type PerceptionMessage,
  type PrepareStepContext,
  type PrepareStepResult,
  type StepFinishContext,
  type ToolExecutionOptions,
  type ToolLike,
} from './AgentPerception';
