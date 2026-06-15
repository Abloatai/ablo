/**
 * Agent-SDK abstractions. The engine's data vocabulary
 * (`Peer`, `Activity`, `Claim`, `ActiveClaim`,
 * `PresenceUpdatePayload`, `PresenceKind`) lives in
 * `../types/streams.ts`. This file holds only the bits that are
 * specific to the agent module: the `PresenceAnnouncer` abstraction
 * (transport-agnostic announce contract) and `AgentContext` (the AI
 * SDK `experimental_context` bag).
 */

import type { Activity } from '../types/streams.js';

// ── Transport-agnostic announce contract ─────────────────────────────────

/**
 * A minimal interface for announcing presence — abstract over WebSocket
 * (`Ablo({kind: 'agent'})`) and REST (`Agent`). Both
 * implementations satisfy this, so higher-level code can depend on it
 * without caring about transport.
 */
export interface PresenceAnnouncer {
  announce(
    status: 'online' | 'away' | 'offline',
    activity?: Activity,
  ): Promise<void>;
}

// ── AgentContext ──────────────────────────────────────────────────────────

/**
 * Ambient context threaded into AI SDK tools via `experimental_context`.
 *
 * The pattern: the caller constructs an AgentContext once per agent
 * invocation and passes it as `experimental_context`. Each tool's
 * `execute` function extracts what it needs from
 * `options.experimental_context` instead of closing over module-level
 * state.
 *
 * Benefits over closure-based tool wiring:
 * - Tools are framework-agnostic module exports (portable across agents)
 * - The context is typed in one place, not scattered across closures
 * - New tools can access any field without changing tool signatures
 *
 * Ported from the vercel-labs/open-agents pattern.
 *
 * ```ts
 * import { generateText, tool } from 'ai';
 * import { Agent, type AgentContext } from '@abloatai/ablo/agent';
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
 * Consumers can extend AgentContext via module augmentation or by
 * intersecting with their own context type.
 */
export interface AgentContext {
  /** Presence / freshness / AI SDK hook primitives. Required. */
  perception: PresenceAnnouncer & {
    checkFreshness?: (
      entityType: string,
      entityId: string,
      lastSeenAt: number,
    ) => Promise<unknown>;
  };
  /** Organization scope for all operations. */
  organizationId?: string;
  /** User or agent identifier — format: "agent:<id>" for agents. */
  userId?: string;
  /** Sync groups the agent belongs to. */
  syncGroups?: string[];
  /** Allow extension with product-specific fields. */
  [key: string]: unknown;
}
