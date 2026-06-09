/**
 * `ablo status` — orientation, the way Stripe always shows account + mode.
 *
 * Answers "who am I, test or live, which key, is it expired, is the server
 * reachable" in one glance — so a dev never has to guess from a 403.
 */

import pc from 'picocolors';
import { readConfig, getMode, getKeyEntry, type Mode } from './config';
import { brand } from './theme';
import { DEFAULT_URL } from './push';

function expiryLabel(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms)) return '';
  if (ms <= 0) return pc.red('expired');
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  return pc.dim(days > 0 ? `expires in ${days}d` : 'expires <1d');
}

async function ping(apiUrl: string): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(`${apiUrl}/api/health`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export async function status(): Promise<void> {
  const apiUrl = (process.env.ABLO_API_URL ?? DEFAULT_URL).replace(/\/+$/, '');
  const cfg = readConfig();
  const mode = getMode();

  console.log(`\n  ${brand('ablo')} ${pc.dim('status')}\n`);

  if (process.env.ABLO_API_KEY) {
    console.log(
      `  ${pc.dim('key')}     ${process.env.ABLO_API_KEY.slice(0, 12)}… ${pc.dim('(ABLO_API_KEY env — overrides stored)')}`,
    );
  } else if (!cfg) {
    console.log(`  ${pc.yellow('!')} Not logged in — run ${pc.bold('ablo login')}.`);
  }

  console.log(`  ${pc.dim('mode')}    ${pc.bold(mode)}`);

  for (const m of ['test', 'live'] as Mode[]) {
    const entry = getKeyEntry(m);
    const marker = m === mode ? pc.green('●') : pc.dim('○');
    if (entry) {
      const exp = entry.expiresAt ? ` ${expiryLabel(entry.expiresAt)}` : '';
      console.log(`  ${marker} ${m.padEnd(4)}  ${pc.dim(`${entry.apiKey.slice(0, 12)}…`)}${exp}`);
    } else {
      console.log(`  ${marker} ${m.padEnd(4)}  ${pc.dim('— no key')}`);
    }
  }

  const org = getKeyEntry(mode)?.organizationId;
  if (org) console.log(`  ${pc.dim('org')}     ${org}`);

  process.stdout.write(`  ${pc.dim('api')}     ${apiUrl}  `);
  console.log((await ping(apiUrl)) ? pc.green('reachable') : pc.red('unreachable'));
  console.log();
}
