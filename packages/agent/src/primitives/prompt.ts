/**
 * Core string primitives for assembling system prompts.
 *
 * Two helpers every domain-specific prompt file uses. Pure,
 * dependency-free, and intentionally narrow in scope.
 */

/**
 * Wrap a body string in XML-like tags.
 *   section('role', 'You are...') → '<role>\nYou are...\n</role>'
 */
export const section = (name: string, content: string): string =>
  `<${name}>\n${content}\n</${name}>`;

/**
 * Join an ordered list of section strings (or nullish values) into a
 * single prompt. Nullish values are filtered out so call sites can
 * conditionally include sections with ternaries:
 *   `condition ? SomeSection() : null`
 */
export const compose = (...parts: (string | null | undefined)[]): string =>
  parts.filter(Boolean).join('\n\n');
