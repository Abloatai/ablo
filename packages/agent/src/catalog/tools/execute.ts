/**
 * executeTool — run generated TypeScript against the sandbox's bound API.
 *
 * The agent writes code to `/scratch/main.ts` (or a caller-specified path),
 * then invokes this tool. The sandbox evaluates the code in its isolated VM
 * with the adapter-supplied namespace (e.g. `layer`, `sheet`, `document`),
 * mutations are recorded, and the tool returns the result + recorded
 * mutations for the host to dispatch through its mutation pipeline.
 *
 * This is the bridge between "agent generates code" and "entities change in
 * real time." The execute() primitive is generic; the host wires the adapter
 * namespaces so that the same bound-API model works across apps/web and
 * agent-worker.
 */

import { z } from 'zod';
import { getSandbox } from './utils';
import type { Mutation } from '../../primitives/mutation';
import { defineTool } from '../../primitives/tool';

const inputSchema = z.object({
  entrypoint: z
    .string()
    .default('/scratch/main.ts')
    .describe('Path to the file to evaluate. Defaults to /scratch/main.ts.'),
  timeoutMs: z
    .number()
    .optional()
    .describe('Per-execution timeout. Overrides sandbox default.'),
});

type Args = z.infer<typeof inputSchema>;

type Result =
  | {
      success: true;
      value: unknown;
      mutations: Mutation[];
      logs: Array<{ level: string; message: string }>;
    }
  | {
      success: false;
      error: string;
      isTimeout?: boolean;
      logs: Array<{ level: string; message: string }>;
    };

export function executeTool() {
  return defineTool({
    description: `Evaluate TypeScript/JavaScript code against the sandbox's bound API.

WHEN TO USE:
- You've written code to /scratch/main.ts and want to run it
- The code uses the domain API (e.g. layer.create, sheet.setCell) and
  should record mutations that the host will apply to real entities

USAGE:
- Write your code with writeFileTool first, then call execute
- Default entrypoint is /scratch/main.ts; override with \`entrypoint\` for
  multi-file workflows (e.g. /scratch/slide-layout.ts)
- Errors inside the code are returned in \`error\`, not thrown
- Successful runs include a \`mutations\` array — the host applies these
  to real entities through the sync engine

IMPORTANT:
- Code runs in an isolated V8 context — no access to Node globals, fs,
  network, or process. Only the domain API is available.
- Memory and timeout limits are enforced by the sandbox.
- This tool does NOT persist anything itself; mutations flow back to the
  host via the tool result, then the host dispatches them.`,
    inputSchema,
    execute: async (
      { entrypoint, timeoutMs },
      { experimental_context },
    ): Promise<Result> => {
      const sandbox = getSandbox(experimental_context, 'execute');

      try {
        const result = await sandbox.execute({ entrypoint, timeoutMs });

        const logs =
          result.logs?.map((l) => ({ level: l.level, message: l.message })) ?? [];

        if (result.error) {
          return {
            success: false,
            error: result.error.message,
            isTimeout: result.error.isTimeout,
            logs,
          };
        }

        return {
          success: true,
          value: result.value,
          mutations: (result.mutations ?? []) as Mutation[],
          logs,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `Sandbox infrastructure failure: ${message}`,
          logs: [],
        };
      }
    },
  });
}
