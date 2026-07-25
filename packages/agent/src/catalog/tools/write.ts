/**
 * writeFileTool — port from vercel-labs/open-agents.
 */

import { z } from 'zod';
import * as path from 'node:path';
import { getSandbox } from './utils';
import { defineTool } from '../../primitives/tool';

const inputSchema = z.object({
  filePath: z
    .string()
    .describe('Workspace-relative path to write (e.g., "scratch/main.ts").'),
  content: z.string().describe('Content to write to the file.'),
});

type Args = z.infer<typeof inputSchema>;
type Result =
  | { success: true; path: string; bytesWritten: number }
  | { success: false; error: string };

export function writeFileTool() {
  return defineTool({
    description: `Write content to a file.

WHEN TO USE:
- Creating a new file
- Completely replacing an existing file (after reading it first)

WHEN NOT TO USE:
- Small/localized changes (use editFileTool instead)
- Reading (use readFileTool)

USAGE:
- Workspace-relative paths
- OVERWRITES existing files entirely
- Parent directories are created automatically

IMPORTANT:
- ALWAYS read an existing file before overwriting it
- Don't write secrets/credentials`,
    inputSchema,
    execute: async (
      { filePath, content },
      { experimental_context },
    ): Promise<Result> => {
      const sandbox = getSandbox(experimental_context, 'write');
      const absolute = path.isAbsolute(filePath)
        ? filePath
        : path.posix.resolve(sandbox.workingDirectory, filePath);

      try {
        const dir = path.posix.dirname(absolute);
        await sandbox.mkdir(dir, { recursive: true });
        await sandbox.writeFile(absolute, content);
        const stats = await sandbox.stat(absolute);
        return { success: true, path: absolute, bytesWritten: stats.size };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Failed to write file: ${message}` };
      }
    },
  });
}
