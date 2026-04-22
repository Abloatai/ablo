/**
 * AgentPerception — AI SDK v6 native hooks for agent awareness.
 *
 * Slots directly into generateText / streamText / ToolLoopAgent via three
 * hooks: prepareStep (inject awareness before each step), onStepFinish
 * (announce activity after each step), and guardTool (wrap mutation tools
 * with freshness checks). Stateless REST under the hood — works with any
 * API model, no WebSocket.
 *
 * ```ts
 * import { generateText, tool, stepCountIs } from 'ai';
 * import { AgentPerception } from '@ablo/sync-engine/agent';
 *
 * const perception = new AgentPerception({
 *   syncServerUrl: 'http://localhost:8080',
 *   agentId: 'researcher-1',
 *   organizationId: 'org-1',
 *   syncGroups: ['deal:abc'],
 * });
 *
 * const result = await generateText({
 *   model: 'anthropic/claude-sonnet-4.5',
 *   messages,
 *   stopWhen: stepCountIs(10),
 *   tools: {
 *     updateSlide: perception.guardTool(
 *       tool({
 *         inputSchema: z.object({ id: z.string(), title: z.string() }),
 *         execute: async ({ id, title }) => { ... },
 *       }),
 *       { entityType: 'Slide', getEntityId: (args) => args.id },
 *     ),
 *   },
 *   prepareStep: perception.prepareStep(),     // injects awareness
 *   onStepFinish: perception.onStepFinish(),   // announces activity
 * });
 * ```
 *
 * Low-level primitives (gather, checkFreshness, announce) are also exposed
 * for custom integrations outside the AI SDK.
 */

// ── Types ─────────────────────────────────────────────────────────────────

// Shared types — AgentActivity and PresenceEntry live in ./types so
// SyncAgent and AgentPerception speak the same wire format.
import type {
  AgentActivity,
  PresenceEntry,
  PresenceAnnouncer,
  AgentContext,
  IntentClaim,
} from './types';
export type { AgentActivity, PresenceEntry, AgentContext, IntentClaim } from './types';
import { AbloValidationError } from '../errors';

export interface AgentPerceptionOptions {
  /** Base URL of the sync server, e.g. `http://localhost:8080`. */
  syncServerUrl: string;
  /** Unique agent identifier — without the `agent:` prefix. */
  agentId: string;
  /** Organization this agent belongs to. */
  organizationId: string;
  /** Sync groups determine which other participants are visible. */
  syncGroups: string[];
  /** Optional bearer token for authenticated requests. */
  authToken?: string;
  /** Custom fetch — defaults to global fetch. Useful for testing. */
  fetch?: typeof fetch;
  /** Timeout per request in ms. Default 5000. */
  timeoutMs?: number;
  /**
   * Optional presence announcer — route `announce()` through this instead
   * of REST. Pass a connected SyncAgent here to reuse its WebSocket and
   * avoid per-step HTTP round trips.
   */
  announcer?: PresenceAnnouncer;
}

export interface GatherOptions {
  /** Focus context on these entities — format: "ModelName:id". */
  focusEntities?: string[];
  /** Maximum output characters for the formatted prompt. Default 2000. */
  maxChars?: number;
  /** Include presence of other participants. Default true. */
  includePresence?: boolean;
  /** Exclude this agent's own presence from the output. Default true. */
  excludeSelf?: boolean;
}

export interface PerceptionSnapshot {
  timestamp: number;
  presence: PresenceEntry[];
}

export interface GatherResult {
  /** Natural-language summary ready to inject as a system message. */
  prompt: string;
  /** Structured data for programmatic use. */
  snapshot: PerceptionSnapshot;
}

