/**
 * The single CLI error renderer. Every command, and the top-level catch, routes
 * failures through here so the terminal shows a clean, structured block instead
 * of the wall of text `console.error(err)` produces (a stack trace plus every
 * enumerable field).
 *
 * It reads the fields an {@link AbloError} already carries — `code`, `message`,
 * `param`, `docUrl`, `requestId`, and `details` — and lays them out with a clear
 * title, the cause, and a next step. The stack is hidden by default and shown
 * only in verbose mode. The data was always structured; this is what renders it.
 *
 *   ✗ Validation error  [model_required_field_missing]
 *
 *     A required field was absent from the model payload.
 *     field  task.title
 *     docs   https://docs.abloatai.com/errors#model_required_field_missing
 *     ref    req_abc123
 */

import pc from 'picocolors';

import { AbloError, classifyRecovery, toAbloError } from '@abloatai/transaction/errors';
import { terminalWidth } from './terminalWidth.js';
import { brand } from './theme.js';

export interface RenderErrorOptions {
  /** Show the stack + raw details. Defaults to `--verbose`/`ABLO_VERBOSE=1`. */
  readonly verbose?: boolean;
  /**
   * Emit the failure as one JSON line — the canonical error envelope
   * (`AbloError.toJSON`, the same `{ type, code, message, doc_url, … }` shape
   * the API serves) — instead of the terminal block. For agents and scripts:
   * every field a program branches on (`code`, `doc_url`, domain details)
   * arrives structured, with nothing to scrape out of colored text. Defaults
   * to `--json`/`ABLO_JSON=1`.
   */
  readonly json?: boolean;
  /** Output sink — defaults to `console.error`. Injectable for tests. */
  readonly write?: (line: string) => void;
}

/** A one-line, recovery-class hint appended under the message when useful. */
const RECOVERY_HINT: Readonly<Record<string, string>> = {
  transient: 'This looks transient — retry in a moment.',
  permission: "Your key isn't allowed to do this — check its scopes or role.",
  session_expiry: 'Your session expired — sign in again.',
  access_credential_expiry: 'Your access credential expired — refresh it and retry.',
  auth_blocked:
    'Authentication was blocked — the credential itself was rejected. Check that the key matches this environment.',
};

/** `AbloValidationError` → `Validation error`; `AbloNotFoundError` → `Not found error`. */
function titleForType(type: string): string {
  const core = type.replace(/^Ablo/, '').replace(/Error$/, '');
  const spaced = core.replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
  if (!spaced) return 'Error';
  return /error$/i.test(spaced) ? spaced : `${spaced} error`;
}

function isStringArray(v: unknown): v is readonly string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Wrap one paragraph to the block's measure. A message that explains a remedy
 * runs to several sentences, and left to the terminal's own soft-wrap the
 * continuation lines fall back to column zero — the block loses its shape
 * exactly where it is trying to be read. Caps at 76 columns even on a wide
 * terminal, because a very long line is hard to track back to regardless of
 * whether it fits. A word longer than the measure (a host, a connection string)
 * is left whole rather than hyphenated.
 */
function wrapParagraph(text: string, indent: string): string[] {
  const measure = Math.max(32, Math.min(76, terminalWidth(80) - indent.length - 1));
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/)) {
    if (current === '') current = word;
    else if (current.length + 1 + word.length <= measure) current += ` ${word}`;
    else {
      lines.push(indent + current);
      current = word;
    }
  }
  if (current !== '') lines.push(indent + current);
  return lines;
}

/**
 * Renders a few well-known, high-value keys from `details` compactly, rather
 * than dumping the whole object. Any other details surface only under
 * `--verbose`.
 */
