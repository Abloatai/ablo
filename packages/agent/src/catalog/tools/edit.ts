/**
 * editFileTool — port from vercel-labs/open-agents.
 *
 * Performs targeted in-place edits via Sandbox.edit (which throws on
 * non-unique oldString or missing files). Supports replaceAll for
 * rename-style operations.
 */

import { z } from 'zod';
import * as path from 'node:path';
import { getSandbox } from './utils';
import { defineTool } from '../../primitives/tool';

const inputSchema = z.object({
  filePath: z
    .string()
    .describe('Workspace-relative path to the file to edit.'),
  oldString: z.string().describe('The exact text to replace.'),
  newString: z
    .string()
    .describe('The text to replace it with (must differ from oldString).'),
  replaceAll: z
    .boolean()
    .optional()
    .describe('Replace all occurrences. Default: false (requires uniqueness).'),
});

type Args = z.infer<typeof inputSchema>;
type Result =
  | { success: true; path: string; replacements: number }
  | { success: false; error: string };

export function editFileTool() {
  return defineTool({
    description: `Perform exact string replacement in a file.

WHEN TO USE:
- Small, precise edits to an existing file you've already read
- Renaming a variable consistently within a single file (use replaceAll)

WHEN NOT TO USE:
- Creating new files (use writeFileTool)
- Large rewrites — easier to overwrite (writeFileTool)

USAGE:
- ALWAYS read the file first with readFileTool
- oldString must be EXACT, including whitespace and indentation
- Without replaceAll, oldString must be UNIQUE — otherwise the tool fails
- Never include the "N: " line-number prefixes from readFileTool output

IMPORTANT:
- Preserve exact indentation as returned by readFileTool
- newString must differ from oldString`,
    inputSchema,
    execute: async (
      { filePath, oldString, newString, replaceAll = false },
      { experimental_context },
    ): Promise<Result> => {
      const sandbox = getSandbox(experimental_context, 'edit');
      const absolute = path.isAbsolute(filePath)
        ? filePath
        : path.posix.resolve(sandbox.workingDirectory, filePath);

      if (oldString === newString) {
        return {
          success: false,
          error: 'oldString and newString are identical — no edit to make.',
        };
      }

      try {
        if (replaceAll) {
          const content = await sandbox.readFile(absolute);
          const replaced = content.split(oldString).join(newString);
          const occurrences = content.split(oldString).length - 1;
          if (occurrences === 0) {
            return {
              success: false,
              error: `oldString not found in ${absolute}.`,
            };
          }
          await sandbox.writeFile(absolute, replaced);
          return { success: true, path: absolute, replacements: occurrences };
        }
        // Single-replacement uses Sandbox.edit which enforces uniqueness.
        await sandbox.edit(absolute, oldString, newString);
        return { success: true, path: absolute, replacements: 1 };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Failed to edit file: ${message}` };
      }
    },
  });
}
