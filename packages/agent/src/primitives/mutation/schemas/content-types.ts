/**
 * Shared content type identifiers — moved from apps/web.
 *
 * The pipeline operates on a closed set of content types. Adding a new
 * type means: add it here, write an adapter, register it. The pipeline
 * itself doesn't change.
 */

export const CONTENT_TYPES = ['slide', 'spreadsheet', 'document'] as const;

export type ContentType = (typeof CONTENT_TYPES)[number];

export function isContentType(value: unknown): value is ContentType {
  return typeof value === 'string' && (CONTENT_TYPES as readonly string[]).includes(value);
}
