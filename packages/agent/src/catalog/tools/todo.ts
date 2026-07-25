/**
 * todoWriteTool — port from vercel-labs/open-agents.
 *
 * Maintains the agent's session-scoped task list. Replaces the entire
 * list on every call (full-replace, not append). The returned `todos`
 * are surfaced to the host UI for progress visualization.
 */

import { z } from 'zod';
import { defineTool } from '../../primitives/tool';

const todoItemSchema = z.object({
  id: z.string().describe('Stable identifier for this todo across updates.'),
  content: z.string().describe('Concise description of the task.'),
  status: z
    .enum(['todo', 'in-progress', 'completed'])
    .describe('Current state. Only ONE todo should be in-progress at a time.'),
});

const inputSchema = z.object({
  todos: z
    .array(todoItemSchema)
    .describe('The complete list of todo items. This replaces existing todos.'),
});

type Args = z.infer<typeof inputSchema>;
type Result = {
  success: true;
  message: string;
  todos: z.infer<typeof todoItemSchema>[];
};

export function todoWriteTool() {
  return defineTool({
    description: `Create and manage a structured task list for the current session.

WHEN TO USE:
- Complex multi-step tasks requiring 3 or more distinct steps
- When the user provides multiple requirements or a checklist
- After receiving new instructions — immediately capture them as todos
- When starting work on a task — mark that todo as in-progress BEFORE beginning
- After completing a task — mark it as completed immediately

WHEN NOT TO USE:
- A single, straightforward task done in one step
- Trivial tasks requiring fewer than 3 minor steps
- Purely conversational or informational queries

TASK STATES:
- "todo": Task not yet started
- "in-progress": Currently being worked on (ONLY ONE at a time)
- "completed": Task finished successfully

USAGE:
- This tool REPLACES the entire todo list — always send the full updated list
- Use it frequently to keep the task list in sync with progress
- Update statuses as you start/finish work, don't batch updates`,
    inputSchema,
    execute: async ({ todos }) => {
      return {
        success: true,
        message: `Updated task list with ${todos.length} items`,
        todos,
      };
    },
  });
}
