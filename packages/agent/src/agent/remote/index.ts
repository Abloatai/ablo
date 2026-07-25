/**
 * @ablo/agent/agent/remote — `agent.run(spec)` for producers.
 *
 * Public surface:
 *
 *   agent.run(spec)            — paired create-row + dispatch
 *   configureAgentRuntime(...) — wire transports at boot
 *   handle.wait() / cancel()   — observe / control a dispatched job
 *
 * Errors:
 *
 *   AgentJobDispatchLostError  — never claimed by a worker
 *   AgentJobWaitTimeoutError   — terminal budget elapsed
 *   AgentJobEnqueueError       — dispatch transport failed at write time
 */

export {
  agent,
  configureAgentRuntime,
  resetAgentRuntimeForTests,
  isAgentRuntimeConfigured,
} from './run';
export { buildAgentJobHandle, type AgentJobHandle } from './handle';
export type {
  AgentRuntimeConfig,
  CommitTransport,
  DispatchTransport,
  CommitReceipt,
} from './transport';
export {
  AGENT_PLUGIN_NAMES,
  AGENT_MODEL_IDS,
  AGENT_JOB_STATUSES,
  LLM_LOOP_PLUGIN_NAMES,
  isTerminalAgentJobStatus,
  AgentJobDispatchLostError,
  AgentJobWaitTimeoutError,
  AgentJobEnqueueError,
} from './types';
export type {
  AgentJobSpec,
  AgentJobRecord,
  AgentJobStatus,
  AgentPluginName,
  AgentModelId,
  LlmLoopPluginName,
  WaitOptions,
} from './types';
