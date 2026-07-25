/**
 * Utility to sanitize strings for transport systems that
 * cannot handle non-ASCII/Unicode characters.
 */
export function sanitizeString(input: string): string {
  // Replace common non-ASCII punctuation/symbols
  return input
    .replace(/[\u2014]/g, '-') // em-dash
    .replace(/[\u2013]/g, '-') // en-dash
    .replace(/[\u2018\u2019]/g, "'") // smart quotes
    .replace(/[\u201c\u201d]/g, '"') // smart quotes
    .replace(/[^\x00-\x7F]/g, ''); // strip remaining non-ASCII
}