export interface FreshnessCheck {
  stale: boolean;
  reason?: 'ok' | 'not_found' | 'modified';
  /** Current entity state from the server. */
  currentState?: Record<string, unknown>;
  lastModifiedBy?: string;
  lastModifiedAt?: number;
  /** Human-readable summary — feed this back to the LLM when stale. */
  summary?: string;
  /**
   * Pending-mutation intents from OTHER participants targeting this
   * entity (self-intents filtered out). Empty = no one else is
   * currently generating against this entity. Non-empty is ADVISORY
   * — the agent can proceed, wait, or defer. Stale-read protection
   * that predates committed deltas.
   */
  pendingIntents?: IntentClaim[];
}

// ── AI SDK v6 structural types ─────────────────────────────────────────────
// Kept structural to avoid a hard dependency on the `ai` package. The real
// AI SDK types are a superset — these just enumerate the fields we touch.

/** Subset of AI SDK's ModelMessage — structural. */
export interface PerceptionMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: unknown;
}

/** Subset of AI SDK's prepareStep context. */
export interface PrepareStepContext<M extends PerceptionMessage = PerceptionMessage> {
  stepNumber: number;
  steps: ReadonlyArray<{
    toolCalls?: ReadonlyArray<{ toolName: string; input?: unknown; args?: unknown }>;
    toolResults?: ReadonlyArray<unknown>;
  }>;
  messages: M[];
  model?: unknown;
}

/** Subset of AI SDK's prepareStep return shape. */
export interface PrepareStepResult<M extends PerceptionMessage = PerceptionMessage> {
  messages?: M[];
  model?: unknown;
  toolChoice?: unknown;
  activeTools?: string[];
}

/** Subset of AI SDK's onStepFinish context. */
export interface StepFinishContext {
  stepType?: 'initial' | 'continue' | 'tool-result';
  finishReason?: string;
  text?: string;
  toolCalls?: ReadonlyArray<{ toolName: string; input?: unknown; args?: unknown }>;
  toolResults?: ReadonlyArray<unknown>;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

/** Subset of AI SDK's ToolExecutionOptions. */
export interface ToolExecutionOptions {
  toolCallId?: string;
  messages?: PerceptionMessage[];
  abortSignal?: AbortSignal;
  experimental_context?: unknown;
}

/** Minimal tool shape — a subset of AI SDK's Tool type. */
export interface ToolLike<TArgs = unknown, TResult = unknown> {
  description?: string;
  inputSchema?: unknown;
  execute?: (args: TArgs, options: ToolExecutionOptions) => Promise<TResult> | TResult;
  [extra: string]: unknown;
}

// ── Hook option types ──────────────────────────────────────────────────────

export interface PrepareStepOptions {
  /** Max characters of awareness context to inject. Default 1500. */
  maxChars?: number;
  /**
   * Derive focus entities from recent tool calls so the LLM sees participants
   * working on the same entities. Requires a mapper from tool call to entity
   * tokens (format: "ModelName:id"). Default: no auto-focus.
   */
  focusFromToolCalls?: (toolCall: {
    toolName: string;
    input?: unknown;
    args?: unknown;
  }) => string[] | undefined;
  /** Skip awareness injection for step 0 (initial prompt). Default false. */
  skipFirstStep?: boolean;
}

export interface OnStepFinishOptions {
  /**
   * Derive an activity announcement from the finished step. Return null to
   * skip announcing for this step. Default: announces the last tool name
   * if any tool was called.
   */
  activity?: (ctx: StepFinishContext) => AgentActivity | null;
}

export interface GuardToolConfig<TArgs> {
  /** Entity type the tool mutates — e.g. "Slide", "Sheet". */
  entityType: string;
  /** Extract the entity id from the tool's args. */
  getEntityId: (args: TArgs) => string | undefined;
  /**
   * Resolve the timestamp the LLM last saw this entity. If omitted or it
   * returns 0, the freshness check is skipped (no baseline to compare).
   */
  lastSeenAt?: (args: TArgs, options: ToolExecutionOptions) => number | undefined;
  /**
   * Announce that the agent is about to work on this entity before executing.
   * Default true — the agent announces `action: "editing"` automatically.
   */
  announceOnExecute?: boolean;
}

// ── AgentPerception ───────────────────────────────────────────────────────

export class AgentPerception implements PresenceAnnouncer {
  private readonly opts: Required<
    Omit<AgentPerceptionOptions, 'authToken' | 'announcer'>
  > & { authToken?: string; announcer?: PresenceAnnouncer };

