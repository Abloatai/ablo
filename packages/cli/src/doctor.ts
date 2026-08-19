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
import {
  resolveRuntimeApiKey,
  resolveRuntimeApiKeyReadOnly,
  getActiveProject,
  getActiveProjectReadOnly,
} from './config';
import { resolveTarget, type ResolvedTarget } from './target';
import {
  fetchRoutingState,
  fetchPushedSchema,
  readLocalSchemaHash,
  schemaDrift,
  blockers,
  detectPoolerIn,
  fetchDeliveryState,
  WRITE_READY_VERDICT,
  type DataSourceState,
  type DeliveryState,
  type PushedSchema,
  type SchemaDrift,
} from './readiness';

/** `ok` passed, `fail` is a real problem, `skip` could not be determined. */
export type DoctorCheckState = 'ok' | 'fail' | 'skip';

export interface DoctorCheck {
  readonly label: string;
  readonly state: DoctorCheckState;
  /** What was found, in a few words. */
  readonly detail: string;
  /** The next command or change, when there is one to give. */
  readonly fix?: string;
}

/**
 * The three answers a run can end on.
 *
 * `unverified` is the one worth having. A check that could not be run is not a
 * check that passed, and collapsing the two is how a setup gate reports success
 * over a question nobody answered. The engine's own readiness surface already
 * keeps `unknown` separate from healthy; this carries that distinction all the
 * way out to the exit code.
 */
export type DoctorVerdict = 'ready' | 'blocked' | 'unverified';

/**
 * Classify a run. Pure, so the rule that a skipped check is not a passed one
 * can be pinned by a test rather than inferred from a rendered page.
 */
export function doctorVerdict(counts: {
  readonly blockers: number;
  readonly failed: number;
  readonly skipped: number;
}): DoctorVerdict {
  if (counts.blockers > 0 || counts.failed > 0) return 'blocked';
  return counts.skipped > 0 ? 'unverified' : 'ready';
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  readonly blockers: ReturnType<typeof blockers>;
  readonly reachable: boolean;
  readonly hasKey: boolean;
  readonly failed: number;
  readonly skipped: number;
  readonly ready: boolean;
  readonly target: ResolvedTarget | null;
  readonly dataSource: DataSourceState;
  readonly pushedSchema: PushedSchema | null;
  readonly schemaDrift: SchemaDrift | null;
  readonly delivery: DeliveryState;
  readonly verdict: DoctorVerdict;
}

export interface InspectDoctorOptions {
  /** Never persist legacy config migrations while collecting the verdict. */
  readonly readOnlyConfig?: boolean;
  /** Explicit schema path for callers inspecting a repository other than cwd. */
  readonly schemaPath?: string;
  /** Directory used for project-local credential resolution. */
  readonly cwd?: string;
  /** Disable runtime importing of the user's schema for bounded discovery. */
  readonly readLocalSchema?: boolean;
}

function render(check: DoctorCheck): void {
  const mark =
    check.state === 'ok' ? pc.green('✓') : check.state === 'fail' ? pc.red('✗') : pc.dim('–');
  console.log(
    `  ${mark} ${check.label.padEnd(10)} ${check.state === 'fail' ? check.detail : pc.dim(check.detail)}`
  );
  if (check.fix) console.log(`    ${' '.repeat(11)}${pc.dim(`→ ${check.fix}`)}`);
}

