/**
 * Sub-agent dispatch runtime.
 *
 * Resolves `spec.skills` and `spec.tools` against the supervisor's own
 * catalogs, builds the sub-agent system prompt, hands off to a
 * caller-supplied `SubAgentDispatcher` that actually runs the LLM turn,
 * and returns a `SubAgentResult`.
 *
 * The package stays AI-SDK-free — the consumer (apps/web execute-code
 * route) provides the dispatcher. Same separation that keeps the
 * existing tools dependency-light.
 *
 * Usage at the sandbox call site:
 *
 * ```ts
 * const runtime = createSubAgentRuntime({
 *   resolveSkills: (names) => loadSkillBodies(names),
 *   resolveTools:  (names) => pickTools(names, allTools),
 *   dispatcher:    { dispatch: async ({ systemPrompt, tools, userMessage, maxSteps }) => {
 *     const result = await streamText({ model, system: systemPrompt, tools, ... });
 *     return result.text;
 *   }},
 * });
 *
 * sandbox.agent = { run: runtime.run, send: runtime.send };
 * ```
 *
 * The auto-bootstrap in `runInIsolatedVM` exposes `agent.run` and
 * `agent.send` inside the isolate. No bridge module needed.
 */

import { buildSubAgentBasePrompt, type ResolvedSkill } from '../../catalog/prompts/sub-agent-base';
import type { SubAgentResult, SubAgentSpec } from './types';

// ── Dispatcher (caller-supplied LLM turn runner) ─────────────────────────

/**
 * Inputs the runtime hands to the dispatcher for one turn.
 *
 * `tools` is intentionally typed as `unknown` — the runtime treats it as
 * an opaque object passed through from the resolver. The caller's
 * dispatcher knows what shape its tool registry uses (typically AI SDK
 * `Tool` definitions but the package doesn't enforce this).
 */
export interface DispatchInput {
  /** Full system prompt — built by the runtime via buildSubAgentBasePrompt. */
  systemPrompt: string;
  /**
   * Tool definitions keyed by name. Same shape the consumer's streamText
   * call accepts. Can be empty.
   */
  tools: Record<string, unknown>;
  /** The supervisor's free-text brief — sent as the first user message. */
  userMessage: string;
  /** Step budget — caller should respect this in their LLM call. */
  maxSteps: number;
  /** Spec passed through for logging/tracing. */
  spec: SubAgentSpec;
}

/**
 * Caller-supplied LLM turn runner. The runtime calls `dispatch` once
 * per `agent.run` / `agent.send`. Implementations typically wrap
 * `streamText` from the AI SDK.
 *
 * Return the sub-agent's final text. Throw to signal failure — the
 * runtime catches and converts into `status: 'failed'` + error.
 */
export interface SubAgentDispatcher {
  dispatch(input: DispatchInput): Promise<string>;
}

// ── Resolvers (caller-supplied, product-scoped) ──────────────────────────

/**
 * Resolves skill names → skill bodies. Drawn from the supervisor's own
 * skill catalog. Async so resolvers can hit the filesystem (skills are
 * typically markdown files).
 *
 * Names that resolve to nothing should be SKIPPED (the runtime treats
 * them as best-effort). The supervisor is told what's available via
 * MultiAgentSection — calls with unknown names are a prompt-eval miss,
 * not a runtime error.
 */
export type SkillResolver = (
  names: readonly string[],
) => Promise<readonly ResolvedSkill[]>;

/**
 * Resolves tool names → tool definitions. Drawn from the supervisor's
 * own tool registry. Tools missing from the registry are dropped silently
 * (same rationale as skills).
 */
export type ToolResolver = (
  names: readonly string[],
) => Record<string, unknown>;

// ── Runtime context ──────────────────────────────────────────────────────

export interface SubAgentRuntimeContext {
  /** Resolves spec.skills to skill bodies. Product-scoped. */
  resolveSkills: SkillResolver;
  /** Resolves spec.tools to AI SDK tool definitions. Product-scoped. */
  resolveTools: ToolResolver;
  /** LLM turn runner. */
  dispatcher: SubAgentDispatcher;
  /** Default step budget when spec doesn't override. */
  defaultMaxSteps?: number;
}

// ── Runtime API (exposed inside the sandbox as `agent.run` / `agent.send`) ─

export interface SubAgentRuntime {
  /** Spawn a fresh sub-agent. The supervisor calls this via `agent.run(...)`. */
  run(spec: SubAgentSpec): Promise<SubAgentResult>;
  /**
   * Continue a previously-spawned sub-agent. The supervisor calls this
   * via `agent.send(agent_id, message)`. Returns `failed` if the
   * agent_id is unknown (e.g. expired between supervisor turns).
   */
  send(agentId: string, message: string): Promise<SubAgentResult>;
}

// ── Continuation state ───────────────────────────────────────────────────

