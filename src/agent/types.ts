/**
 * Shared types for the agent SDK — used by both SyncAgent (WebSocket,
 * long-lived) and AgentPerception (REST, short-lived). Keeping these in
 * one place means the two classes speak exactly the same wire format.
 */

// ── Activity ──────────────────────────────────────────────────────────────

/** What an agent is actively working on right now. */
export interface AgentActivity {
  /** Entity type: "Slide", "Sheet", "Document", "AgentJob", etc. */
  entityType: string;
  /** ID of the entity being worked on. */
  entityId: string;
  /** What the agent is doing. */
  action: 'editing' | 'reviewing' | 'generating' | 'analyzing' | 'executing' | (string & {});
  /** Human-readable detail: "slide 3", "cell A1:B5". */
  detail?: string;
}

// ── Presence ──────────────────────────────────────────────────────────────

/**
 * A pending-mutation intent — declared by an agent BEFORE it starts
 * LLM generation, cleared on commit / abandon / disconnect / TTL. Other
 * agents observing the same entity read `activeIntents` to decide
 * whether to defer, wait, or proceed with "know it's about to change"
 * awareness. Matches the server-side `IntentClaim` in
 * `apps/sync-server/src/presence/PresenceStore.ts`.
 */
export interface IntentClaim {
  intentId: string;
  entityType: string;
  entityId: string;
  action: string;
  field?: string;
  declaredAt: number;
  expiresAt: number;
}

/**
 * Transition type carried on every presence frame from the server.
 * Clients reduce state with an explicit switch instead of diffing the
 * previous-vs-current map.
 *
 *   - `'enter'`  — first frame the receiver sees for this peer
 *                  (fresh connect or roster snapshot).
 *   - `'update'` — activity / intent change on an already-known peer.
 *   - `'leave'`  — peer departed (explicit disconnect or TTL expiry).
 */
export type PresenceKind = 'enter' | 'update' | 'leave';

/** Presence entry as returned by the sync server. */
export interface PresenceEntry {
  /** Transition kind — server-stamped, required. */
  kind: PresenceKind;
  userId: string;
  organizationId?: string;
  status: 'online' | 'away' | 'offline' | (string & {});
  activity?: AgentActivity;
  syncGroups?: string[];
  updatedAt?: number;
  isAgent?: boolean;
  /** Unix timestamp when the server stamped the presence broadcast. */
  timestamp?: number;
  /** Pending-mutation intents this participant has declared. */
  activeIntents?: IntentClaim[];
}

// ── Transport helpers ─────────────────────────────────────────────────────

/** Presence wire payload — what goes over the transport. */
export interface PresenceUpdatePayload {
  status: 'online' | 'away' | 'offline' | (string & {});
  activity?: AgentActivity;
  isAgent?: boolean;
}

/**
 * A minimal interface for announcing presence — abstract over WebSocket
 * (SyncAgent) and REST (AgentPerception). Both implementations satisfy
 * this, so higher-level code can depend on it without caring about transport.
 */
export interface PresenceAnnouncer {
  announce(
    status: 'online' | 'away' | 'offline',
    activity?: AgentActivity,
  ): Promise<void>;
}

// ── AgentContext ──────────────────────────────────────────────────────────

/**
 * Ambient context threaded into AI SDK tools via `experimental_context`.
 *
 * The pattern: the caller constructs an AgentContext once per agent
 * invocation and passes it as `experimental_context`. Each tool's `execute`
 * function extracts what it needs from `options.experimental_context`
 * instead of closing over module-level state.
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
 * import { AgentPerception, type AgentContext } from '@ablo/sync-engine/agent';
 *
 * const updateSlideTool = () => tool({
 *   inputSchema: z.object({ id: z.string(), title: z.string() }),
 *   execute: async (args, { experimental_context }) => {
 *     const perception = AgentPerception.fromContext(experimental_context);
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
