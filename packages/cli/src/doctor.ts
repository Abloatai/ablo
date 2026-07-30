/**
 * `ablo doctor` — every check at once, so a broken setup costs one command
 * rather than one restart per problem.
 *
 * The problems this reports were always discoverable, but only one at a time
 * and only at runtime: an invalid key surfaced on the first request, the
 * project scope on the first read, the missing database on the first write,
 * schema drift on the next connect. Each one cost an edit, a restart, a sign-in,
 * and a look at the browser console — and revealed exactly one more. Five
 * problems took five rounds because nothing ever asked all five questions.
 *
 * So this asks all of them and prints the whole answer. It shares its facts with
 * `ablo status` (see readiness.ts) rather than forming a second opinion, and it
 * exits non-zero when something blocks a write, which makes it usable as a
 * setup gate in CI.
 */

import pc from 'picocolors';
import { brand } from './theme';
import { apiBaseUrl } from './controlPlane';
import { resolveRuntimeApiKey, getActiveProject } from './config';
import { resolveTarget } from './target';
import {
  fetchRoutingState,
  fetchPushedSchema,
  readLocalSchemaHash,
  schemaDrift,
  blockers,
  detectPoolerIn,
} from './readiness';

/** `ok` passed, `fail` is a real problem, `skip` could not be determined. */
type CheckState = 'ok' | 'fail' | 'skip';

interface Check {
  readonly label: string;
  readonly state: CheckState;
  /** What was found, in a few words. */
  readonly detail: string;
  /** The next command or change, when there is one to give. */
  readonly fix?: string;
}

