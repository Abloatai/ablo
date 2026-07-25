/**
 * @ablo/agent/catalog/tools — tool factories.
 *
 * Each tool is a factory function that returns a `Tool` from the `ai`
 * package. Factories read ambient state (Sandbox, perception) from
 * `experimental_context` — see ../types.ts for AgentContext.
 *
 * Filesystem tools (read, write, edit, glob, grep) are ports of
 * vercel-labs/open-agents tools adapted to our virtual fs.
 */

// Filesystem tools (open-agents ports)
export { readFileTool } from './read';
export { writeFileTool } from './write';
export { editFileTool } from './edit';
export { globTool } from './glob';
export { grepTool } from './grep';

// Planning + interaction (open-agents ports)
export { todoWriteTool } from './todo';
export { askUserQuestionTool } from './ask';

// Domain-specific tools (ours)
export { executeTool } from './execute';
export { renderChartTool } from './render-chart';

// Helpers
export { getSandbox, trySandbox, toDisplayPath } from './utils';
