/**
 * Shared types across @ablo/agent subpaths.
 *
 * AgentContext is the canonical ambient-state bridge for tools — passed
 * via AI SDK's `experimental_context` option. Extends the base context
 * from @abloatai/transaction with agent-package-specific fields (sandbox, ...).
 */

import type { Agent } from './perception/index.js';
import type { Sandbox, SandboxHooks } from './primitives/sandbox/interface';

// Re-export commonly-used sandbox types for consumers who import from
// the top-level package.
export type { Sandbox, SandboxHooks };

/**
 * Ambient context threaded into AI SDK tools via `experimental_context`.
 * Extends the base AgentContext from @abloatai/transaction with a `sandbox`
 * field that code-execution tools (renderChart, execute) read.
 *
 * ```ts
 * await generateText({
 *   model,
 *   tools: { renderChart: renderChartTool() },
 *   experimental_context: { perception, sandbox } satisfies AgentContext,
 * });
 * ```
 */
export interface AgentContext extends Agent.Context {
  /** Sandbox for tool code execution. Required by sandbox-using tools. */
  sandbox?: Sandbox;
}
