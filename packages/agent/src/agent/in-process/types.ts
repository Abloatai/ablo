/**
 * Sub-agent dispatch types.
 *
 * Shape: the supervisor calls `agent.run` inside the execute sandbox,
 * passing two plain string arrays — `skills` (knowledge bundles to attach)
 * and `tools` (capabilities to grant). Both reference names from registries
 * the supervisor already uses; sub-agents draw from the same pools.
 *
 * No frozen sub-agent types. Each dispatch composes its own specialization.
 */

// ── Spec — what the supervisor passes ─────────────────────────────────────

/**
 * One sub-agent spawn request. Emitted by the supervisor LLM through
 * `agent.run(spec)` inside the execute sandbox.
 *
 * Specialization comes from `skills` + `tools`, not a frozen type. The
 * supervisor picks the minimum knowledge and capability the sub-agent
 * needs — same catalogs the supervisor itself reads from.
 */
export interface SubAgentSpec {
  /** 3–5 word task description — surfaces in telemetry and the activity overlay. */
  description: string;
  /** Self-contained brief. The sub-agent does not see the supervisor's conversation. */
  prompt: string;
  /**
   * Skill names to attach. References entries in the supervisor's own skill
   * catalog. Skill bodies are concatenated into the sub-agent's system prompt.
   * Omit for a sub-agent with no specialized knowledge.
   */
  skills?: readonly string[];
  /**
   * Tool names the sub-agent is permitted to call. References entries in the
   * supervisor's tool registry. Acts as the capability whitelist — tools not
   * listed here cannot be invoked. Omit for a no-tool sub-agent (reasoning only).
   */
  tools?: readonly string[];
  /**
   * If true, return immediately with `status: 'running'`. Caller is notified
   * when the sub-agent completes. Use for long jobs (>30s).
   */
  run_in_background?: boolean;
  /**
   * Capability scoping mode. `'scope_narrow'` attenuates the parent's
   * Biscuit token to the sub-agent's `tools` whitelist before dispatching.
   * Omit to inherit the parent's full scope (still bounded by `tools`).
   */
  isolation?: 'scope_narrow';
}

// ── Result — what the sub-agent returns ───────────────────────────────────

/**
 * Sub-agent terminal state.
 * - `completed`  — finished normally with a result
 * - `failed`     — threw or exceeded its budget; `error` populated
 * - `running`    — only returned when `run_in_background: true`
 */
export type SubAgentStatus = 'completed' | 'failed' | 'running';

/**
 * Single sub-agent dispatch result. Plain serializable object — copies
 * cleanly across the isolated-vm boundary.
 */
export interface SubAgentResult {
  /** Stable identifier — pass to `agent.send()` to continue this sub-agent. */
  agent_id: string;
  /** Echoed from the spec — useful for trace alignment when many run in parallel. */
  description: string;
  status: SubAgentStatus;
  /** Free-text summary the sub-agent produced. Empty when status !== 'completed'. */
  result: string;
  /** Present iff status === 'failed'. */
  error?: string;
}
