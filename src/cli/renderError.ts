/**
 * The single CLI error renderer — every command and the top-level catch route
 * failures through here so the terminal shows a clean, structured block instead
 * of `console.error(err)`'s wall of text (stack + every enumerable field).
 *
 * Grounded in the error-DX research (docs/plans aside): clig.dev (clear title,
 * cause, next-step, no stack by default, a verbose escape hatch), Stripe's
 * code+doc_url model, and miette's titled diagnostics. It reads the fields the
 * `AbloError` already carries (`code`, `message`, `param`, `docUrl`,
 * `requestId`, `details`) — the data was always structured; only the final
 * render threw it away.
 *
 *   ✗ Validation error  [model_required_field_missing]
 *
 *     A required field was absent from the model payload.
 *     field  task.title
 *     docs   https://docs.abloatai.com/errors#model_required_field_missing
 *     ref    req_abc123
 */

import pc from 'picocolors';

import { AbloError, classifyRecovery } from '../errors.js';
import { brand } from './theme.js';

export interface RenderErrorOptions {
  /** Show the stack + raw details. Defaults to `--verbose`/`ABLO_VERBOSE=1`. */
  readonly verbose?: boolean;
  /** Output sink — defaults to `console.error`. Injectable for tests. */
  readonly write?: (line: string) => void;
}

/** A one-line, recovery-class hint appended under the message when useful. */
const RECOVERY_HINT: Readonly<Record<string, string>> = {
  transient: 'This looks transient — retry in a moment.',
  permission: "Your key isn't allowed to do this — check its scopes or role.",
  session_expiry: 'Your session expired — sign in again.',
  access_credential_expiry: 'Your access credential expired — refresh it and retry.',
  auth_blocked: 'Authentication was blocked.',
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
 * Render a few high-value, well-known detail keys compactly — NOT the whole
 * `details` object (that dump is the anti-pattern). Unknown details surface only
 * under `--verbose`.
 */
function renderKnownDetails(
  details: Readonly<Record<string, unknown>> | undefined,
  line: (s: string) => void,
): void {
  if (!details) return;
  const { retryAfterSeconds, missingIds, requiredCapability, unexecutable, errors } = details;
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
  const line = opts.write ?? ((l: string) => console.error(l));
  const verbose =
    opts.verbose ?? (process.argv.includes('--verbose') || process.env.ABLO_VERBOSE === '1');

  if (err instanceof AbloError) {
    const codeTag = err.code ? `  ${pc.dim(`[${err.code}]`)}` : '';
    line('');
    line(`  ${brand('ablo')} ${pc.red('✗')} ${pc.bold(titleForType(err.type))}${codeTag}`);
    line('');
    line(`    ${err.message}`);
    if (err.param) line(`    ${pc.dim('field')}  ${err.param}`);
    renderKnownDetails(err.details, line);
    const hint = err.code ? RECOVERY_HINT[classifyRecovery(err.code)] : undefined;
    if (hint) line(`    ${pc.dim(hint)}`);
    if (err.docUrl) line(`    ${pc.dim('docs')}   ${err.docUrl}`);
    if (err.requestId) line(`    ${pc.dim('ref')}    ${err.requestId}`);
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
