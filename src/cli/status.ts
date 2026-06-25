/**
 * `ablo status` — orientation, the way Stripe always shows account + mode.
 *
 * Answers "who am I, sandbox or production, which key, is it expired, is the
 * server reachable" in one glance — so a dev never has to guess from a 403.
 */

import pc from 'picocolors';
import {
  readConfig,
  getMode,
  getKeyEntry,
  resolvePushPlan,
  getActiveProject,
  describeEffectiveKey,
  type Mode,
} from './config';
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

/** A model as the server reports it active on this plane — the schema key the
 *  local code addresses vs. the wire typename the engine actually routes on. */
interface PushedModel {
  key: string;
  typename: string;
  conflict: { user?: string; agent?: string; system?: string } | null;
}
interface PushedSchema {
  active: boolean;
  version?: number;
  pushedAt?: string | null;
  models: PushedModel[];
}

/**
 * Fetch the schema CURRENTLY ACTIVE on the key's plane (`GET /api/schema`).
 * Best-effort: any failure (unreachable, unauthorized, old server without the
 * route) returns null so `status` degrades to its pre-schema output rather than
 * erroring. The key's scope decides the plane — never passed by hand.
 */
async function fetchPushedSchema(apiUrl: string, apiKey: string | undefined): Promise<PushedSchema | null> {
  if (!apiKey) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(`${apiUrl}/api/schema`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as PushedSchema;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Compact `{user:overwrite,agent:reject}` (or '' when default). */
function formatConflict(conflict: PushedModel['conflict']): string {
  if (!conflict) return '';
  const parts = (['user', 'agent', 'system'] as const)
    .flatMap((k) => (conflict[k] ? [`${k}:${conflict[k]}`] : []));
  return parts.length ? `{${parts.join(',')}}` : '';
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
    const key = describeEffectiveKey(mode, process.env.ABLO_API_KEY, entry);
    const plan = resolvePushPlan();
    const activeProject = getActiveProject();
    const introspectKey = process.env.ABLO_API_KEY ?? entry?.apiKey;
    const pushed = await fetchPushedSchema(apiUrl, introspectKey);
    const out = {
      mode,
      // The locally-active project (`ablo projects use`); null = org-default.
      project: activeProject ?? null,
      keyPrefix: key.keyPrefix,
      keySource: key.keySource,
      keyMode: key.keyMode,
      storedKeyPrefix: key.storedKeyPrefix,
      keyMatchesActiveMode: key.keyMatchesActiveMode,
      keyMatchesStoredActiveKey: key.keyMatchesStoredActiveKey,
      keyMismatch: key.keyMismatch,
      organizationId: entry?.organizationId ?? null,
      // What `ablo push` would do right now — the one-command answer to
      // "why did push demand a different key" (2026-06-11 live-key incident).
      push: {
        flow: plan.flow,
        keyPrefix: plan.apiKey?.slice(0, 12) ?? null,
        keySource: plan.source,
      },
      // The schema ACTIVE on this key's plane — the typename/conflict the
      // engine enforces, which may differ from local `schema.ts`. null = the
      // server didn't answer (unreachable / old server / no key).
      schema: pushed
        ? {
            active: pushed.active,
            version: pushed.version ?? null,
            pushedAt: pushed.pushedAt ?? null,
            models: pushed.models,
          }
        : null,
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
  const activeEntry = getKeyEntry(mode);
  const key = describeEffectiveKey(mode, process.env.ABLO_API_KEY, activeEntry);
  if (key.keyMismatch) {
    console.log(`  ${pc.yellow('!')} ${pc.yellow(key.keyMismatch.message)}`);
  }
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

  const org = activeEntry?.organizationId;
  if (org) console.log(`  ${pc.dim('org')}     ${org}`);

  // Which credential `ablo push` would present, and to which environment —
  // the diagnostic for "push demanded sk_test_ but I have a live key".
  const plan = resolvePushPlan();
  console.log(
    `  ${pc.dim('push')}    ${plan.apiKey ? `${pc.bold(plan.flow)} ${pc.dim(`with ${plan.apiKey.slice(0, 12)}… (${plan.source})`)}` : `${pc.bold(plan.flow)} ${pc.yellow('— no credential')} ${pc.dim(`(run ${pc.bold('ablo login')} or set ${pc.bold('ABLO_API_KEY')})`)}`}`,
  );

  process.stdout.write(`  ${pc.dim('api')}     ${apiUrl}  `);
  const reachable = await ping(apiUrl);
  console.log(reachable ? pc.green('reachable') : pc.red('unreachable'));

  // The pushed schema is the one fact that explains most write failures: a
  // model's wire typename (what the engine routes on) can diverge from the
  // schema key the local code addresses. Surface it so a collision is obvious
  // before debugging a single write. Best-effort — silent if the server can't
  // be reached or is too old to answer.
  if (reachable) {
    const introspectKey = process.env.ABLO_API_KEY ?? activeEntry?.apiKey;
    const pushed = await fetchPushedSchema(apiUrl, introspectKey);
    if (pushed && pushed.active) {
      const when = pushed.pushedAt ? ` ${pc.dim(`@ ${pushed.pushedAt.slice(0, 10)}`)}` : '';
      const ver = pushed.version != null ? ` ${pc.dim(`(rev ${pushed.version})`)}` : '';
      console.log(`  ${pc.dim('schema')}  ${pc.bold(`${pushed.models.length} models pushed`)}${ver}${when}`);
      for (const m of pushed.models) {
        // Flag the divergence that bites: schema key ≠ wire typename.
        const tn =
          m.typename === m.key
            ? pc.dim(`typename=${m.typename}`)
            : pc.yellow(`typename=${m.typename}`);
        const conflict = formatConflict(m.conflict);
        const conflictStr = conflict ? `  ${pc.dim(`conflict=${conflict}`)}` : '';
        console.log(`          ${pc.dim('•')} ${m.key.padEnd(14)} ${tn}${conflictStr}`);
      }
    } else if (pushed && !pushed.active) {
      console.log(`  ${pc.dim('schema')}  ${pc.yellow('none pushed')} ${pc.dim(`(run ${pc.bold('ablo push')} or ${pc.bold('ablo dev')})`)}`);
    }
  }

  console.log();
}
