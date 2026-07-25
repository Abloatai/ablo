/**
 * Tool utility helpers.
 *
 * Tools pull ambient state (Sandbox, Agent) from AI SDK's
 * `experimental_context` rather than closing over module-level state.
 * These helpers extract the right piece with clear error messages when
 * the context isn't wired correctly.
 *
 * Mirrors open-agents' `tools/utils.ts` shape (their `getSandbox()`),
 * adapted to our `AgentContext` type.
 */

import type { Sandbox } from '../../primitives/sandbox';
import type { AgentContext } from '../../types';

/**
 * Extract the Sandbox from a tool's `experimental_context`. Throws a
 * clear error when the context isn't an AgentContext or the sandbox
 * isn't set — agents should treat this as a configuration bug, not
 * normal tool error.
 *
 * ```ts
 * execute: async (args, { experimental_context }) => {
 *   const sandbox = getSandbox(experimental_context, 'read');
 *   const content = await sandbox.readFile(args.path);
 *   return content;
 * }
 * ```
 */
export function getSandbox(ctx: unknown, toolName: string): Sandbox {
  if (!isAgentContext(ctx)) {
    throw new Error(
      `Tool "${toolName}" requires an AgentContext in experimental_context. ` +
        `Pass { sandbox, perception, ... } satisfies AgentContext when calling generateText.`,
    );
  }
  if (!ctx.sandbox) {
    throw new Error(
      `Tool "${toolName}" requires a sandbox. ` +
        `Set context.sandbox to a Sandbox instance (e.g. via DefaultSandbox.create()) before calling generateText.`,
    );
  }
  return ctx.sandbox;
}

/**
 * Try to extract the Sandbox without throwing. Use for tools where
 * a sandbox is optional (e.g. tools that work with or without code execution).
 */
export function trySandbox(ctx: unknown): Sandbox | undefined {
  if (!isAgentContext(ctx)) return undefined;
  return ctx.sandbox;
}

/**
 * Type guard for AgentContext shape. Structural — checks for the presence
 * of `perception` (the only required field on AgentContext) without
 * importing the `Agent` class to avoid a hard dependency.
 */
function isAgentContext(ctx: unknown): ctx is AgentContext {
  return (
    typeof ctx === 'object' &&
    ctx !== null &&
    'perception' in ctx
  );
}

/**
 * Convert an absolute path into a compact, model-friendly display path.
 *
 * Mirrors open-agents' `toDisplayPath`. Used by tool result formatting
 * so paths in tool output are readable for the agent.
 */
export function toDisplayPath(filePath: string, workingDirectory?: string): string {
  if (!workingDirectory) return filePath;
  if (filePath === workingDirectory) return '.';
  if (filePath.startsWith(`${workingDirectory}/`)) {
    return filePath.slice(workingDirectory.length + 1);
  }
  return filePath;
}