function renderKnownDetails(
  details: Readonly<Record<string, unknown>> | undefined,
  line: (s: string) => void,
): void {
  if (!details) return;
  const { retryAfterSeconds, missingIds, requiredCapability, unexecutable, errors, target } =
    details;
  // What Ablo dialled, for the errors that dial something. Recognising the wrong
  // host on sight is most of the diagnosis, so it earns a line of its own rather
  // than sitting behind `--verbose`.
  if (typeof target === 'string') line(`    ${pc.dim('tried')}  ${target}`);
  if (typeof retryAfterSeconds === 'number') line(`    ${pc.dim('retry')}  after ${retryAfterSeconds}s`);
  if (isStringArray(missingIds) && missingIds.length > 0) {
    const shown = missingIds.slice(0, 5).join(', ');
    const more = missingIds.length > 5 ? ` (+${missingIds.length - 5} more)` : '';
    line(`    ${pc.dim('missing')} ${shown}${more}`);
  }
  if (typeof requiredCapability === 'string') line(`    ${pc.dim('needs')}  ${requiredCapability}`);
  if (Array.isArray(unexecutable) && unexecutable.length > 0) {
    line(`    ${pc.dim('blocked')} ${unexecutable.length} change(s) can't be applied — see \`unexecutable\` (--verbose)`);
  }
  // Aggregate field-level failures (the errors[] convention).
  if (Array.isArray(errors)) {
    for (const e of errors.slice(0, 8)) {
      if (e && typeof e === 'object') {
        const rec = e as Record<string, unknown>;
        const where = typeof rec.param === 'string' ? `${rec.param}: ` : '';
        const msg = typeof rec.message === 'string' ? rec.message : '';
        if (msg) line(`    ${pc.dim('·')} ${where}${msg}`);
      }
    }
  }
}

/**
 * Render any thrown value as a structured terminal block and set
 * `process.exitCode = 1`. Safe on `AbloError`, plain `Error`, and non-errors.
 */
export function renderCliError(err: unknown, opts: RenderErrorOptions = {}): void {
  const line = opts.write ?? ((l: string) => { console.error(l); });
  const verbose =
    opts.verbose ?? (process.argv.includes('--verbose') || process.env.ABLO_VERBOSE === '1');
  const json = opts.json ?? (process.argv.includes('--json') || process.env.ABLO_JSON === '1');

  // Machine mode: the envelope itself, one line, nothing else. `toAbloError`
  // coerces a plain throw so even an untyped failure arrives as the same
  // shape; the message survives (this is local output, not the wire, so
  // nothing needs masking).
  if (json) {
    line(JSON.stringify(toAbloError(err).toJSON()));
    process.exitCode = 1;
    return;
  }

  if (err instanceof AbloError) {
    const codeTag = err.code ? `  ${pc.dim(`[${err.code}]`)}` : '';
    line('');
    line(`  ${brand('ablo')} ${pc.red('✗')} ${pc.bold(titleForType(err.type))}${codeTag}`);
    line('');
    // A message that explains a remedy earns more than one sentence, so
    // paragraphs are honoured rather than run together, and each is wrapped to
    // the block's measure instead of being left to the terminal.
    for (const paragraph of err.message.split('\n')) {
      if (paragraph === '') line('');
      else for (const wrapped of wrapParagraph(paragraph, '    ')) line(wrapped);
    }
    // The labelled fields are a block of their own, not a fourth paragraph —
    // buffer them so a blank line separates them from the prose, and so an
    // error with nothing to label doesn't end on a stray gap.
    const fields: string[] = [];
    const field = (s: string) => fields.push(s);
    if (err.param) field(`    ${pc.dim('field')}  ${err.param}`);
    renderKnownDetails(err.details, field);
    const hint = err.code ? RECOVERY_HINT[classifyRecovery(err.code)] : undefined;
    if (hint) field(`    ${pc.dim(hint)}`);
    if (err.docUrl) field(`    ${pc.dim('docs')}   ${err.docUrl}`);
    if (err.requestId) field(`    ${pc.dim('ref')}    ${err.requestId}`);
    if (fields.length > 0) {
      line('');
      for (const f of fields) line(f);
    }
    if (verbose) {
      if (err.details && Object.keys(err.details).length > 0) {
        line(`    ${pc.dim('details')} ${JSON.stringify(err.details)}`);
      }
      if (err.stack) line(pc.dim(err.stack));
    }
    line('');
    process.exitCode = 1;
    return;
  }

  // Non-Ablo error: a single line + a verbose escape hatch — never a raw dump.
  const message = err instanceof Error ? err.message : String(err);
  line('');
  line(`  ${brand('ablo')} ${pc.red('✗')} ${message}`);
  if (verbose && err instanceof Error && err.stack) line(pc.dim(err.stack));
  else line(`    ${pc.dim('Run with --verbose for the full error.')}`);
  line('');
  process.exitCode = 1;
}
