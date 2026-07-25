/**
 * The color helpers for the CLI's brand palette — Ablo's paper white (`#fafafa`)
 * and black.
 *
 * A terminal can't set its own background, and paper-white text is invisible on
 * a light terminal, so {@link brand} renders the wordmark as a chip — black text
 * on a `#fafafa` block, drawn with 24-bit truecolor — and paper white is reserved
 * for small accents through {@link paper}. Both fall back to plain text when color
 * is unsupported (no TTY) or `NO_COLOR` is set.
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
