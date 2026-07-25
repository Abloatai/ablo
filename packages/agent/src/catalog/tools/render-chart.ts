/**
 * renderChartTool — generate an SVG chart from D3 code.
 *
 * Writes the agent-supplied D3 code to a chart scratch path, executes it
 * in the sandbox, and returns the final SVG string. The sandbox's bound
 * API exposes D3 utilities (scales, shapes, etc.) — the code produces an
 * SVG element (serialized string) which this tool returns.
 *
 * This is a specialization of executeTool for the common "I want an SVG
 * chart" case. For general code execution, use executeTool directly.
 */

import { z } from 'zod';
import { getSandbox } from './utils';
import { defineTool } from '../../primitives/tool';

const inputSchema = z.object({
  code: z
    .string()
    .describe(
      'D3 code that builds a chart. Must end with a `return svgString;` where ' +
        'svgString is the serialized SVG content. Has access to d3.* utilities.',
    ),
  width: z.number().optional().describe('Chart width in pixels. Default 800.'),
  height: z.number().optional().describe('Chart height in pixels. Default 600.'),
  timeoutMs: z
    .number()
    .optional()
    .describe('Execution timeout. Defaults to the sandbox default.'),
});

type Args = z.infer<typeof inputSchema>;
type Result =
  | { success: true; svg: string; width: number; height: number }
  | { success: false; error: string };

const SCRATCH_PATH = '/scratch/chart.ts';

export function renderChartTool() {
  return defineTool({
    description: `Render an inline SVG chart using D3.

USAGE:
- Provide D3 code that builds an SVG and returns the serialized string
- Width/height default to 800x600 — override when you need a specific aspect
- Returns the SVG as a string you can embed in a slide layer, doc, etc.

CODE CONVENTIONS:
- Use d3.* utilities available in the sandbox (scales, shapes, selections)
- Structure code as: set up scales → build svg → serialize → return svgString
- Keep the code focused; for more complex work, use executeTool directly`,
    inputSchema,
    execute: async (
      { code, width = 800, height = 600, timeoutMs },
      { experimental_context },
    ): Promise<Result> => {
      const sandbox = getSandbox(experimental_context, 'render_chart');

      // Inject the agent's code into a chart-specific entrypoint.
      // We wrap with the width/height context so the code can reach for them.
      const wrapped = `
        var __width = ${width};
        var __height = ${height};
        ${code}
      `;

      try {
        await sandbox.writeFile(SCRATCH_PATH, wrapped);
      } catch (err) {
        return {
          success: false,
          error: `Failed to stage chart code: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      try {
        const result = await sandbox.execute({
          entrypoint: SCRATCH_PATH,
          timeoutMs,
        });
        if (result.error) {
          return {
            success: false,
            error: `Chart rendering failed: ${result.error.message}`,
          };
        }
        if (typeof result.value !== 'string') {
          return {
            success: false,
            error:
              'Chart code must return a string containing serialized SVG, got: ' +
              typeof result.value,
          };
        }
        return { success: true, svg: result.value, width, height };
      } catch (err) {
        return {
          success: false,
          error: `Sandbox failure during chart rendering: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  });
}
