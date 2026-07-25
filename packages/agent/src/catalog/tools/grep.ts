/**
 * grepTool — port from vercel-labs/open-agents.
 */

import { z } from 'zod';
import * as path from 'node:path';
import { getSandbox } from './utils';
import { defineTool } from '../../primitives/tool';

const inputSchema = z.object({
  pattern: z.string().describe('Regex pattern to search for.'),
  path: z
    .string()
    .optional()
    .describe('Workspace-relative or absolute path to scope the search. Default: working directory.'),
  caseInsensitive: z
    .boolean()
    .optional()
    .describe('Case-insensitive matching. Default: false.'),
  limit: z
    .number()
    .optional()
    .describe('Maximum number of matches. Default: 200.'),
});

type Args = z.infer<typeof inputSchema>;
type Result =
  | {
      success: true;
      pattern: string;
      matches: Array<{ path: string; lineNumber: number; line: string }>;
      truncated: boolean;
    }
  | { success: false; error: string };

export function grepTool() {
  return defineTool({
    description: `Search file contents for a regex pattern.

USAGE:
- Searches the working directory subtree by default
- Provide \`path\` to scope to a specific subdirectory
- Use caseInsensitive: true for case-insensitive matching
- Returns matching lines with file path and line number

PERFORMANCE:
- Prefer to scope with \`path\` when you can — narrow searches are much faster
- Use simple patterns; complex regex can be slow on large workspaces`,
    inputSchema,
    execute: async (
      { pattern, path: userPath, caseInsensitive, limit = 200 },
      { experimental_context },
    ): Promise<Result> => {
      const sandbox = getSandbox(experimental_context, 'grep');
      const scopePath = userPath
        ? userPath.startsWith('/')
          ? userPath
          : path.posix.join(sandbox.workingDirectory, userPath)
        : sandbox.workingDirectory;

      try {
        const matches = await sandbox.grep(pattern, {
          path: scopePath,
          caseInsensitive,
        });
        const truncated = matches.length > limit;
        return {
          success: true,
          pattern,
          matches: matches.slice(0, limit),
          truncated,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Grep failed: ${message}` };
      }
    },
  });
}
