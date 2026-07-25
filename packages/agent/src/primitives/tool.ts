/**
 * defineTool — local, type-cheap tool factory helper.
 *
 * AI SDK v6's `tool()` helper has a pathological type graph (Tool<TArgs,
 * TResult> + Zod inference + overloads) that triggers exponential type
 * inference in tsc — a single call can OOM a 2 GB heap in ~50 s.
 *
 * At runtime, `tool()` is the identity function (see
 * @ai-sdk/provider-utils/dist/index.mjs: `function tool(t) { return t; }`).
 * The only reason to call it is type inference, so we replace it with this
 * local helper that gives the same inference via Zod without pulling in
 * AI SDK's Tool generic.
 *
 * Consumers (generateText, streamText) accept the returned shape structurally
 * — the Tool type is satisfied by `{ description, inputSchema, execute }`.
 */

import type { z } from 'zod';

/** Shape AI SDK passes as the second arg to `execute`. */
export type ToolExecuteContext = {
  experimental_context?: unknown;
  toolCallId?: string;
  messages?: unknown[];
  abortSignal?: AbortSignal;
};

export interface ToolDefinition<S extends z.ZodType, R> {
  description: string;
  inputSchema: S;
  execute: (args: z.infer<S>, ctx: ToolExecuteContext) => Promise<R>;
}

/** Client-side tool (no `execute` — host UI handles the tool call). */
export interface ClientToolDefinition<S extends z.ZodType, O extends z.ZodType> {
  description: string;
  inputSchema: S;
  outputSchema: O;
  toModelOutput?: (output: z.infer<O>) => unknown;
}

/**
 * Define an agent tool with Zod-inferred input args. Zero pathological
 * generics. Returned object satisfies AI SDK's Tool interface structurally.
 */
export function defineTool<S extends z.ZodType, R>(
  config: ToolDefinition<S, R>,
): ToolDefinition<S, R> {
  return config;
}

/** Define a client-side tool (no execute). */
export function defineClientTool<S extends z.ZodType, O extends z.ZodType>(
  config: ClientToolDefinition<S, O>,
): ClientToolDefinition<S, O> {
  return config;
}
