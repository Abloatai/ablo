/**
 * `ablo status` — orientation, the way Stripe always shows account + mode.
 *
 * Answers "who am I, test or live, which key, is it expired, is the server
 * reachable" in one glance — so a dev never has to guess from a 403.
 */

import pc from 'picocolors';
import { readConfig, getMode, getKeyEntry, resolvePushPlan, getActiveProject, type Mode } from './config';
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

export async function status(args: string[] = []): Promise<void> {
  const apiUrl = (process.env.ABLO_API_URL ?? DEFAULT_URL).replace(/\/+$/, '');
  const cfg = readConfig();
  const mode = getMode();

  // Machine-readable mode — `ablo status --json`. Integrators and agents
  // previously regex-scraped the human output for the org id (the 2026-06-11
  // Pulse cascade); this is the supported surface. In-process consumers
  // should prefer `ablo.organizationId` on the client after `ready()`.
  if (args.includes('--json')) {
    const entry = getKeyEntry(mode);
    const plan = resolvePushPlan();
    const activeProject = getActiveProject();
    const out = {
      mode,
      // The locally-active project (`ablo projects use`); null = org-default.
      project: activeProject ?? null,
      keyPrefix: process.env.ABLO_API_KEY
        ? process.env.ABLO_API_KEY.slice(0, 12)
        : (entry?.apiKey.slice(0, 12) ?? null),
      keySource: process.env.ABLO_API_KEY ? 'env' : entry ? 'stored' : null,
      organizationId: entry?.organizationId ?? null,
      // What `ablo push` would do right now — the one-command answer to
      // "why did push demand a different key" (2026-06-11 live-key incident).
      push: {
        flow: plan.flow,
        keyPrefix: plan.apiKey?.slice(0, 12) ?? null,
        keySource: plan.source,
      },
      apiUrl,
      reachable: await ping(apiUrl),
    };
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log(`\n  ${brand('ablo')} ${pc.dim('status')}\n`);

  if (process.env.ABLO_API_KEY) {
    console.log(
      `  ${pc.dim('key')}     ${process.env.ABLO_API_KEY.slice(0, 12)}… ${pc.dim('(ABLO_API_KEY env — overrides stored)')}`,
    );
  } else if (!cfg) {
    console.log(`  ${pc.yellow('!')} Not logged in — run ${pc.bold('ablo login')}.`);
  }

  console.log(`  ${pc.dim('mode')}    ${pc.bold(mode)}`);
  const activeProject = getActiveProject();
  console.log(
    `  ${pc.dim('project')} ${activeProject ? `${pc.bold(activeProject.slug)} ${pc.dim(`(${activeProject.id})`)}` : pc.bold('default')}`,
  );

  for (const m of ['sandbox', 'production'] as Mode[]) {
    const entry = getKeyEntry(m);
    const marker = m === mode ? pc.green('●') : pc.dim('○');
    if (entry) {
      const exp = entry.expiresAt ? ` ${expiryLabel(entry.expiresAt)}` : '';
      console.log(`  ${marker} ${m.padEnd(10)}  ${pc.dim(`${entry.apiKey.slice(0, 12)}…`)}${exp}`);
    } else {
      console.log(`  ${marker} ${m.padEnd(10)}  ${pc.dim('— no key')}`);
    }
  }

  const org = getKeyEntry(mode)?.organizationId;
  if (org) console.log(`  ${pc.dim('org')}     ${org}`);

  // Which credential `ablo push` would present, and to which environment —
  // the diagnostic for "push demanded sk_test_ but I have a live key".
  const plan = resolvePushPlan();
  console.log(
    `  ${pc.dim('push')}    ${plan.apiKey ? `${pc.bold(plan.flow)} ${pc.dim(`with ${plan.apiKey.slice(0, 12)}… (${plan.source})`)}` : `${pc.bold(plan.flow)} ${pc.yellow('— no credential')} ${pc.dim(`(run ${pc.bold('ablo login')} or set ${pc.bold('ABLO_API_KEY')})`)}`}`,
  );

  process.stdout.write(`  ${pc.dim('api')}     ${apiUrl}  `);
  console.log((await ping(apiUrl)) ? pc.green('reachable') : pc.red('unreachable'));
  console.log();
}
