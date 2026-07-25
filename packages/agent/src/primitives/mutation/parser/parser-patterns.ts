/**
 * ParserPattern — declarative description of an AI sandbox API call shape
 * that the streaming code parser should detect.
 *
 * The streaming parser reads the AI's `execute` tool code character-by-character
 * as it streams in. When it sees a function call matching one of these
 * patterns, it tracks brace/paren depth to know when the arguments close,
 * then emits a `MutationIntentEvent` containing the parsed arguments. This
 * lets clients render preview state BEFORE the code actually runs.
 *
 * Each adapter contributes its own patterns. The parser is content-agnostic;
 * it just walks the patterns supplied to it.
 *
 * Ported from apps/web/src/lib/ai/core/mutations/parser/parser-patterns.ts.
 */

import type { ContentType } from '../schemas/content-types';

/**
 * A single function call shape the parser should detect.
 */
export interface ParserPattern {
  /** Stable identifier for this pattern (used in events and tests). */
  type: string;
  /** Which CRUD verb this call represents. */
  mutationType: 'create' | 'update' | 'delete';
  /** Which entity type the resulting mutation will reference. */
  entityType: string;
  /** Content type this pattern belongs to (for routing in the runner). */
  contentType: ContentType;
  /**
   * Regex matching the START of the function call (up to but not including
   * the opening paren content). The parser uses this to detect the call site;
   * argument extraction is handled separately by walking brace depth.
   *
   * MUST use the global flag (`g`) so the parser can find multiple matches in
   * one buffer. MUST NOT have capture groups (the parser doesn't use them).
   */
  callPattern: RegExp;
  /**
   * Optional human-readable description shown in dev tools / activity overlay
   * when this pattern fires. Defaults to a synthesized "{verb} {entity}" string.
   */
  description?: string;
}

/** Sanity check on a pattern at registration time. Throws if invalid. */
export function validateParserPattern(pattern: ParserPattern): void {
  if (!pattern.callPattern.global) {
    throw new Error(
      `ParserPattern "${pattern.type}": callPattern must have the 'g' (global) flag`,
    );
  }
  if (!pattern.type || !pattern.entityType || !pattern.contentType) {
    throw new Error(
      `ParserPattern "${pattern.type}": missing required field (type, entityType, or contentType)`,
    );
  }
}
