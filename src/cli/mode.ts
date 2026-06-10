/**
 * `ablo mode [sandbox|production]` — the Stripe-style environment toggle.
 *
 * Sets which stored key `ablo push` (and the SDK, via `ABLO_API_KEY`
 * resolution) uses. `ablo dev` is always sandbox by design. With no argument,
 * a clack `select` shows both environments, which is current, and whether a
 * key exists. `test`/`live` are accepted as aliases of the pre-rename words.
 */

import pc from 'picocolors';
import { select, isCancel, cancel } from '@clack/prompts';
import { getMode, setMode, getKeyEntry, normalizeMode, type Mode } from './config';

/** The login-minted key prefix per environment. Sandbox gets a full secret
 *  key (disposable data); production gets a RESTRICTED key (observe-only —
 *  Stripe CLI model). Deliberate production acts use a dashboard `sk_live_`. */
const PREFIX: Record<Mode, string> = { sandbox: 'sk_test_', production: 'rk_live_' };

function hintFor(m: Mode, current: Mode): string | undefined {
  const parts: string[] = [];
  if (m === current) parts.push('current');
  if (!getKeyEntry(m)) parts.push('no key');
  return parts.length ? parts.join(', ') : undefined;
}

function apply(m: Mode): void {
  setMode(m);
  console.log(`  ${pc.green('✓')} now in ${pc.bold(m)}`);
  if (!getKeyEntry(m)) {
    console.log(
      pc.dim(`  No ${m} key stored — run ${pc.bold('ablo login')} or ${pc.bold(`ablo login --api-key ${PREFIX[m]}…`)}.`),
    );
  }
}

export async function mode(argv: readonly string[]): Promise<void> {
  const arg = argv[0];
  const normalized = normalizeMode(arg);
  if (normalized) {
    apply(normalized);
    return;
  }
  if (arg) {
    console.error(
      pc.red(`  unknown mode: ${arg}`) +
        pc.dim(` (expected ${pc.bold('sandbox')} or ${pc.bold('production')})`),
    );
    process.exit(1);
  }

  const current = getMode();
  // No TTY (agent / CI) → the interactive picker can't run. Require the explicit
  // argument instead of hanging on a prompt.
  if (!process.stdin.isTTY || process.env.CI) {
    console.error(
      pc.red('  `ablo mode` needs an argument without a TTY: ') +
        pc.bold('ablo mode sandbox') + pc.dim(' | ') + pc.bold('ablo mode production') +
        pc.dim(`  (current: ${current})`),
    );
    process.exit(1);
  }
  const selected = await select({
    message: 'Active environment',
    initialValue: current,
    options: [
      { value: 'sandbox' as const, label: 'Sandbox', hint: hintFor('sandbox', current) },
      { value: 'production' as const, label: 'Production', hint: hintFor('production', current) },
    ],
  });
  if (isCancel(selected)) {
    cancel('Cancelled.');
    process.exit(0);
  }
  apply(selected);
}
