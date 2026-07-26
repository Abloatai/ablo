/**
 * Types specific to running AI agents. The shared data vocabulary — `Peer`,
 * {@link Activity}, `Claim`, `ActiveClaim`, `PresenceUpdatePayload`, and
 * `PresenceKind` — lives in the streams module. This file adds only the two
 * pieces the agent layer needs on top of it: {@link PresenceAnnouncer}, a
 * transport-agnostic way to announce presence, and {@link AgentContext}, the bag
 * of ambient state passed to AI SDK tools.
 */

import type { Activity } from '@abloatai/transaction/types/streams';

// ── Transport-agnostic announce contract ─────────────────────────────────

/**
 * A minimal interface for announcing an agent's presence, independent of how it
 * connects. Human-facing WebSocket clients implement it; headless transaction
 * clients may omit it because activity presence is not a write-safety primitive.
 */
export interface PresenceAnnouncer {
  announce(
    status: 'online' | 'away' | 'offline',
    activity?: Activity,
  ): Promise<void>;
}

// ── AgentContext ──────────────────────────────────────────────────────────

/**
 * The ambient state passed to AI SDK tools through the AI SDK's
 * `experimental_context`. Build one {@link AgentContext} per agent invocation and
 * pass it as `experimental_context`; each tool's `execute` function then reads
 * what it needs from `options.experimental_context` rather than closing over
 * shared module state.
 *
 * Passing context this way, rather than capturing it in each tool's closure,
 * keeps tools as plain module exports that any agent can reuse, types the context
 * in one place, and lets a new tool read any field without changing its
 * signature.
 *
 * ```ts
 * import { generateText, tool } from 'ai';
 * import { Agent, type AgentContext } from '@ablo/agent/perception';
 *
 * const updateSlideTool = () => tool({
 *   inputSchema: z.object({ id: z.string(), title: z.string() }),
 *   execute: async (args, { experimental_context }) => {
 *     const perception = Agent.fromContext(experimental_context);
 *     const check = await perception.checkFreshness('Slide', args.id, Date.now() - 5000);
 *     if (check.stale) return check.summary;
 *     // ... actual mutation
 *   },
 * });
 *
 * await generateText({
 *   model: 'anthropic/claude-sonnet-4.5',
 *   tools: { updateSlide: updateSlideTool() },
 *   experimental_context: { perception, organizationId, userId } satisfies AgentContext,
 * });
 * ```
 *
 * Extend {@link AgentContext} with your own fields through module augmentation or
 * by intersecting it with your own context type.
 */
export interface AgentContext {
  /** Announces presence and checks whether an entity has changed since a given time. Required. */
  perception: PresenceAnnouncer & {
    checkFreshness?: (
      entityType: string,
      entityId: string,
      lastSeenAt: number,
    ) => Promise<{
      readonly stale: boolean;
      readonly reason: 'ok' | 'not_found' | 'modified';
    }>;
  };
  /** The organization every operation is scoped to. */
  organizationId?: string;
  /** Identifier for the user or agent. Agents use the form `agent:<id>`. */
  userId?: string;
  /** The sync groups this agent belongs to. */
  syncGroups?: string[];
  /** Room for your own product-specific fields. */
  [key: string]: unknown;
}
