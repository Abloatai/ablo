/**
 * @ablo/agent/agent — supervisor → sub-agent dispatch.
 *
 * Public surface:
 *   - Types: SubAgentSpec, SubAgentResult, SubAgentStatus
 *   - Runtime: createSubAgentRuntime, SubAgentRuntime, SubAgentDispatcher,
 *              SubAgentRuntimeContext, SkillResolver, ToolResolver
 *
 * The supervisor LLM dispatches via `agent.run()` / `agent.send()` inside
 * the existing execute sandbox — NOT a top-level AI SDK tool. Each
 * dispatch composes its specialization on the spot via `skills` and
 * `tools` arrays referencing the supervisor's own catalogs.
 */

export type {
  SubAgentSpec,
  SubAgentResult,
  SubAgentStatus,
} from './types';

export {
  createSubAgentRuntime,
  type SubAgentRuntime,
  type SubAgentRuntimeContext,
  type SubAgentDispatcher,
  type DispatchInput,
  type SkillResolver,
  type ToolResolver,
} from './run';