function render(check: Check): void {
  const mark =
    check.state === 'ok' ? pc.green('✓') : check.state === 'fail' ? pc.red('✗') : pc.dim('–');
  console.log(
    `  ${mark} ${check.label.padEnd(10)} ${check.state === 'fail' ? check.detail : pc.dim(check.detail)}`
  );
  if (check.fix) console.log(`    ${' '.repeat(11)}${pc.dim(`→ ${check.fix}`)}`);
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

export async function doctor(): Promise<void> {
  console.log(`\n  ${brand('ablo')} ${pc.dim('doctor')}\n`);

  const apiUrl = apiBaseUrl();
  const runtimeKey = resolveRuntimeApiKey();
  const checks: Check[] = [];

  // 1. A credential, and where it came from — the answer to most "it worked
  //    yesterday" reports, since a project env file silently outranks the login.
  if (runtimeKey.key) {
    checks.push({
      label: 'key',
      state: 'ok',
      detail: `${runtimeKey.key.slice(0, 12)}… from ${runtimeKey.source}`,
    });
  } else {
    checks.push({
      label: 'key',
      state: 'fail',
      detail: 'no API key resolved',
      fix: 'run `ablo login`, or set ABLO_API_KEY',
    });
  }

  // 2. Reachability, before anything that would be read from the server.
  const reachable = await ping(apiUrl);
  checks.push(
    reachable
      ? { label: 'api', state: 'ok', detail: `${apiUrl} reachable` }
      : {
          label: 'api',
          state: 'fail',
          detail: `${apiUrl} unreachable`,
          fix: 'check your connection, then re-run `ablo doctor`',
        }
  );

  // 3. Who the key actually is. Naming the org and project is what separates
  //    "my setup is broken" from "I am signed in somewhere else" — `default`
  //    exists in every organization, so the project alone cannot tell them apart.
  const target = runtimeKey.key
    ? await resolveTarget({
        url: apiUrl,
        apiKey: runtimeKey.key,
        keySource: runtimeKey.source ?? 'stored',
      })
    : null;
  const confirmed = target?.confirmed ?? null;
  if (confirmed) {
    // An unnamed project holds its id in `slug` (the project list did not
    // answer), so `slug (id)` would print the id twice and read as a project
    // named after itself. Say what could not be read instead — this is the
    // command someone runs when something is already wrong.
    const project = confirmed.project
      ? confirmed.project.isDefault
        ? 'default'
        : confirmed.project.name === null
          ? `${confirmed.project.id} (unnamed — ${confirmed.project.unnamedReason ?? 'the project list did not answer'})`
          : `${confirmed.project.slug} (${confirmed.project.id})`
      : 'default';
    checks.push({
      label: 'identity',
      state: 'ok',
      detail: `org ${confirmed.organizationId}, project ${project}, ${confirmed.environment ?? 'unknown environment'}`,
    });
  } else {
    const local = getActiveProject();
    checks.push({
      label: 'identity',
      state: runtimeKey.key && reachable ? 'fail' : 'skip',
      detail: runtimeKey.key
        ? `the server did not resolve this key${local ? ` (locally selected: ${local.slug})` : ''}`
        : 'no key to resolve',
      fix: runtimeKey.key
        ? 'check the key is valid and not expired — `ablo login` mints a fresh pair'
        : undefined,
    });
  }

  // 4. The plane's database. A plane with none HOLDS writes rather than failing
  //    them, which is why this never surfaced as an error worth searching for.
  //    One call answers both "is anything connected" and "can Ablo reach it",
  //    so the two rows below can never contradict each other.
  const { source: dataSource, validation } = reachable
    ? await fetchRoutingState(apiUrl, runtimeKey.key)
    : { source: { kind: 'unknown', detail: 'unreachable' } as const, validation: null };
  if (dataSource.kind === 'connected') {
    const how = [...new Set(dataSource.connections)].join(' + ');
    const pooled = detectPoolerIn(dataSource.hosts);
    checks.push(
      pooled
        ? {
            label: 'data',
            state: 'fail',
            detail: `connected through a pooler (${pooled.host})`,
            fix: pooled.direct
              ? `re-register with the direct host: ${pooled.direct}`
              : 're-register with the direct database host, not the pooled one',
          }
        : { label: 'data', state: 'ok', detail: `database connected (${how})` }
    );
  } else if (dataSource.kind === 'none') {
    checks.push({
      label: 'data',
      state: 'fail',
      detail: 'no database connected to this plane — writes are held',
      fix: 'connect one with `ablo connect apply`',
    });
  } else {
    checks.push({ label: 'data', state: 'skip', detail: `not determined (${dataSource.detail})` });
  }

  // 5. The schema the server runs, and whether this tree agrees with it.
  const pushed = reachable ? await fetchPushedSchema(apiUrl, runtimeKey.key) : null;
  checks.push(
    pushed?.active
      ? {
          label: 'schema',
          state: 'ok',
          detail: `${pushed.models.length} models active${pushed.hash ? `, hash ${pushed.hash}` : ''}`,
        }
      : reachable && runtimeKey.key
        ? {
            label: 'schema',
            state: 'fail',
            detail: 'none active for this key',
            fix: 'run `ablo push`',
          }
        : { label: 'schema', state: 'skip', detail: 'not determined' }
  );

  const drift = schemaDrift(await readLocalSchemaHash(), pushed?.hash);
  if (drift) {
    checks.push({
      label: 'drift',
      state: 'fail',
      detail: `local ${drift.local} ≠ server ${drift.server}`,
      fix: 'run `ablo push` to deploy this tree, or check out the revision the server has',
    });
  }

  // 6. Whether Ablo's own network can reach the connected database. Asked from
  //    the engine, not from here: replication runs there, and a database can be
  //    perfectly reachable for it while every local dial fails.
  if (dataSource.kind === 'connected' && validation) {
    checks.push(
      validation.ok
        ? validation.ready
          ? {
              label: 'database',
              state: 'ok',
              detail: 'reachable from Ablo, and ready to replicate',
            }
          : validation.initialSnapshot?.status === 'loading' && validation.failures.length === 0
            ? {
                label: 'database',
                state: 'fail',
                detail: 'reachable; rows that predate the connection are still loading',
                fix: 'wait a moment and rerun `ablo doctor` — Ablo snapshots them automatically; do not update every row or write a manual backfill',
              }
            : validation.initialSnapshot?.status === 'retrying' &&
                validation.failures.length === 0
              ? {
                  label: 'database',
                  state: 'fail',
                  detail: `the initial row load is retrying${validation.initialSnapshot.detail ? ` — ${validation.initialSnapshot.detail}` : ''}`,
                  fix: 'fix the reported connection or database issue, then rerun `ablo doctor`; no row-touch backfill is needed',
                }
            : {
                label: 'database',
                state: 'fail',
                detail: `reachable, but not ready (${validation.failures.length} check${validation.failures.length === 1 ? '' : 's'} failing)`,
                fix: 'run `ablo connect check` for the full readiness list',
              }
        : {
            label: 'database',
            state: 'fail',
            detail: validation.message,
            fix: 'run `ablo connect check` for the full readiness list',
          }
    );
  } else {
    checks.push({ label: 'database', state: 'skip', detail: 'nothing connected to check' });
  }

  for (const check of checks) render(check);

  // The verdict comes from the same classifier `ablo status` closes with, so
  // the two commands can never disagree about whether a write would land.
  const blocking = blockers({
    reachable,
    hasKey: Boolean(runtimeKey.key),
    dataSource,
    schemaPushed: Boolean(pushed?.active),
    drift,
  });
  const failed = checks.filter((c) => c.state === 'fail').length;
  const skipped = checks.filter((c) => c.state === 'skip').length;

  console.log();
  if (failed > 0) {
    console.log(
      `  ${pc.red('✗')} ${pc.bold(`${failed} problem${failed === 1 ? '' : 's'}`)}` +
        pc.dim(skipped > 0 ? `, ${skipped} check${skipped === 1 ? '' : 's'} skipped` : '')
    );
    console.log(
      pc.dim('    Fix them in the order above — an earlier one often explains a later one.')
    );
  } else if (skipped > 0) {
    console.log(
      `  ${pc.yellow('?')} ${pc.dim(`nothing is blocking a write, but ${skipped} check${skipped === 1 ? '' : 's'} could not be run`)}`
    );
  } else {
    console.log(
      `  ${pc.green('✓')} ${pc.dim('write infrastructure is ready — your database constraints and row-level policies still apply')}`
    );
  }
  console.log();

  if (blocking.length > 0 || failed > 0) process.exitCode = 1;
}