  constructor(options: AgentPerceptionOptions) {
    this.opts = {
      authToken: options.authToken,
      announcer: options.announcer,
      syncServerUrl: options.syncServerUrl.replace(/\/+$/, ''),
      agentId: options.agentId,
      organizationId: options.organizationId,
      syncGroups: options.syncGroups,
      fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
      timeoutMs: options.timeoutMs ?? 5_000,
    };
  }

  /** The fully-qualified userId used on the wire: `agent:<agentId>`. */
  get userId(): string {
    return `agent:${this.opts.agentId}`;
  }

  /**
   * Extract the AgentPerception instance from an AI SDK tool's
   * `experimental_context`. Use inside tool `execute` functions to reach
   * the perception without closure-capturing it.
   *
   * ```ts
   * execute: async (args, { experimental_context }) => {
   *   const perception = AgentPerception.fromContext(experimental_context);
   *   const check = await perception.checkFreshness('Slide', args.id, lastSeenAt);
   *   // ...
   * }
   * ```
   *
   * Throws if the context is missing or doesn't contain an AgentPerception.
   * @param ctx The `experimental_context` passed to the tool.
   * @param toolName Optional tool name for error messages.
   */
  static fromContext(ctx: unknown, toolName?: string): AgentPerception {
    if (
      !ctx ||
      typeof ctx !== 'object' ||
      !('perception' in ctx) ||
      !(ctx.perception instanceof AgentPerception)
    ) {
      const where = toolName ? ` (tool: ${toolName})` : '';
      throw new AbloValidationError(
        `AgentPerception.fromContext: experimental_context must contain an AgentPerception in \`perception\`.${where} ` +
          `Set \`experimental_context: { perception } satisfies AgentContext\` when calling generateText/streamText.`,
        { code: 'agent_perception_missing_context' },
      );
    }
    return ctx.perception;
  }

  /**
   * Narrower variant of {@link fromContext} that returns `undefined` instead
   * of throwing when perception isn't in context. Useful for tools where
   * awareness is optional (e.g., read-only tools that work without it).
   */
  static tryFromContext(ctx: unknown): AgentPerception | undefined {
    if (
      !ctx ||
      typeof ctx !== 'object' ||
      !('perception' in ctx) ||
      !(ctx.perception instanceof AgentPerception)
    ) {
      return undefined;
    }
    return ctx.perception;
  }

  // ── Outbound: announce activity ──────────────────────────────────────

  /**
   * Announce this agent's presence/activity. Fire-and-forget — logs errors
   * but never throws (presence failures must not block the agent loop).
   *
   * If a `announcer` was provided (e.g. a connected SyncAgent), routes
   * through it to reuse the WebSocket. Otherwise falls back to REST POST.
   */
  async announce(
    status: 'online' | 'away' | 'offline',
    activity?: AgentActivity,
  ): Promise<void> {
    // Prefer injected announcer (WebSocket) over REST
    if (this.opts.announcer) {
      try {
        await this.opts.announcer.announce(status, activity);
      } catch (err) {
        console.warn('[perception] announcer error:', (err as Error).message);
      }
      return;
    }

    try {
      const res = await this.request('POST', '/api/presence', {
        userId: this.userId,
        organizationId: this.opts.organizationId,
        status,
        activity,
        syncGroups: this.opts.syncGroups,
      });
      if (!res.ok) {
        console.warn(
          `[perception] announce failed: ${res.status} ${res.statusText}`,
        );
      }
    } catch (err) {
      console.warn('[perception] announce error:', (err as Error).message);
    }
  }

  // ── Inbound: gather context for next LLM call ────────────────────────

