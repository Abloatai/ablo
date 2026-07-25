/**
 * @ablo/agent/catalog/prompts — composable prompt primitives.
 *
 * Two layers:
 *
 * 1. **Baseline** — ported from vercel-labs/open-agents. Generic agent
 *    operating principles + model-family overlays. Use as the foundation
 *    for every system prompt.
 *
 * 2. **Composition primitives** — `section()` + `compose()` for assembling
 *    domain-specific prompts on top of the baseline (populated in step 5).
 *
 * ```ts
 * import { buildBaselineSystemPrompt } from '@ablo/agent/catalog/prompts';
 *
 * const systemPrompt = [
 *   buildBaselineSystemPrompt({
 *     modelId: 'anthropic/claude-sonnet-4.5',
 *     environmentDetails: sandbox.environmentDetails,
 *     skills: availableSkills,
 *   }),
 *   buildDeckDomainPrompt({ deck, theme }),  // your domain prompt
 * ].join('\n\n');
 * ```
 */

export {
  buildBaselineSystemPrompt,
  type BuildBaselineSystemPromptOptions,
  type BaselineSkillMetadata,
} from './baseline';

export { section, compose } from '../../primitives/prompt';

// Multi-agent dispatch sections — used in supervisor and sub-agent prompts.
// agent.run() / agent.send() are exposed as bound APIs inside the execute
// sandbox in a later slice; these prompt sections are the supervisor's first
// view of the dispatch primitive.

export { NativePrimitivesSection } from './native-primitives';

export {
  SubAgentRoleSection,
  SubAgentScopeSection,
  SubAgentReturnContractSection,
  SubAgentSkillsSection,
  buildSubAgentBasePrompt,
  type ResolvedSkill,
  type BuildSubAgentBaseOptions,
} from './sub-agent-base';

export {
  MultiAgentSection,
  type MultiAgentSectionOptions,
  type AvailableSkill,
} from './multi-agent';
