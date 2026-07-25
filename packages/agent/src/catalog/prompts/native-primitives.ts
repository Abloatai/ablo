/**
 * Native-primitives discipline section.
 *
 * The architectural rule from `docs/NATIVE-PRIMITIVES-ARCHITECTURE.md`,
 * lifted into the system prompt verbatim. Shared by both supervisor
 * prompts and sub-agent prompts so the discipline propagates through
 * the dispatch tree.
 *
 * The litmus test ("Could a model with no exposure to this codebase
 * write this correctly?") is stated inline so the LLM can apply it to
 * its own output without having to remember the rule abstractly.
 */

import { section } from '../../primitives/prompt';

const NATIVE_PRIMITIVES_BODY = `Use names from universal vocabularies when emitting structure (tool args, JSON output, code):
- SVG attributes: x, y, width, height, fill, stroke, transform, rx
- CSS properties: opacity, font-size, font-family, font-weight
- Standard discriminated unions: { type, ... } or { kind, ... }
- HTTP verbs and status codes
- Plain JS primitives: Promise.all, async/await, try/catch

Do NOT invent new field names for concepts that already have universal names. Do not write \`coords: [x, y]\` when \`x\`, \`y\` already exist. Do not write \`colorRef\` when \`fill\` already exists. Do not write \`rotationDeg\` when \`transform: "rotate(45deg)"\` already exists.

The test before emitting any structured output: "Could a model with no exposure to this codebase write this correctly?" If no, rename until yes.`;

/**
 * The native-primitives discipline as a prompt section.
 *
 * Wrapped in `<native_primitives>` tags following the package's
 * `section()` convention. Append to both supervisor and sub-agent
 * prompts.
 */
export function NativePrimitivesSection(): string {
  return section('native_primitives', NATIVE_PRIMITIVES_BODY);
}