  /**
   * Gather a snapshot of current activity by peers and format it as
   * natural-language context for injection into the next LLM prompt.
   */
  async gather(options?: GatherOptions): Promise<GatherResult> {
    const opts = {
      maxChars: 2000,
      includePresence: true,
      excludeSelf: true,
      ...options,
    };

    const snapshot: PerceptionSnapshot = {
      timestamp: Date.now(),
      presence: [],
    };

    if (opts.includePresence) {
      snapshot.presence = await this.fetchPresence(opts.excludeSelf);
    }

    const prompt = this.formatPrompt(snapshot, opts);
    return { prompt, snapshot };
  }

  // ── Freshness check: run before mutations ────────────────────────────

  /**
   * Check if an entity was modified since `lastSeenAt`. Use before
   * executing a mutation to detect stale state.
   *
   * Returns `{ stale: true, summary }` when the entity changed — feed
   * `summary` back to the LLM as a tool result so it can adjust its plan.
   */
  async checkFreshness(
    entityType: string,
    entityId: string,
    lastSeenAt: number,
  ): Promise<FreshnessCheck> {
    // Parallel fan-out: freshness (entity state vs lastSeenAt) + pending
    // intents (other agents about to mutate). Both are advisory — if
    // either request fails the check still returns a usable result.
    const [queryRes, pendingIntents] = await Promise.all([
      this.request('POST', '/api/sync/query', {
        organizationId: this.opts.organizationId,
        queries: [{ model: entityType, ids: [entityId] }],
      }).catch((err) => ({ ok: false, status: 0, _err: err }) as const),
      this.fetchPendingIntentsFor(entityType, entityId),
    ]);

    try {
      const res = queryRes as Response;
      if (!('ok' in res) || !res.ok) {
        return {
          stale: false,
          reason: 'ok',
          summary: `Freshness check inconclusive: ${('status' in res ? res.status : 'error')}`,
          pendingIntents,
        };
      }

      const body = (await (res as Response).json()) as {
        results: Array<Array<Record<string, unknown>> | null>;
      };
      const rows = body.results?.[0];

      if (!rows || rows.length === 0) {
        return {
          stale: true,
          reason: 'not_found',
          summary: `${entityType} ${entityId} no longer exists. Another actor may have deleted it.`,
          pendingIntents,
        };
      }

      const entity = rows[0];
      const updatedAtRaw = entity.updated_at ?? entity.updatedAt;
      const lastModifiedBy =
        (entity.updated_by as string | undefined) ??
        (entity.updatedBy as string | undefined) ??
        (entity.created_by as string | undefined);

      const lastModifiedAt =
        typeof updatedAtRaw === 'string'
          ? Date.parse(updatedAtRaw)
          : typeof updatedAtRaw === 'number'
            ? updatedAtRaw
            : undefined;

      if (lastModifiedAt !== undefined && lastModifiedAt > lastSeenAt) {
        const ago = Math.round((Date.now() - lastModifiedAt) / 1000);
        return {
          stale: true,
          reason: 'modified',
          currentState: entity,
          lastModifiedBy,
          lastModifiedAt,
          summary:
            `${entityType} ${entityId} was modified by ${lastModifiedBy ?? 'another actor'} ` +
            `${ago}s ago. Your planned change is based on stale state. ` +
            `Re-read the entity and adjust your approach.`,
          pendingIntents,
        };
      }

      return {
        stale: false,
        reason: 'ok',
        currentState: entity,
        lastModifiedBy,
        lastModifiedAt,
        pendingIntents,
      };
    } catch (err) {
      // Freshness check is advisory — on error, assume ok and let the
      // mutation proceed. Better than blocking the agent on a flaky query.
      return {
        stale: false,
        reason: 'ok',
        summary: `Freshness check error: ${(err as Error).message}`,
        pendingIntents,
      };
    }
  }

