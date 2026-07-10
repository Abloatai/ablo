/**
 * `ablo status` — a one-glance orientation command. It answers who you are
 * authenticated as, whether you are pointed at the sandbox or production
 * environment, which API key is in play and whether it has expired, and whether
 * the server is reachable — so you can see your setup at a glance instead of
 * inferring it from a failed request.
 */

import pc from 'picocolors';
import {
  readConfig,
  getMode,
  getKeyEntry,
  resolvePushPlan,
  resolveEffectiveApiKey,
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
  const t = setTimeout(() => { ctrl.abort(); }, 3000);
  try {
    const res = await fetch(`${apiUrl}/api/health`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/** A model as the server reports it active for this key — pairing the schema key
 *  your local code addresses with the wire typename the engine routes on. */
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
 * Fetch the schema currently active for this key's environment (`GET /api/schema`).
 * Best-effort: any failure — unreachable server, unauthorized key, or a server
 * too old to serve the route — returns null, so `status` falls back to its
 * shorter output rather than erroring. The key's scope determines which
 * environment is read; there is no environment argument to pass.
 */
async function fetchPushedSchema(apiUrl: string, apiKey: string | undefined): Promise<PushedSchema | null> {
  if (!apiKey) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => { ctrl.abort(); }, 3000);
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

/** The outcome of the data-plane probe. See {@link probeDataPlane}. */
type DataPlaneProbe =
  | { status: 'ok' }
  | { status: 'no_database' }
  | { status: 'intermittent'; ok: number; failed: number }
  | { status: 'forbidden'; detail?: string }
  | { status: 'unknown'; detail: string }
  | { status: 'skipped' };

/** One sample's outcome. `routed` means the request reached the customer's
 *  database (a missing row still counts); `no_route` means routing failed with
 *  `tenant_routing_failed` before any query ran. */
type Sample = 'routed' | 'no_route' | { forbidden: string | undefined } | { other: string };

async function sampleRead(apiUrl: string, apiKey: string, modelTypename: string, n: number): Promise<Sample> {
  const ctrl = new AbortController();
  const t = setTimeout(() => { ctrl.abort(); }, 4000);
  try {
    // A read by id for an id that does not exist. Routing to the customer's
    // database happens before the query runs, so `entity_not_found` (404) is
    // only reachable once routing has succeeded — a clean "the database
    // answered" signal — while `tenant_routing_failed` means routing itself
    // failed.
    const res = await fetch(
      `${apiUrl}/v1/models/${encodeURIComponent(modelTypename)}/__ablo_health_probe_${n}__`,
      { headers: { authorization: `Bearer ${apiKey}` }, signal: ctrl.signal },
    );
    if (res.ok) return 'routed';
    let code: string | undefined;
    try {
      const body = (await res.json()) as { code?: string; error?: { code?: string } };
      code = body.code ?? body.error?.code;
    } catch {
      /* non-JSON */
    }
    if (code === 'entity_not_found') return 'routed';
    if (code === 'tenant_routing_failed') return 'no_route';
    if (res.status === 401 || res.status === 403) return { forbidden: code };
    return { other: `${res.status}${code ? ` ${code}` : ''}` };
  } catch {
    return { other: 'unreachable' };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Probe the data plane, not just the control plane. On its own, `ablo status`
 * reports that the API is reachable and a schema is pushed — both control-plane
 * facts — and can look healthy while reads and writes fail because the
 * organization's database isn't routable (a redeploy dropped the registration,
 * or the key targets an organization that never registered one). The
 * registration can also be intermittent, which a single read can't detect, so
 * this samples a few times and reports the worst case. The gap then surfaces
 * here, with a fix, rather than as an opaque failure mid-operation.
 */
async function probeDataPlane(
  apiUrl: string,
  apiKey: string | undefined,
  modelTypename: string,
): Promise<DataPlaneProbe> {
  if (!apiKey) return { status: 'skipped' };
  const samples: Sample[] = [];
  for (let i = 0; i < 3; i++) samples.push(await sampleRead(apiUrl, apiKey, modelTypename, i));

  const forbidden = samples.find((s): s is { forbidden: string | undefined } => typeof s === 'object' && 'forbidden' in s);
  if (forbidden) return { status: 'forbidden', detail: forbidden.forbidden };
  const routed = samples.filter((s) => s === 'routed').length;
  const noRoute = samples.filter((s) => s === 'no_route').length;
  if (routed === samples.length) return { status: 'ok' };
  if (noRoute === samples.length) return { status: 'no_database' };
  if (routed > 0 && noRoute > 0) return { status: 'intermittent', ok: routed, failed: noRoute };
  const other = samples.find((s): s is { other: string } => typeof s === 'object' && 'other' in s);
  return { status: 'unknown', detail: other?.other ?? 'inconclusive' };
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

  // Machine-readable output — `ablo status --json`. This is the supported way
  // for scripts and agents to read status, rather than parsing the human output.
  // In-process consumers should prefer `ablo.organizationId` on the client after
  // `ready()`.
  if (args.includes('--json')) {
    const entry = getKeyEntry(mode);
    const key = describeEffectiveKey(mode, process.env.ABLO_API_KEY, entry);
    const plan = resolvePushPlan();
    const activeProject = getActiveProject();
    // The shared credential chain (env → .env.local → .env → stored), the same
    // key `ablo push` would present — so this diagnostic can never report a
    // different credential than a deploy uses.
    const effective = resolveEffectiveApiKey();
    const pushed = await fetchPushedSchema(apiUrl, effective.key);
    const out = {
      mode,
      // The locally-active project (`ablo projects use`); null = org-default.
      project: activeProject ?? null,
      // The credential the CLI resolves for requests, with its source —
      // 'env' | '.env.local' | '.env' | 'stored'. Key confusion is a common
      // source of trouble, and the source is usually the answer.
      effectiveKey: {
        prefix: effective.key ? effective.key.slice(0, 12) : null,
        source: effective.source,
      },
      keyPrefix: key.keyPrefix,
      keySource: key.keySource,
      keyMode: key.keyMode,
      storedKeyPrefix: key.storedKeyPrefix,
      keyMatchesActiveMode: key.keyMatchesActiveMode,
      keyMatchesStoredActiveKey: key.keyMatchesStoredActiveKey,
      keyMismatch: key.keyMismatch,
      organizationId: entry?.organizationId ?? null,
      // What `ablo push` would do right now — the answer to "why did push
      // demand a different key".
      push: {
        flow: plan.flow,
        keyPrefix: plan.apiKey?.slice(0, 12) ?? null,
        keySource: plan.source,
      },
      // The schema active for this key's environment — the typename and conflict
      // rules the engine enforces, which may differ from your local `schema.ts`.
      // null means the server did not answer (unreachable, too old, or no key).
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

  // The shared credential chain (env → .env.local → .env → stored), the same key
  // `push` and `dev` resolve — so status never reports a different credential than
  // a deploy would present. An explicit key (an env var or a project env file)
  // overrides the stored login key; when that happens, say so, with its source.
  const effective = resolveEffectiveApiKey();
  if (effective.key && effective.source && effective.source !== 'stored') {
    const label = effective.source === 'env' ? 'ABLO_API_KEY env' : effective.source;
    console.log(
      `  ${pc.dim('key')}     ${effective.key.slice(0, 12)}… ${pc.dim(`(${label} — overrides stored)`)}`,
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
    const introspectKey = effective.key;
    const pushed = await fetchPushedSchema(apiUrl, introspectKey);
    if (pushed?.active) {
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

    // Data-plane health — the check that catches a green status that is actually broken.
    const firstPushedModel = pushed?.active ? pushed.models[0] : undefined;
    if (firstPushedModel !== undefined) {
      const probe = await probeDataPlane(apiUrl, introspectKey, firstPushedModel.typename);
      // Deliberately no green "healthy" line. This probe carries only the API
      // key, so it can resolve a different tenant than the typed SDK does (the
      // SDK's identity also carries project and sandbox), which makes an apparent
      // "ok" here not trustworthy enough to reassure. The probe only warns: it
      // speaks when it catches a definite failure and stays silent otherwise.
      if (probe.status === 'no_database') {
        console.log(`  ${pc.dim('data')}    ${pc.red('✗ no database registered')}${org ? pc.dim(` for org ${org}`) : ''}`);
        console.log(
          `          ${pc.dim(
            `reads/writes will fail with ${pc.bold('tenant_routing_failed')}. Connect one with ` +
              `${pc.bold('ablo connect')}, or point ${pc.bold('ABLO_API_KEY')} at an org that has a database.`,
          )}`,
        );
      } else if (probe.status === 'intermittent') {
        console.log(`  ${pc.dim('data')}    ${pc.red(`✗ database routing is intermittent`)} ${pc.dim(`(${probe.ok} ok / ${probe.failed} failed of ${probe.ok + probe.failed})`)}${org ? pc.dim(` for org ${org}`) : ''}`);
        console.log(
          `          ${pc.dim(
            `some reads/writes fail with ${pc.bold('tenant_routing_failed')} — the registration is unstable. ` +
              `Re-establish it with ${pc.bold('ablo connect')} (or check for a recent server redeploy).`,
          )}`,
        );
      } else if (probe.status === 'forbidden') {
        console.log(`  ${pc.dim('data')}    ${pc.yellow('? key not authorized to read')}${probe.detail ? pc.dim(` (${probe.detail})`) : ''}`);
      } else if (probe.status === 'unknown') {
        console.log(`  ${pc.dim('data')}    ${pc.yellow(`? data-plane check inconclusive (${probe.detail})`)}`);
      }
    }
  }

  console.log();
}
