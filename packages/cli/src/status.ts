/**
 * `ablo status` — a one-glance orientation command. It answers who you are
 * authenticated as, which immutable branch the credential targets, which API
 * key is in play and whether it has expired, and whether
 * the server is reachable — so you can see your setup at a glance instead of
 * inferring it from a failed request.
 */

import pc from 'picocolors';
import {
  readConfig,
  getMode,
  getKeyEntry,
  getManagementKeyEntry,
  resolveRuntimeApiKey,
  getActiveProject,
  type Mode,
  type ActiveProject,
} from './config';
import { resolveTarget, describeMismatches, type ResolvedTarget } from './target';
import { credentialCapability } from './credentialCapability';
import { brand } from './theme';
import { apiBaseUrl } from './controlPlane';
import {
  fetchRoutingState,
  fetchPushedSchema,
  detectPoolerIn,
  readLocalSchemaHash,
  schemaDrift,
  blockers,
  WRITE_READY_VERDICT,
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
  const t = setTimeout(() => {
    ctrl.abort();
  }, 3000);
  try {
    const res = await fetch(`${apiUrl}/api/health`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
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
  /** The stored org's slug, for prose. Only shown when it names the same org
   *  as the line being printed — an env key can resolve to a different org
   *  than the stored login, and the stored slug must not label that one. */
  storedOrganizationSlug?: string
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
    const slug = org === storedOrganizationId ? storedOrganizationSlug : undefined;
    const label = slug ? `${pc.bold(slug)} ${pc.dim(`(${org})`)}` : pc.dim(org);
    console.log(`  ${pc.dim('org')}     ${label}${suffix}`);
  } else {
    console.log(
      `  ${pc.dim('org')}     ${pc.yellow('unknown')} ${pc.dim('(the server did not confirm one for this key)')}`
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
  const branch = confirmed?.branchId ?? null;
  const env = confirmed?.environment ?? target?.keyEnv ?? null;
  if (branch) {
    const label = confirmed?.branchRoot ? 'production root' : `branch ${branch}`;
    console.log(`  ${pc.dim('acts on')} ${pc.bold(label)}`);
  } else if (env) {
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

  // Runtime diagnostics mirror the application's usual credential chain
  // (process env → .env.local → .env → stored). Mutations use the same key only
  // when the dotenv file is selected explicitly with --env-file.
  const runtimeKey = resolveRuntimeApiKey();
  // The server-confirmed target this key acts on (org, project, branch),
  // reconciled against the local project preference.
  // Resolved once, shared by both the human and JSON views. Null when there's no
  // key to resolve; `.confirmed` is null when the server couldn't answer.
  const target: ResolvedTarget | null = runtimeKey.key
    ? await resolveTarget({
        url: apiUrl,
        apiKey: runtimeKey.key,
        keySource: runtimeKey.source ?? 'stored',
      })
    : null;

  // Machine-readable output — `ablo status --json`. This is the supported way
  // for scripts and agents to read status, rather than parsing the human output.
  // In-process consumers should prefer `ablo.organizationId` on the client after
  // `ready()`.
  if (args.includes('--json')) {
    const entry = getKeyEntry(mode);
    const activeProject = getActiveProject();
    const pushed = await fetchPushedSchema(apiUrl, runtimeKey.key);
    const reachableForJson = await ping(apiUrl);
    const routingForJson = reachableForJson
      ? await fetchRoutingState(apiUrl, runtimeKey.key)
      : {
          source: { kind: 'unknown', detail: 'unreachable' } as const,
          validation: null,
        };
    const dataSource = routingForJson.source;
    const driftForJson = schemaDrift(await readLocalSchemaHash(), pushed?.hash);
    const out = {
      // The locally-active project (`ablo projects use`); null = org-default.
      project: activeProject ?? null,
      // The credential the CLI resolves for requests, with its source —
      // 'env' | '.env.local' | '.env' | 'stored'. Key confusion is a common
      // source of trouble, and the source is usually the answer.
      runtimeKey: {
        prefix: runtimeKey.key ? runtimeKey.key.slice(0, 12) : null,
        source: runtimeKey.source,
        // What this credential can do. A pipeline that pushes can read it before
        // running the push, rather than learning from the 403 — the same fact
        // the human output prints, from the same place.
        kind: credentialCapability(runtimeKey.key).kind,
      },
      organizationId: entry?.organizationId ?? null,
      // The SERVER-CONFIRMED plane this key resolves to — the authoritative
      // answer to "where does a push land", independent of the local
      // project preference above. Null when the server didn't answer.
      confirmedTarget: target?.confirmed
        ? {
            organizationId: target.confirmed.organizationId,
            project: target.confirmed.project,
            projectId: target.confirmed.projectId,
            branchId: target.confirmed.branchId,
            branchRoot: target.confirmed.branchRoot,
          }
        : null,
      // Divergence between local project intent and the confirmed target.
      mismatches: target?.mismatches ?? [],
      // The schema active for this key's branch — the typename and conflict
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
      // Existing rows are copied into Ablo automatically after a direct source
      // is connected. Agents can gate a read cutover on this field instead of
      // probing for one row or inventing a row-touch backfill.
      initialSnapshot:
        routingForJson.validation?.ok === true
          ? (routingForJson.validation.initialSnapshot ?? null)
          : null,
      drift: driftForJson,
      blockers: blockers({
        reachable: reachableForJson,
        hasKey: Boolean(runtimeKey.key),
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
  if (runtimeKey.key && runtimeKey.source && runtimeKey.source !== 'stored') {
    const label = runtimeKey.source === 'env' ? 'ABLO_API_KEY env' : runtimeKey.source;
    console.log(
      `  ${pc.dim('key')}     ${runtimeKey.key.slice(0, 12)}… ${pc.dim(`(${label} — overrides stored)`)}`
    );
  } else if (!cfg) {
    console.log(`  ${pc.yellow('!')} Not logged in — run ${pc.bold('ablo login')}.`);
  }

  const activeEntry = getKeyEntry(mode);
  // Where a push actually lands — the server-confirmed org, project, and
  // environment the key resolves to. Falls back to the local `ablo projects
  // use` preference (marked unconfirmed) only when the server didn't answer.
  const activeProject = getActiveProject();
  printTargetLines(
    target,
    activeProject,
    activeEntry?.organizationId,
    activeEntry?.organizationSlug
  );

  const management = getManagementKeyEntry();
  console.log(
    `  ${pc.dim('○')} ${'management'.padEnd(12)}  ${
      management
        ? pc.dim(
            `${management.apiKey.slice(0, 12)}…${management.expiresAt ? ` · ${expiryLabel(management.expiresAt)}` : ''}`
          )
        : pc.dim('— no key')
    }`
  );

  // Old credential-store slots remain visible only when populated, explicitly
  // labeled as legacy. Current runtime branch keys live in ABLO_API_KEY.
  for (const { key: m, label } of [
    { key: 'sandbox', label: 'legacy child' },
    { key: 'production', label: 'legacy root' },
  ] as const) {
    const entry = getKeyEntry(m as Mode);
    if (entry) {
      // Capability first, then expiry, joined the way `ablo logs` joins a line's
      // fields — what the key can do outranks how long it lasts.
      const facts = [
        credentialCapability(entry.apiKey).label,
        entry.expiresAt ? expiryLabel(entry.expiresAt) : '',
      ].filter(Boolean);
      const trail = facts.length ? ` ${pc.dim('·')} ${facts.join(pc.dim(' · '))}` : '';
      console.log(
        `  ${pc.dim('○')} ${label.padEnd(12)}  ${pc.dim(`${entry.apiKey.slice(0, 12)}…`)}${trail}`
      );
    }
  }

  // Which credential `ablo push` would present. The destination comes from the
  // server-confirmed branch, never from the old local mode.
  const pushBranch =
    target?.confirmed?.branchRoot === true
      ? 'production root'
      : target?.confirmed?.branchId
        ? `branch ${target.confirmed.branchId}`
        : runtimeKey.key
          ? 'unknown branch'
          : 'no branch';
  console.log(
    `  ${pc.dim('push')}    ${
      runtimeKey.key
        ? `${pc.bold(pushBranch)} ${pc.dim(`with ${runtimeKey.key.slice(0, 12)}… (${runtimeKey.source})`)}`
        : `${pc.bold(pushBranch)} ${pc.yellow('— no runtime key')} ${pc.dim(`(set ${pc.bold('ABLO_API_KEY')} or run ${pc.bold('ablo dev')})`)}`
    }`
  );

  // Directly under the push line, because that is the line it qualifies: this
  // is the state where the push returns 403, and the 403 used to be the first
  // notice of it.
  const capability = credentialCapability(runtimeKey.key);
  if (capability.note) console.log(`    ${pc.dim(capability.note)}`);

  process.stdout.write(`  ${pc.dim('api')}     ${apiUrl}  `);
  const reachable = await ping(apiUrl);
  console.log(reachable ? pc.green('reachable') : pc.red('unreachable'));

  // What the plane has connected. Asked directly rather than inferred from a
  // read: reads can route while writes are held, so a read probe stays silent
  // in exactly the state that refuses every write.
  const introspectKey = runtimeKey.key;
  const { source: dataSource, validation } = reachable
    ? await fetchRoutingState(apiUrl, introspectKey)
    : { source: { kind: 'unknown', detail: 'unreachable' } as const, validation: null };
  if (dataSource.kind === 'connected') {
    const how = [...new Set(dataSource.connections)].join(' + ');
    const pooled = detectPoolerIn(dataSource.hosts);
    const unreachable = validation && !validation.ok ? validation.message : undefined;
    console.log(
      `  ${pc.dim('data')}    ${pc.green('✓')} ${pc.dim(`database connected to this plane (${how})`)}`
    );
    // A pooled host is registered but cannot carry replication, and refuses in
    // the words of a wrong password — worth naming before it is blamed on one.
    if (pooled) {
      console.log(
        `          ${pc.yellow('⚠')} ${pc.dim(
          `${pooled.host} is a connection pooler` +
            (pooled.direct
              ? `; register the direct host instead: ${pooled.direct}`
              : '; register the direct host instead')
        )}`
      );
    }
    if (unreachable) {
      console.log(`          ${pc.red('✗')} ${pc.dim(`Ablo could not reach it — ${unreachable}`)}`);
    }
    if (validation?.ok && validation.initialSnapshot?.status === 'loading') {
      console.log(
        `          ${pc.yellow('◌')} ${pc.dim(
          `loading rows that predate the connection — automatic; check with ${pc.bold('ablo connect check')}`
        )}`
      );
    } else if (validation?.ok && validation.initialSnapshot?.status === 'retrying') {
      console.log(
        `          ${pc.red('✗')} ${pc.dim(
          `loading existing rows is retrying${validation.initialSnapshot.detail ? ` — ${validation.initialSnapshot.detail}` : ''}`
        )}`
      );
    }
  } else if (dataSource.kind === 'none') {
    console.log(
      `  ${pc.dim('data')}    ${pc.red('✗ this branch is not connected to a database')} ${pc.dim('— writes are held')}`
    );
  } else if (reachable) {
    console.log(
      `  ${pc.dim('data')}    ${pc.yellow('?')} ${pc.dim(`could not read this branch's database connection (${dataSource.detail})`)}`
    );
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
      console.log(
        `  ${pc.dim('schema')}  ${pc.bold(`${pushed.models.length} models pushed`)}${ver}${hashLabel}${when}`
      );
      for (const m of pushed.models) {
        // Flag the divergence that bites: schema key ≠ wire typename.
        const tn =
          m.typename === m.key
            ? pc.dim(`typename=${m.typename}`)
            : pc.yellow(`typename=${m.typename}`);
        console.log(`          ${pc.dim('•')} ${m.key.padEnd(14)} ${tn}`);
      }
    } else if (pushed && !pushed.active) {
      console.log(
        `  ${pc.dim('schema')}  ${pc.yellow('none pushed')} ${pc.dim(`(run ${pc.bold('ablo push')} or ${pc.bold('ablo dev')})`)}`
      );
    }
  }

  // Drift: the schema this tree would push against the one the server runs. A
  // client built on the local one is rejected at connect time, which used to
  // surface only as a paragraph in a browser console at runtime.
  const drift = schemaDrift(await readLocalSchemaHash(), pushed?.hash);
  if (drift) {
    console.log(
      `  ${pc.dim('drift')}   ${pc.red('✗ local schema differs from the server')} ` +
        pc.dim(`(local ${drift.local}, server ${drift.server})`)
    );
  }

  // The bottom line. `status` previously reported each fact and left the reader
  // to conclude; every fact could read as fine while nothing could be written.
  // It now states whether a write would succeed, because that is the question
  // being asked.
  const found = blockers({
    reachable,
    hasKey: Boolean(runtimeKey.key),
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
      `  ${pc.yellow('?')} ${pc.dim("nothing is blocking a write, but this key could not read the branch's database connection — some checks were skipped")}`
    );
  } else {
    console.log(
      `  ${pc.green('✓')} ${pc.dim(WRITE_READY_VERDICT)}`
    );
  }

  console.log();
}
