/**
 * globTool — port from vercel-labs/open-agents.
 */

import { z } from 'zod';
import * as path from 'node:path';
import { getSandbox } from './utils';
import { defineTool } from '../../primitives/tool';

const inputSchema = z.object({
  pattern: z
    .string()
    .describe(
      'Glob pattern (e.g., "**/*.ts", "decks/*/slides/*.json"). Workspace-relative or absolute.',
    ),
  limit: z
    .number()
    .optional()
    .describe('Maximum number of results to return. Default: 100.'),
});

type Args = z.infer<typeof inputSchema>;
type Result =
  | { success: true; pattern: string; matches: string[]; truncated: boolean }
  | { success: false; error: string };

export function globTool() {
  return defineTool({
    description: `Find files by glob pattern.

USAGE:
- Workspace-relative patterns resolve from the working directory
- Use ** to match across directories (e.g., "**/*.ts" matches all .ts files)
- Use * to match a single segment (e.g., "decks/*/meta.json")
- Returns paths sorted alphabetically

EXAMPLES:
- All .json files anywhere: pattern: "**/*.json"
- Slides for one deck: pattern: "decks/q4/slides/*.json"
- Top-level memory files: pattern: "memories/*.md"`,
    inputSchema,
    execute: async (
      { pattern, limit = 100 },
      { experimental_context },
    ): Promise<Result> => {
      const sandbox = getSandbox(experimental_context, 'glob');
      const absolute = pattern.startsWith('/')
        ? pattern
        : path.posix.join(sandbox.workingDirectory, pattern);

      try {
        const all = await sandbox.glob(absolute);
        const sorted = [...all].sort();
        const truncated = sorted.length > limit;
        return {
          success: true,
          pattern: absolute,
          matches: sorted.slice(0, limit),
          truncated,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Glob failed: ${message}` };
      }
    },
  });
}
