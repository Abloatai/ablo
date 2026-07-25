/**
 * @ablo/agent/agent — the primary primitive: spawn an agent.
 *
 * Two ways to spawn live side-by-side:
 *
 *   - `agent.run(spec)` (remote)  — write an AgentJob row + wake the
 *     worker fleet. Producer-side, used by routes and the supervisor
 *     host bridge. Returns a `AgentJobHandle` with `wait/cancel`.
 *
 *   - `createSubagentRuntime(...)` (in-process) — compose an LLM-loop
 *     sub-agent in the same process. Used by the supervisor sandbox to
 *     expose `agent.run({description, prompt})` to the LLM inside
 *     execute(). Different shape, same verb.
 *
 * The two share the cognitive model "run an agent" but live at
 * different layers. Importing both from this barrel keeps the
 * lexical-form difference (`agent.run(spec)` vs `createSubagentRuntime`)
 * the cue for which one you mean.
 */

// Remote dispatch (producer-side)
export {
  agent,
  configureAgentRuntime,
  resetAgentRuntimeForTests,
  isAgentRuntimeConfigured,
  buildAgentJobHandle,
  type AgentJobHandle,
  type AgentRuntimeConfig,
  type CommitTransport,
  type DispatchTransport,
  type CommitReceipt,
  AGENT_PLUGIN_NAMES,
  AGENT_MODEL_IDS,
  AGENT_JOB_STATUSES,
  LLM_LOOP_PLUGIN_NAMES,
  isTerminalAgentJobStatus,
  AgentJobDispatchLostError,
  AgentJobWaitTimeoutError,
  AgentJobEnqueueError,
  type AgentJobSpec,
  type AgentJobRecord,
  type AgentJobStatus,
  type AgentPluginName,
  type AgentModelId,
  type LlmLoopPluginName,
  type WaitOptions,
} from './remote';

// In-process LLM-loop runtime (sandbox-side)
export {
  createSubAgentRuntime,
  type SubAgentRuntime,
  type SubAgentRuntimeContext,
  type SubAgentDispatcher,
  type DispatchInput,
  type SkillResolver,
  type ToolResolver,
  type SubAgentSpec,
  type SubAgentResult,
  type SubAgentStatus,
} from './in-process';
