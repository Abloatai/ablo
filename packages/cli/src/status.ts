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
  type ActiveProject,
} from './config';
import { resolveTarget, describeMismatches, type ResolvedTarget } from './target';
import { credentialCapability } from './credentialCapability';
import { brand } from './theme';
import { apiBaseUrl } from './push';
import { participantKindSchema } from '@ablo/transaction/coordination/schema';
import {
  fetchRoutingState,
  fetchPushedSchema,
  detectPoolerIn,
  readLocalSchemaHash,
  schemaDrift,
  blockers,
  type PushedModel,
} from './readiness';

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

/** Compact `{user:overwrite,agent:reject}` (or '' when default). */
function formatConflict(conflict: PushedModel['conflict']): string {
  if (!conflict) return '';
  const parts = participantKindSchema.options
    .flatMap((k) => (conflict[k] ? [`${k}:${conflict[k]}`] : []));
  return parts.length ? `{${parts.join(',')}}` : '';
}

/**
 * The "where does a push land" block: the server-confirmed org, project, and
 * environment the key resolves to, plus any divergence from the local
 * preferences. When the server couldn't confirm — offline, an older server, or
 * a credential with no such scope — it shows the local `ablo projects use`
 * selection marked `unconfirmed`, so the uncertainty is visible rather than
 * presented as fact. This is the line that makes "what project am I in?" a
 * glance instead of a guess.
 */
function printTargetLines(
  target: ResolvedTarget | null,
  localProject: ActiveProject | undefined,
  /** The org the stored key was minted for — the fallback when the server did
   *  not confirm one. */
  storedOrganizationId: string | undefined,
): void {
  const confirmed = target?.confirmed ?? null;

  // Always name the organization. `default` exists in every org, so a project
  // line alone cannot tell two orgs apart — which is exactly how a key from
  // one org reads as a familiar setup from another. Printing it only when the
  // server confirmed one hid it precisely when an env key overrode the stored
  // login, the case where it matters most.
  const org = confirmed?.organizationId ?? storedOrganizationId;
  if (org) {
    const suffix = confirmed?.organizationId ? '' : ` ${pc.yellow('(unconfirmed)')}`;
    console.log(`  ${pc.dim('org')}     ${pc.dim(org)}${suffix}`);
  } else {
    console.log(
      `  ${pc.dim('org')}     ${pc.yellow('unknown')} ${pc.dim('(the server did not confirm one for this key)')}`,
    );
  }

  let projectLine: string;
  if (confirmed?.project) {
    const p = confirmed.project;
    projectLine = p.isDefault
      ? `${pc.bold('default')} ${pc.dim('(org-default)')}`
      : `${pc.bold(p.slug)} ${pc.dim(`(${p.id})`)}`;
  } else if (confirmed) {
    // Identity resolved but carried no project (human session / older server).
    projectLine = `${pc.bold('default')} ${pc.dim('(org-default)')}`;
  } else if (localProject) {
    projectLine = `${pc.bold(localProject.slug)} ${pc.dim(`(${localProject.id})`)} ${pc.yellow('(unconfirmed)')}`;
  } else {
    projectLine = `${pc.bold('default')} ${target ? pc.yellow('(unconfirmed)') : pc.dim('(org-default)')}`;
  }
  console.log(`  ${pc.dim('project')} ${projectLine}`);

  // The environment the key actually deploys to (from the server, else the key
  // prefix) — which can differ from the CLI `mode` shown above. Labelled `acts
  // on` rather than `env`: `mode` and `env` read as peers and are not, one being
  // the setting you chose and the other what your credential actually reaches,
  // and nothing in the two words said which was which.
  const env = confirmed?.environment ?? target?.keyEnv ?? null;
  if (env) {
    const suffix = confirmed ? '' : ` ${pc.yellow('(unconfirmed)')}`;
    console.log(`  ${pc.dim('acts on')} ${pc.bold(env)}${suffix}`);
  }

  // Divergence between local selection and the confirmed plane — one calm
  // note; the target table above already states what this key acts on.
  const divergence = describeMismatches(target?.mismatches ?? []);
  // Indented under the row it qualifies, like the capability note below `push`.
  // At the label column it reads as another field and breaks the alignment the
  // block is for; hanging off `acts on` says which line it is about.
  if (divergence) console.log(`    ${pc.yellow(`⚠ ${divergence}`)}`);
}

