/**
 * `ablo mode [test|live]` — the Stripe-style test/live toggle.
 *
 * Sets which stored key `ablo push` (and the SDK, via `ABLO_API_KEY`
 * resolution) uses. `ablo dev` is always test mode by design. With no argument,
 * a clack `select` shows both modes, which is current, and whether a key exists.
 */

import pc from 'picocolors';
import { select, isCancel, cancel } from '@clack/prompts';
import { getMode, setMode, getKeyEntry, type Mode } from './config';

function hintFor(m: Mode, current: Mode): string | undefined {
  const parts: string[] = [];
  if (m === current) parts.push('current');
  if (!getKeyEntry(m)) parts.push('no key');
  return parts.length ? parts.join(', ') : undefined;
}

function apply(m: Mode): void {
  setMode(m);
  console.log(`  ${pc.green('✓')} now in ${pc.bold(`${m} mode`)}`);
  if (!getKeyEntry(m)) {
    console.log(
      pc.dim(`  No ${m} key stored — run ${pc.bold('ablo login')} or ${pc.bold(`ablo login --api-key sk_${m}_…`)}.`),
    );
  }
}

export async function mode(argv: readonly string[]): Promise<void> {
  const arg = argv[0];
  if (arg === 'test' || arg === 'live') {
    apply(arg);
    return;
  }
  if (arg) {
    console.error(pc.red(`  unknown mode: ${arg}`) + pc.dim(` (expected ${pc.bold('test')} or ${pc.bold('live')})`));
    process.exit(1);
  }

  const current = getMode();
  // No TTY (agent / CI) → the interactive picker can't run. Require the explicit
  // argument instead of hanging on a prompt.
  if (!process.stdin.isTTY || process.env.CI) {
    console.error(
      pc.red('  `ablo mode` needs an argument without a TTY: ') +
        pc.bold('ablo mode test') + pc.dim(' | ') + pc.bold('ablo mode live') +
        pc.dim(`  (current: ${current})`),
    );
    process.exit(1);
  }
  const selected = await select({
    message: 'Active mode',
    initialValue: current,
    options: [
      { value: 'test' as const, label: 'Test mode', hint: hintFor('test', current) },
      { value: 'live' as const, label: 'Live mode', hint: hintFor('live', current) },
    ],
  });
  if (isCancel(selected)) {
    cancel('Cancelled.');
    process.exit(0);
  }
  apply(selected);
}
