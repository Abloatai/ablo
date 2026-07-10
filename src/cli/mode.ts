/**
 * `ablo mode [sandbox|production]` switches the active environment.
 *
 * The active environment decides which stored key other commands use — `ablo
 * push`, and the SDK when it resolves `ABLO_API_KEY`. Sandbox holds disposable
 * data; production is your live environment. `ablo dev` always runs against
 * sandbox regardless of this setting. Called with no argument, the command shows
 * an interactive picker listing both environments, which one is current, and
 * whether each has a key stored.
 */

import pc from 'picocolors';
import { select, isCancel, cancel } from '@clack/prompts';
import { getMode, setMode, getKeyEntry, normalizeMode, type Mode } from './config';

/** The key prefix that logging in mints for each environment. Sandbox gets a
 *  full secret key, since its data is disposable; production gets a restricted,
 *  observe-only key by default. A deliberate production write uses a secret
 *  `sk_live_` key from the dashboard instead. */
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
