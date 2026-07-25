/**
 * Sub-agent base prompt — what every sub-agent shares.
 *
 * Sub-agents do NOT inherit the supervisor's full system prompt. They
 * get a narrow prompt scoped to their job: role + scope (the tools the
 * supervisor attached) + return contract + native primitives discipline
 * + attached skill bodies + the task brief.
 *
 * Composition pattern in the runtime (added in a later slice):
 *
 * ```ts
 * const systemPrompt = buildSubAgentBasePrompt({
 *   description: spec.description,
 *   tools: resolvedToolNames,
 *   skills: resolvedSkillBodies,
 *   prompt: spec.prompt,
 * });
 * ```
 */

import { section } from '../../primitives/prompt';
import { NativePrimitivesSection } from './native-primitives';

// ── Role ──────────────────────────────────────────────────────────────────

/**
 * Sub-agent role section — frames the agent as a focused worker, not a
 * conversational co-pilot. Emphasizes single-output return.
 *
 * `description` is the 3–5 word spec.description string. Surfaces in
 * the role line so the agent knows in one sentence what it's for.
 */
export function SubAgentRoleSection(description: string): string {
  return section(
    'role',
    `You are a focused sub-agent. Your job: ${description}.

You were spawned by a supervisor agent for one focused task. You do not see the supervisor's conversation. The full task brief is in the <task> section.

Return ONE summary message when you finish. Do not ask the supervisor for clarification — make a reasonable judgment from the brief and proceed. If the brief is genuinely ambiguous, return what you can and state the ambiguity in your summary.`,
  );
}

// ── Scope ─────────────────────────────────────────────────────────────────

/**
 * Lists the tools this sub-agent has access to. The supervisor's full
 * tool list is intentionally not mentioned — sub-agents only see the
 * narrowed scope their dispatch attached.
 *
 * Pass an empty array (or omit `tools`) for a reasoning-only sub-agent.
 */
export function SubAgentScopeSection(tools: readonly string[]): string {
  if (tools.length === 0) {
    return section(
      'scope',
      'You have no tools. Respond with reasoning only based on the task brief.',
    );
  }
  return section(
    'scope',
    `Tools available to you:
${tools.map((t) => `  - ${t}`).join('\n')}

You cannot call any tool not listed here. If the task seems to require a missing tool, return a summary stating what was needed and stop.`,
  );
}

// ── Return contract ──────────────────────────────────────────────────────

/**
 * Tells the sub-agent what its final message should look like. The
 * supervisor parses this as the `result` field of `SubAgentResult`.
 */
export function SubAgentReturnContractSection(): string {
  return section(
    'return_contract',
    `Your final message is the entire result the supervisor sees. Make it self-contained:

- Lead with the answer or outcome, not the process.
- If the task asked for structured data (a list, JSON, fields), emit it as plain text the supervisor can parse — JSON, markdown table, or one fact per line.
- Cite sources when you used web search or files. Inline references are fine: "(annual report p.42)".
- If you partially succeeded, state what you got and what you couldn't.
- Do not ask follow-up questions. The supervisor cannot answer.`,
  );
}

// ── Skills attached ──────────────────────────────────────────────────────

/**
 * Resolved skill content attached to this sub-agent. Each entry is a
 * `{ name, body }` pair — the runtime resolves names from the supervisor's
 * skill catalog and passes the resolved markdown bodies in.
 */
export interface ResolvedSkill {
  /** Skill name as registered in the catalog. Surfaced as a heading. */
  name: string;
  /** The skill's markdown body — verbatim content from the catalog. */
  body: string;
}

/**
 * Renders attached skills as a single section. Each skill becomes a
 * sub-section with its name as the heading and its body as content.
 *
 * Returns null when no skills are attached — `compose()` filters nullish.
 */
export function SubAgentSkillsSection(
  skills: readonly ResolvedSkill[],
): string | null {
  if (skills.length === 0) return null;
  const body = skills
    .map((s) => `## ${s.name}\n\n${s.body.trim()}`)
    .join('\n\n---\n\n');
  return section('attached_skills', body);
}

// ── Convenience composer ─────────────────────────────────────────────────

export interface BuildSubAgentBaseOptions {
  /** From spec.description — surfaces in the role line. */
  description: string;
  /** Resolved tool names — drives the scope section. */
  tools: readonly string[];
  /** Resolved skill bodies — concatenated into the attached_skills section. */
  skills: readonly ResolvedSkill[];
  /** The supervisor-supplied brief. Wrapped in <task> tags. */
  prompt: string;
}

/**
 * Default composition for a sub-agent prompt — five shared sections plus
 * the task brief. Used by the dispatch runtime; no per-type customization
 * needed because specialization comes from the attached skills.
 */
export function buildSubAgentBasePrompt(
  opts: BuildSubAgentBaseOptions,
): string {
  return [
    SubAgentRoleSection(opts.description),
    SubAgentScopeSection(opts.tools),
    SubAgentReturnContractSection(),
    NativePrimitivesSection(),
    SubAgentSkillsSection(opts.skills),
    section('task', opts.prompt),
  ]
    .filter((p): p is string => p !== null)
    .join('\n\n');
}