  /**
   * Pull the org's presence, filter to intents targeting the given
   * entity (self-intents excluded). Advisory — returns empty on any
   * error so `checkFreshness` stays usable when the presence endpoint
   * is down. Case-insensitive match on entityType + entityId to absorb
   * PascalCase / lowercase divergence.
   */
  private async fetchPendingIntentsFor(
    entityType: string,
    entityId: string,
  ): Promise<IntentClaim[]> {
    const etLower = entityType.toLowerCase();
    const idLower = entityId.toLowerCase();
    const entries = await this.fetchPresence(true);
    const result: IntentClaim[] = [];
    for (const entry of entries) {
      if (!entry.activeIntents) continue;
      for (const intent of entry.activeIntents) {
        if (
          intent.entityType.toLowerCase() === etLower &&
          intent.entityId.toLowerCase() === idLower
        ) {
          result.push(intent);
        }
      }
    }
    return result;
  }

  // ── AI SDK hooks ─────────────────────────────────────────────────────

  /**
   * Build a `prepareStep` hook for AI SDK's generateText / streamText /
   * ToolLoopAgent. Called before each step — injects a system message
   * summarizing what other agents are doing right now.
   *
   * ```ts
   * const result = await generateText({
   *   // ...
   *   prepareStep: perception.prepareStep({ maxChars: 1500 }),
   * });
   * ```
   */
  prepareStep<M extends PerceptionMessage = PerceptionMessage>(
    options?: PrepareStepOptions,
  ): (ctx: PrepareStepContext<M>) => Promise<PrepareStepResult<M> | undefined> {
    const maxChars = options?.maxChars ?? 1500;
    const focusFromToolCalls = options?.focusFromToolCalls;
    const skipFirstStep = options?.skipFirstStep ?? false;

    return async ({ stepNumber, steps, messages }) => {
      if (skipFirstStep && stepNumber === 0) return undefined;

      // Derive focus entities from recent tool calls if configured
      let focusEntities: string[] | undefined;
      if (focusFromToolCalls && steps.length > 0) {
        const focus = new Set<string>();
        for (const step of steps) {
          for (const call of step.toolCalls ?? []) {
            const tokens = focusFromToolCalls(call);
            if (tokens) tokens.forEach((t) => focus.add(t));
          }
        }
        if (focus.size > 0) focusEntities = [...focus];
      }

      const { prompt } = await this.gather({ maxChars, focusEntities });
      const awareness: PerceptionMessage = { role: 'system', content: prompt };

      return {
        messages: [...messages, awareness as M],
      };
    };
  }

  /**
   * Build an `onStepFinish` hook for AI SDK. Called after each step —
   * announces the agent's activity based on the tool calls that just ran.
   *
   * ```ts
   * const result = await generateText({
   *   // ...
   *   onStepFinish: perception.onStepFinish(),
   * });
   * ```
   */
  onStepFinish(
    options?: OnStepFinishOptions,
  ): (ctx: StepFinishContext) => Promise<void> {
    const resolveActivity =
      options?.activity ??
      ((ctx: StepFinishContext): AgentActivity | null => {
        const lastCall = ctx.toolCalls?.[ctx.toolCalls.length - 1];
        if (!lastCall) return null;
        return {
          entityType: 'Tool',
          entityId: lastCall.toolName,
          action: 'executed',
          detail: lastCall.toolName,
        };
      });

    return async (ctx) => {
      const activity = resolveActivity(ctx);
      if (activity) {
        await this.announce('online', activity);
      }
    };
  }