export async function status(args: string[] = []): Promise<void> {
  const apiUrl = apiBaseUrl();
  const cfg = readConfig();
  const mode = getMode();

  // The shared credential chain (env → .env.local → .env → stored), the same key
  // `ablo push` and `ablo dev` present — so status never reports a different
  // credential than a deploy would use.
  const effective = resolveEffectiveApiKey();
  // The server-confirmed plane this key acts on (org, project, environment),
  // reconciled against the local `ablo projects use` / `ablo mode` preferences.
  // Resolved once, shared by both the human and JSON views. Null when there's no
  // key to resolve; `.confirmed` is null when the server couldn't answer.
  const target: ResolvedTarget | null = effective.key
    ? await resolveTarget({ url: apiUrl, apiKey: effective.key, keySource: effective.source ?? 'stored' })
    : null;

  // Machine-readable output — `ablo status --json`. This is the supported way
  // for scripts and agents to read status, rather than parsing the human output.
  // In-process consumers should prefer `ablo.organizationId` on the client after
  // `ready()`.
  if (args.includes('--json')) {
    const entry = getKeyEntry(mode);
    const key = describeEffectiveKey(mode, process.env.ABLO_API_KEY, entry);
    const plan = resolvePushPlan();
    const activeProject = getActiveProject();
    const pushed = await fetchPushedSchema(apiUrl, effective.key);
    const reachableForJson = await ping(apiUrl);
    const dataSource = reachableForJson
      ? (await fetchRoutingState(apiUrl, effective.key)).source
      : ({ kind: 'unknown', detail: 'unreachable' } as const);
    const driftForJson = schemaDrift(await readLocalSchemaHash(), pushed?.hash);
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
        // What this credential can do. A pipeline that pushes can read it before
        // running the push, rather than learning from the 403 — the same fact
        // the human output prints, from the same place.
        kind: credentialCapability(effective.key).kind,
      },
      keyPrefix: key.keyPrefix,
      keySource: key.keySource,
      keyMode: key.keyMode,
      storedKeyPrefix: key.storedKeyPrefix,
      keyMatchesActiveMode: key.keyMatchesActiveMode,
      keyMatchesStoredActiveKey: key.keyMatchesStoredActiveKey,
      keyMismatch: key.keyMismatch,
      organizationId: entry?.organizationId ?? null,
      // The SERVER-CONFIRMED plane this key resolves to — the authoritative
      // answer to "where does a push land", independent of the local
      // `project`/`mode` preferences above. Null when the server didn't answer.
      confirmedTarget: target?.confirmed
        ? {
            organizationId: target.confirmed.organizationId,
            environment: target.confirmed.environment,
            project: target.confirmed.project,
            projectId: target.confirmed.projectId,
            sandboxId: target.confirmed.sandboxId,
          }
        : null,
      // Divergences between local intent and the confirmed plane (project not
      // selected, mode not the key's environment). Empty when aligned.
      mismatches: target?.mismatches ?? [],
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
            hash: pushed.hash ?? null,
            pushedAt: pushed.pushedAt ?? null,
            models: pushed.models,
          }
        : null,
      apiUrl,
      reachable: reachableForJson,
      // What this plane has connected, and whether anything stands between this
      // setup and a successful write. `blockers` empty is the machine-readable
      // form of the human verdict: a caller can gate on it in CI rather than
      // discovering the same facts from a failed request later.
      dataSource,
      drift: driftForJson,
      blockers: blockers({
        reachable: reachableForJson,
        hasKey: Boolean(effective.key),
        dataSource,
        schemaPushed: Boolean(pushed?.active),
        drift: driftForJson,
      }),
    };
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log(`\n  ${brand('ablo')} ${pc.dim('status')}\n`);

  // An explicit key (an env var or a project env file) overrides the stored
  // login key; when that happens, say so, with its source.
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
    console.log(`    ${pc.yellow(`! ${key.keyMismatch.message}`)}`);
  }

  // Where a push actually lands — the server-confirmed org, project, and
  // environment the key resolves to. Falls back to the local `ablo projects
  // use` preference (marked unconfirmed) only when the server didn't answer.
  const activeProject = getActiveProject();
  printTargetLines(target, activeProject, activeEntry?.organizationId);

  // The stored pair. Each row carries what its key can DO, not just its prefix:
  // `ablo login` stores an observe-only production key on purpose, and a reader
  // who cannot see that from the inventory discovers it from a failed deploy.
  for (const m of ['sandbox', 'production'] as Mode[]) {
    const entry = getKeyEntry(m);
    const marker = m === mode ? pc.green('●') : pc.dim('○');
    if (entry) {
      // Capability first, then expiry, joined the way `ablo logs` joins a line's
      // fields — what the key can do outranks how long it lasts.
      const facts = [
        credentialCapability(entry.apiKey).label,
        entry.expiresAt ? expiryLabel(entry.expiresAt) : '',
      ].filter(Boolean);
      const trail = facts.length ? ` ${pc.dim('·')} ${facts.join(pc.dim(' · '))}` : '';
      console.log(
        `  ${marker} ${m.padEnd(10)}  ${pc.dim(`${entry.apiKey.slice(0, 12)}…`)}${trail}`,
      );
    } else {
      console.log(`  ${marker} ${m.padEnd(10)}  ${pc.dim('— no key')}`);
    }
  }

  // Which credential `ablo push` would present, and to which environment —
  // the diagnostic for "push demanded sk_test_ but I have a live key".
  const plan = resolvePushPlan();
  console.log(
    `  ${pc.dim('push')}    ${plan.apiKey ? `${pc.bold(plan.flow)} ${pc.dim(`with ${plan.apiKey.slice(0, 12)}… (${plan.source})`)}` : `${pc.bold(plan.flow)} ${pc.yellow('— no credential')} ${pc.dim(`(run ${pc.bold('ablo login')} or set ${pc.bold('ABLO_API_KEY')})`)}`}`,
  );

  // Directly under the push line, because that is the line it qualifies: this
  // is the state where the push returns 403, and the 403 used to be the first
  // notice of it.
  const capability = credentialCapability(effective.key);
  if (capability.note) console.log(`    ${pc.dim(capability.note)}`);

  process.stdout.write(`  ${pc.dim('api')}     ${apiUrl}  `);
  const reachable = await ping(apiUrl);
  console.log(reachable ? pc.green('reachable') : pc.red('unreachable'));

  // What the plane has connected. Asked directly rather than inferred from a
  // read: reads can route while writes are held, so a read probe stays silent
  // in exactly the state that refuses every write.
  const introspectKey = effective.key;
  const { source: dataSource, validation } = reachable
    ? await fetchRoutingState(apiUrl, introspectKey)
    : { source: { kind: 'unknown', detail: 'unreachable' } as const, validation: null };
  if (dataSource.kind === 'connected') {
    const how = [...new Set(dataSource.connections)].join(' + ');
    const pooled = detectPoolerIn(dataSource.hosts);
    const unreachable = validation && !validation.ok ? validation.message : undefined;
    console.log(`  ${pc.dim('data')}    ${pc.green('✓')} ${pc.dim(`database connected to this plane (${how})`)}`);
    // A pooled host is registered but cannot carry replication, and refuses in
    // the words of a wrong password — worth naming before it is blamed on one.
    if (pooled) {
      console.log(
        `          ${pc.yellow('⚠')} ${pc.dim(
          `${pooled.host} is a connection pooler` +
            (pooled.direct ? `; register the direct host instead: ${pooled.direct}` : '; register the direct host instead'),
        )}`,
      );
    }
    if (unreachable) {
      console.log(`          ${pc.red('✗')} ${pc.dim(`Ablo could not reach it — ${unreachable}`)}`);
    }
  } else if (dataSource.kind === 'none') {
    console.log(
      `  ${pc.dim('data')}    ${pc.red('✗ no database connected to this plane')} ${pc.dim('— writes are held')}`,
    );
  } else if (reachable) {
    console.log(`  ${pc.dim('data')}    ${pc.yellow('?')} ${pc.dim(`could not read the plane's databases (${dataSource.detail})`)}`);
  }

  // The pushed schema is the one fact that explains most write failures: a
  // model's wire typename (what the engine routes on) can diverge from the
  // schema key the local code addresses. Surface it so a collision is obvious
  // before debugging a single write. Best-effort — silent if the server can't
  // be reached or is too old to answer.
  const pushed = reachable ? await fetchPushedSchema(apiUrl, introspectKey) : null;
  if (reachable) {
    if (pushed?.active) {
      const when = pushed.pushedAt ? ` ${pc.dim(`@ ${pushed.pushedAt.slice(0, 10)}`)}` : '';
      const ver = pushed.version != null ? ` ${pc.dim(`(rev ${pushed.version})`)}` : '';
      // The deployed hash — the exact value a running client's drift warning
      // reports as `serverSchemaHash`, so the two can be matched at a glance.
      const hashLabel = pushed.hash ? ` ${pc.dim(`hash ${pushed.hash}`)}` : '';
      console.log(`  ${pc.dim('schema')}  ${pc.bold(`${pushed.models.length} models pushed`)}${ver}${hashLabel}${when}`);
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

  // Drift: the schema this tree would push against the one the server runs. A
  // client built on the local one is rejected at connect time, which used to
  // surface only as a paragraph in a browser console at runtime.
  const drift = schemaDrift(await readLocalSchemaHash(), pushed?.hash);
  if (drift) {
    console.log(
      `  ${pc.dim('drift')}   ${pc.red('✗ local schema differs from the server')} ` +
        pc.dim(`(local ${drift.local}, server ${drift.server})`),
    );
  }

  // The bottom line. `status` previously reported each fact and left the reader
  // to conclude; every fact could read as fine while nothing could be written.
  // It now states whether a write would succeed, because that is the question
  // being asked.
  const found = blockers({
    reachable,
    hasKey: Boolean(effective.key),
    dataSource,
    schemaPushed: Boolean(pushed?.active),
    drift,
  });
  console.log();
  if (found.length > 0) {
    console.log(`  ${pc.red('✗')} ${pc.bold('writes would fail right now')}`);
    for (const b of found) {
      console.log(`    ${pc.dim('·')} ${b.problem}`);
      console.log(`      ${pc.dim(b.fix)}`);
    }
  } else if (dataSource.kind === 'unknown') {
    console.log(
      `  ${pc.yellow('?')} ${pc.dim("nothing is blocking a write, but this key could not read the plane's databases — some checks were skipped")}`,
    );
  } else {
    console.log(`  ${pc.green('✓')} ${pc.dim('ready — a write should succeed')}`);
  }

  console.log();
}
