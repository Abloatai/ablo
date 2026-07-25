/**
 * @ablo/agent — primitives for building AI agents.
 *
 * Three areas, each with a subpath barrel:
 *
 *   `@ablo/agent/primitives` — the verbs (tool, prompt, sandbox, mutation,
 *                              middleware). Factories + types only.
 *
 *   `@ablo/agent/agent`      — THE primary primitive: spawn an agent.
 *                              `agent.run(spec)` (remote dispatch) +
 *                              `createSubagentRuntime(...)` (in-process).
 *
 *   `@ablo/agent/catalog/*`  — bundled concrete instances built on top
 *                              of the primitives: tools, prompts, models.
 *
 * The top-level barrel re-exports the most-used surface so trivial
 * consumers can `import { agent, tool, section } from '@ablo/agent'`.
 * Specialized imports go through the subpaths.
 */

// Primary primitive
export {
  agent,
  configureAgentRuntime,
  type AgentJobHandle,
  type AgentJobSpec,
  type AgentRuntimeConfig,
  AgentJobDispatchLostError,
  AgentJobWaitTimeoutError,
  AgentJobEnqueueError,
} from './agent';

// Verb primitives
export { defineTool, section, compose } from './primitives';

// Shared agent context types used across both layers
export type { AgentContext, Sandbox, SandboxHooks } from './types';