/** The counted window as a reader says it, from whatever the server reported. */
function windowWords(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return hours === 1 ? 'the last hour' : `the last ${hours} hours`;
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes === 1 ? 'the last minute' : `the last ${minutes} minutes`;
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

/** Collect the complete doctor verdict without rendering or changing process state. */
export async function inspectDoctor(options: InspectDoctorOptions = {}): Promise<DoctorReport> {
  const apiUrl = apiBaseUrl();
  const runtimeKey = options.readOnlyConfig
    ? resolveRuntimeApiKeyReadOnly(undefined, options.cwd)
    : resolveRuntimeApiKey();
  const checks: DoctorCheck[] = [];

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
        readOnlyConfig: options.readOnlyConfig,
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
    const local = options.readOnlyConfig ? getActiveProjectReadOnly() : getActiveProject();
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
      detail: 'this branch is not connected to a database — writes are held',
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

  const drift = schemaDrift(
    options.readLocalSchema === false ? null : await readLocalSchemaHash(options.schemaPath),
    pushed?.hash,
  );
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

  // 7. Whether the writes that landed were told to anyone. Every check above
  //    this one asks whether something is configured; this asks what happened
  //    to the recent window of changes, which is the question the others were all
  //    green through. A delta the engine could not route is excluded from
  //    delivery and counted there — so a write confirms, the row appears in
  //    Postgres, and no subscriber is ever told.
  const delivery = reachable
    ? await fetchDeliveryState(apiUrl, runtimeKey.key)
    : ({ kind: 'unknown', detail: 'unreachable' } as const);
  if (delivery.kind === 'known') {
    const when = windowWords(delivery.window_seconds);
    checks.push(
      delivery.unroutable > 0
        ? delivery.unroutable === delivery.recorded
          ? {
              // Nothing at all was routable. One bad row does not look like
              // this, so the cause is the plane rather than the rows: reporting
              // it as "N of N" would send the reader hunting for the N.
              label: 'delivery',
              state: 'fail',
              detail: `no change reached anyone (${delivery.recorded} in ${when})`,
              fix: 'run `ablo check`. When nothing routes, the tenancy value is usually missing for the whole plane rather than for particular rows.',
            }
          : {
              label: 'delivery',
              state: 'fail',
              detail:
                `${delivery.unroutable} of ${delivery.recorded} change${delivery.recorded === 1 ? '' : 's'} in ${when} reached nobody` +
                (delivery.sample ? ` (e.g. ${delivery.sample.model}/${delivery.sample.id})` : ''),
              fix: 'run `ablo check`. Rows written to Postgres outside Ablo carry no tenancy value, so nothing can route the change.',
            }
        : {
            label: 'delivery',
            state: 'ok',
            detail:
              delivery.recorded === 0
                ? `no changes in ${when}`
                : `${delivery.recorded} change${delivery.recorded === 1 ? '' : 's'} in ${when}, all deliverable`,
          }
    );
  } else {
    checks.push({ label: 'delivery', state: 'skip', detail: `not determined (${delivery.detail})` });
  }

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

  return {
    checks,
    blockers: blocking,
    reachable,
    hasKey: Boolean(runtimeKey.key),
    failed,
    skipped,
    ready: blocking.length === 0 && failed === 0,
    target,
    dataSource,
    pushedSchema: pushed,
    schemaDrift: drift,
    delivery,
    verdict: doctorVerdict({ blockers: blocking.length, failed, skipped }),
  };
}

/** Render a previously collected report. Kept separate for setup and CI consumers. */
export function renderDoctorReport(report: DoctorReport): void {
  console.log(`\n  ${brand('ablo')} ${pc.dim('doctor')}\n`);
  for (const check of report.checks) render(check);

  console.log();
  if (report.failed > 0) {
    console.log(
      `  ${pc.red('✗')} ${pc.bold(`${report.failed} problem${report.failed === 1 ? '' : 's'}`)}` +
        pc.dim(report.skipped > 0 ? `, ${report.skipped} check${report.skipped === 1 ? '' : 's'} skipped` : '')
    );
    console.log(
      pc.dim('    Fix them in the order above — an earlier one often explains a later one.')
    );
  } else if (report.skipped > 0) {
    console.log(
      `  ${pc.yellow('?')} ${pc.dim(`nothing found a problem, but ${report.skipped} check${report.skipped === 1 ? '' : 's'} could not be run. This is not a clean bill of health.`)}`
    );
  } else {
    console.log(
      `  ${pc.green('✓')} ${pc.dim(WRITE_READY_VERDICT)}`
    );
  }
  console.log();
}

/**
 * The report as data — `ablo doctor --json`, or `ABLO_JSON=1`.
 *
 * The command that explains why a write is blocked was the one command an agent
 * could not read: every other verb here answers `--json`, and this one rendered
 * to a terminal only. So the agent that hit the failure had to parse colour
 * codes or ask a human what the terminal said.
 *
 * A projection of {@link DoctorReport}, not a second shape. `verdict` is the
 * whole page in one field and matches the exit code exactly, so a caller can
 * branch on either.
 */
function doctorReportAsJson(report: DoctorReport): string {
  return JSON.stringify(
    {
      object: 'doctor_report',
      verdict: report.verdict,
      checks: report.checks,
      blockers: report.blockers,
    },
    null,
    2,
  );
}

export async function doctor(argv: readonly string[] = []): Promise<void> {
  const report = await inspectDoctor();
  if (argv.includes('--json') || process.env.ABLO_JSON === '1') {
    console.log(doctorReportAsJson(report));
  } else {
    renderDoctorReport(report);
  }
  // A check that could not be run is not a check that passed. Exiting zero on
  // one is how a setup gate reports success over a question nobody answered,
  // which is the failure this command exists to end.
  if (report.verdict !== 'ready') process.exitCode = 1;
}