interface ContinuationState {
  /** The original spec, kept so resolvers run with the same skills/tools. */
  spec: SubAgentSpec;
  /** Resolved skill bodies — cached so a follow-up doesn't re-read files. */
  skills: readonly ResolvedSkill[];
  /** Resolved tool defs — same caching rationale. */
  tools: Record<string, unknown>;
  /** Conversation transcript so the dispatcher can carry context forward. */
  transcript: { role: 'user' | 'assistant'; content: string }[];
}

// ── Implementation ───────────────────────────────────────────────────────

const DEFAULT_MAX_STEPS = 8;

/**
 * Generate a stable agent ID. Includes a short timestamp suffix so
 * multiple parallel `agent.run` calls with similar specs don't collide.
 * Format: `sub-{base36 timestamp}-{random}`.
 */
function makeAgentId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `sub-${t}-${r}`;
}

/**
 * Create a sub-agent runtime bound to the caller's resolvers and dispatcher.
 *
 * The returned `run` and `send` functions are async and side-effect-only
 * (no internal state escapes through them) — safe to drop directly onto a
 * sandbox object that's exposed to the LLM via `runInIsolatedVM`.
 */
export function createSubAgentRuntime(
  ctx: SubAgentRuntimeContext,
): SubAgentRuntime {
  const continuations = new Map<string, ContinuationState>();
  const defaultMaxSteps = ctx.defaultMaxSteps ?? DEFAULT_MAX_STEPS;

  async function run(spec: SubAgentSpec): Promise<SubAgentResult> {
    const agentId = makeAgentId();

    if (spec.run_in_background) {
      // Kick off the work but don't await. The result is captured in the
      // continuation map so a later `agent.send(agentId, ...)` can read it.
      // For now we return `running` — full background completion notification
      // is a later slice (needs presence/event channel).
      void executeFresh(spec, agentId).catch(() => {
        /* swallowed — error surfaces on next send() */
      });
      return {
        agent_id: agentId,
        description: spec.description,
        status: 'running',
        result: '',
      };
    }

    return executeFresh(spec, agentId);
  }

  async function send(
    agentId: string,
    message: string,
  ): Promise<SubAgentResult> {
    const state = continuations.get(agentId);
    if (!state) {
      return {
        agent_id: agentId,
        description: '',
        status: 'failed',
        result: '',
        error: `Unknown agent_id: ${agentId}. The agent may have been garbage-collected. Use agent.run() to start a fresh sub-agent.`,
      };
    }

    const userMessage = combineTranscript(state.transcript, message);
    state.transcript.push({ role: 'user', content: message });

    try {
      const text = await ctx.dispatcher.dispatch({
        systemPrompt: buildPrompt(state),
        tools: state.tools,
        userMessage,
        maxSteps: defaultMaxSteps,
        spec: state.spec,
      });
      state.transcript.push({ role: 'assistant', content: text });
      return {
        agent_id: agentId,
        description: state.spec.description,
        status: 'completed',
        result: text,
      };
    } catch (err) {
      return {
        agent_id: agentId,
        description: state.spec.description,
        status: 'failed',
        result: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async function executeFresh(
    spec: SubAgentSpec,
    agentId: string,
  ): Promise<SubAgentResult> {
    const skillNames = spec.skills ?? [];
    const toolNames = spec.tools ?? [];

    const [skills, tools] = await Promise.all([
      ctx.resolveSkills(skillNames),
      Promise.resolve(ctx.resolveTools(toolNames)),
    ]);

    const state: ContinuationState = {
      spec,
      skills,
      tools,
      transcript: [{ role: 'user', content: spec.prompt }],
    };

    try {
      const text = await ctx.dispatcher.dispatch({
        systemPrompt: buildPrompt(state),
        tools,
        userMessage: spec.prompt,
        maxSteps: defaultMaxSteps,
        spec,
      });
      state.transcript.push({ role: 'assistant', content: text });
      continuations.set(agentId, state);
      return {
        agent_id: agentId,
        description: spec.description,
        status: 'completed',
        result: text,
      };
    } catch (err) {
      // Still register the failed agent so send() can give a useful error.
      continuations.set(agentId, state);
      return {
        agent_id: agentId,
        description: spec.description,
        status: 'failed',
        result: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return { run, send };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function buildPrompt(state: ContinuationState): string {
  return buildSubAgentBasePrompt({
    description: state.spec.description,
    tools: Object.keys(state.tools),
    skills: state.skills,
    prompt: state.spec.prompt,
  });
}

/**
 * Builds the user-message string for a `send()` continuation. Includes
 * the most recent assistant turn so the dispatcher's stateless
 * `streamText` call can pick up where the agent left off.
 *
 * Most dispatchers should accept a richer message-history input shape;
 * this is the conservative fallback for dispatchers that take a single
 * userMessage string.
 */
function combineTranscript(
  transcript: readonly { role: 'user' | 'assistant'; content: string }[],
  newMessage: string,
): string {
  if (transcript.length === 0) return newMessage;
  const lastAssistant = [...transcript]
    .reverse()
    .find((m) => m.role === 'assistant');
  if (!lastAssistant) return newMessage;
  return `Previously you said:\n\n${lastAssistant.content}\n\n---\n\nFollow-up from supervisor:\n\n${newMessage}`;
}