  /**
   * Wrap an AI SDK tool to check entity freshness before executing. If the
   * entity was modified by another actor since the LLM last saw it, returns
   * a diff summary as the tool result instead of executing — the LLM adjusts
   * its plan rather than blindly overwriting.
   *
   * ```ts
   * tools: {
   *   updateSlide: perception.guardTool(
   *     tool({ inputSchema: ..., execute: ... }),
   *     { entityType: 'Slide', getEntityId: (args) => args.id },
   *   ),
   * }
   * ```
   */
  guardTool<TArgs, TResult, TTool extends ToolLike<TArgs, TResult>>(
    originalTool: TTool,
    config: GuardToolConfig<TArgs>,
  ): TTool {
    const originalExecute = originalTool.execute;
    if (!originalExecute) return originalTool;

    const self = this;
    const announceOnExecute = config.announceOnExecute ?? true;

    const wrappedExecute = async (
      args: TArgs,
      opts: ToolExecutionOptions,
    ): Promise<TResult | string> => {
      const entityId = config.getEntityId(args);

      // No id → nothing to guard, just execute
      if (!entityId) {
        return originalExecute(args, opts);
      }

      // Freshness check (skipped when no baseline timestamp is provided)
      const lastSeen = config.lastSeenAt?.(args, opts);
      if (lastSeen !== undefined && lastSeen > 0) {
        const check = await self.checkFreshness(
          config.entityType,
          entityId,
          lastSeen,
        );
        if (check.stale && check.summary) {
          return check.summary;
        }
      }

      // Announce activity before executing (fire-and-forget)
      if (announceOnExecute) {
        void self.announce('online', {
          entityType: config.entityType,
          entityId,
          action: 'editing',
        });
      }

      return originalExecute(args, opts);
    };

    return {
      ...originalTool,
      execute: wrappedExecute,
    } as TTool;
  }

  // ── Internal ─────────────────────────────────────────────────────────

  private async fetchPresence(excludeSelf: boolean): Promise<PresenceEntry[]> {
    try {
      const url =
        `/api/presence?orgId=${encodeURIComponent(this.opts.organizationId)}`;
      const res = await this.request('GET', url);
      if (!res.ok) return [];

      const body = (await res.json()) as { entries: PresenceEntry[] };
      const entries = body.entries ?? [];

      // Filter by overlapping sync groups (presence API returns all org
      // entries — the SDK narrows to our scope)
      const ours = new Set(this.opts.syncGroups);
      return entries.filter((e) => {
        if (excludeSelf && e.userId === this.userId) return false;
        return (e.syncGroups ?? []).some((g) => ours.has(g));
      });
    } catch {
      return [];
    }
  }

  private formatPrompt(
    snapshot: PerceptionSnapshot,
    opts: GatherOptions & { maxChars: number; includePresence: boolean; excludeSelf: boolean },
  ): string {
    const lines: string[] = [];
    const now = new Date(snapshot.timestamp).toISOString();
    lines.push(`[Team context as of ${now}]`);

    const focus = new Set(opts.focusEntities ?? []);
    const hasFocus = focus.size > 0;

    // Sort: focused entities first, then agents, then humans
    const relevant = hasFocus
      ? snapshot.presence.filter((e) =>
          e.activity && focus.has(`${e.activity.entityType}:${e.activity.entityId}`),
        )
      : snapshot.presence;

    if (relevant.length === 0) {
      lines.push('No other participants active in your scope.');
    } else {
      lines.push(
        hasFocus
          ? `Participants working on focused entities (${opts.focusEntities!.join(', ')}):`
          : `Active participants:`,
      );

      for (const entry of relevant) {
        const role = entry.isAgent ? 'agent' : 'human';
        const base = `- ${role} ${entry.userId} [${entry.status}]`;
        if (entry.activity) {
          const act = entry.activity;
          const detail = act.detail ? ` (${act.detail})` : '';
          lines.push(
            `${base}: ${act.action} ${act.entityType}:${act.entityId}${detail}`,
          );
        } else {
          lines.push(base);
        }
      }

      if (hasFocus && relevant.length < snapshot.presence.length) {
        const others = snapshot.presence.length - relevant.length;
        lines.push(`(${others} other participant${others === 1 ? '' : 's'} active on unrelated entities)`);
      }
    }

    let result = lines.join('\n');
    if (result.length > opts.maxChars) {
      result = result.slice(0, opts.maxChars - 3) + '...';
    }
    return result;
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const url = `${this.opts.syncServerUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.opts.authToken) {
      headers.Authorization = `Bearer ${this.opts.authToken}`;
    }

    return this.opts.fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
  }
}
