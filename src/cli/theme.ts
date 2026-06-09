/**
 * CLI brand palette — mirrors the canonical Ablo system (paper `#fafafa` + black).
 *
 * A terminal can't set its own background, and a paper-white *foreground* is
 * invisible on light terminals — so we render the wordmark as a CHIP (black
 * text on a `#fafafa` block) via 24-bit truecolor, and reserve paper-white for
 * small accents only. Falls back to plain text when color is unsupported
 * (no TTY) or `NO_COLOR` is set.
 */

const RESET = '\x1b[0m';
const PAPER_BG = '\x1b[48;2;250;250;250m'; // #fafafa background
const BLACK_FG = '\x1b[38;2;0;0;0m'; // #000000 text
const PAPER_FG = '\x1b[38;2;250;250;250m'; // #fafafa text

function colorEnabled(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

/** The `ablo` wordmark as a paper chip: black text on `#fafafa`. */
export function brand(label = 'ablo'): string {
  if (!colorEnabled()) return label;
  return `${PAPER_BG}${BLACK_FG} ${label} ${RESET}`;
}

/** Paper-white foreground accent (use sparingly — only legible on dark terminals). */
export function paper(text: string): string {
  if (!colorEnabled()) return text;
  return `${PAPER_FG}${text}${RESET}`;
}
