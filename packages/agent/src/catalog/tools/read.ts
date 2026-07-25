/**
 * readFileTool — port from vercel-labs/open-agents.
 * Adapted to our virtual fs: simpler path resolution (cwd-relative),
 * no encoding conversion (always utf-8).
 */

import { z } from 'zod';
import * as path from 'node:path';
import { getSandbox } from './utils';
import { defineTool } from '../../primitives/tool';

const inputSchema = z.object({
  filePath: z
    .string()
    .describe(
      'Workspace-relative path to the file to read (e.g., "decks/q4/slides/cover.json"). Absolute paths also work.',
    ),
  offset: z
    .number()
    .optional()
    .describe('Line number to start reading from (1-indexed).'),
  limit: z
    .number()
    .optional()
    .describe('Maximum number of lines to read. Default: 2000.'),
});

type Args = z.infer<typeof inputSchema>;
type Result =
  | {
      success: true;
      path: string;
      totalLines: number;
      startLine: number;
      endLine: number;
      content: string;
    }
  | { success: false; error: string };

export function readFileTool() {
  return defineTool({
    description: `Read a file from the workspace.

USAGE:
- Use workspace-relative paths (e.g., "decks/q4/slides/cover.json"); they resolve from the working directory
- By default reads up to 2000 lines starting from line 1
- Use offset and limit for long files (both are line-based, 1-indexed)
- Results include line numbers in "N: content" format

IMPORTANT:
- Always read a file at least once before editing it with edit/write
- This tool can only read files; use readdir or glob to discover paths`,
    inputSchema,
    execute: async (
      { filePath, offset = 1, limit = 2000 },
      { experimental_context },
    ): Promise<Result> => {
      const sandbox = getSandbox(experimental_context, 'read');
      const absolute = path.isAbsolute(filePath)
        ? filePath
        : path.posix.resolve(sandbox.workingDirectory, filePath);

      try {
        const stats = await sandbox.stat(absolute);
        if (stats.isDirectory()) {
          return {
            success: false,
            error: 'Cannot read a directory. Use readdir or glob instead.',
          };
        }
        const content = await sandbox.readFile(absolute);
        const lines = content.split('\n');
        const startLine = Math.max(1, offset) - 1;
        const endLine = Math.min(lines.length, startLine + limit);
        const numbered = lines
          .slice(startLine, endLine)
          .map((line, i) => `${startLine + i + 1}: ${line}`);
        return {
          success: true,
          path: absolute,
          totalLines: lines.length,
          startLine: startLine + 1,
          endLine,
          content: numbered.join('\n'),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Failed to read file: ${message}` };
      }
    },
  });
}
