/**
 * `ablo connect apply` (and `rotate`) — the COMMAND: resolve the credential,
 * take the preflight reads, show the plan, apply it, verify it, register it.
 *
 * The orchestration only. What the run would execute and how it reads lives in
 * `connectPlan.ts`; the reads it takes before writing anything, and the
 * decisions resting on them, live in `connectPreflight.ts`. This file is the
 * order those happen in and what the operator is told at each point.
 *
 * Two principles shape it:
 *
 *   1. It reads like a plain-language plan, not SQL. The confirmation shows what
 *      Ablo will set up in ordinary words; the exact statements are available on
 *      request (`--show-sql`) rather than shown by default, because raw DDL reads
 *      as risky even when every statement is safe and reversible.
 *   2. Nothing is registered that has not been proved. The admin credential is
 *      used once and discarded, both scoped roles are dialled back and checked,
 *      and a run that cannot succeed exits non-zero rather than handing Ablo a
 *      credential the database will refuse.
 */

import pc from 'picocolors';
import postgres from 'postgres';
import { confirm, isCancel } from '@clack/prompts';
import {
  AbloAuthenticationError,
  AbloConnectionError,
  AbloValidationError,
} from '@abloatai/transaction/errors';
import { footprintNamesFor } from '@abloatai/transaction/footprint';
import {
  ABLO_PUBLICATION,
  ABLO_REPLICATION_ROLE,
  ABLO_WRITE_ROLE,
  probeReadiness,
  reconcilePublicationPlan,
  readPublicationState,
  registerDirectDataSource,
  type CheckItem,
  type PublicationState,
} from './connectSetup';
import {
  ledgerBlocker,
  publishedTableBlockers,
  ownershipRemediation,
  formatUnresolvedOwnership,
} from './connectOwnership';
import { probeDirectWriteReadiness, type ConnectArgs } from './connect';
import {
  detectPooler,
  detectProvider,
  logicalReplicationGuidance,
  replicationGrantRole,
} from './dbProvider';
import { generateRolePassword, rewriteDatabaseUrl, readProjectAdminDatabaseUrl } from './dbRole';
import { ambientEnvKeyNote, resolveMutationApiKey, resolveManagementKey } from './config';
import { fetchDataSourceState } from './readiness';
import { requestRemoteValidation } from './remoteValidation';
import {
  absentConnectionStatus,
  inspectRegisteredConnection,
  requestInitialSnapshot,
  type ConnectReconcileStatus,
} from './connect/index';
import { DEFAULT_SCHEMA_PATH } from './push';
import { apiBaseUrl } from './controlPlane';
import { brand } from './theme';
import { resolveTarget, describeMismatches } from './target';
import {
  connectApplyPlan,
  passwordClause,
  printPlan,
  type ApplyStep,
  type PasswordMode,
} from './connectPlan';
import {
  adminCanCreateRoles,
  currentWalLevel,
  presentRoles,
  probeAsRole,
  alreadyConnectedElsewhere,
  locateExistingConnection,
  reapplyBlocker,
  rotateWithoutConnection,
  schemaDeclaredTables,
  type AdminCapabilityRow,
} from './connectPreflight';

/**
 * The recovery instruction for a rotation that re-keyed the database but never
 * completed registration — whatever ended it (a registration refusal, a network
 * failure, or the operator cancelling mid-run). One constant so the failure
 * path and the interrupt path can never tell the operator two different
 * stories.
 */
export const ROTATE_STRANDED_CREDENTIALS_NOTICE =
  'The new passwords are set in your database, but Ablo could not be updated with them.\n' +
  'Ablo still holds the previous password, which no longer works — writes will fail until\n' +
  'you re-run `ablo connect rotate` (each run is idempotent and rotates a fresh password).';

/**
 * The exit code and, for `rotate`, the recovery notice after the registration
 * attempt. Rotation is the one flow where a registration failure *after* the
 * `ALTER ROLE` is dangerous: the database already holds the new password Ablo
 * doesn't have yet, so writes break until it's reconciled. We can't roll the
 * password back (the CLI connects as admin and never held the role's old one),
 * and we can't register-then-swap (Ablo validates a credential by connecting with
 * it, so it must exist in the database first). So the safe shape is to refuse a
 * success exit and tell the operator to re-run `rotate` — itself idempotent,
 * generating a fresh password each run. `apply` needs no such notice: a failed
 * first registration leaves nothing that was working broken.
 */
export function postRegistrationOutcome(input: {
  readonly rotating: boolean;
  readonly registered: boolean;
}): { readonly exitCode: 0 | 1; readonly notice: string | null } {
  if (input.registered) return { exitCode: 0, notice: null };
  if (!input.rotating) return { exitCode: 1, notice: null };
  return {
    exitCode: 1,
    notice: ROTATE_STRANDED_CREDENTIALS_NOTICE,
  };
}

interface PgErrorLike {
  readonly message?: string;
}

function emitReconcileStatus(status: ConnectReconcileStatus, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(status));
    return;
  }
  if (status.code === 'ready') {
    console.log(
      `  ${pc.green('✓')} Already ready — database, credentials, and snapshot are unchanged.\n`
    );
  } else if (status.code === 'loading') {
    console.log(
      `  ${pc.yellow('—')} Existing rows are loading; re-run the same command to poll readiness.\n`
    );
  } else {
    console.log(`  ${pc.yellow('—')} ${status.code}\n`);
  }
}

/** A statement that a managed provider refused because it wanted a plaintext password, not a verifier. */
function isPlaintextRefusal(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /plaintext password/i.test(message);
}

/**
 * Run every step against the admin connection. On self-hosted Postgres the
 * write-ahead-log step's `ALTER SYSTEM` is best-effort — a managed provider that
 * refuses it is not fatal here, because whether replication is actually ready is
 * decided by reading `wal_level`, not by whether this statement ran. A verifier
 * the provider rejects is retried once as plaintext over TLS, matching
 * {@link createScopedRole}.
 */
async function executePlan(
  sql: postgres.Sql,
  steps: readonly ApplyStep[],
  rebuildPlaintext: () => readonly ApplyStep[]
): Promise<void> {
  let plaintextSteps: readonly ApplyStep[] | null = null;
  for (const step of steps) {
    for (const statement of step.sql) {
      try {
        await sql.unsafe(statement);
      } catch (err) {
        if (step.key === 'wal') {
          // Best-effort: a provider that rejects ALTER SYSTEM changes nothing
          // here — readiness is judged by the wal_level read, not this statement.
          continue;
        }
        if (
          (step.key === 'replication-role' || step.key === 'write-role') &&
          isPlaintextRefusal(err)
        ) {
          plaintextSteps ??= rebuildPlaintext();
          const retry = plaintextSteps.find((s) => s.key === step.key);
          if (retry) {
            for (const alt of retry.sql) await sql.unsafe(alt);
            continue;
          }
        }
        throw err;
      }
    }
  }
}

/**
 * `ablo connect apply` (and `rotate`): create — or, for `rotate`, re-key —
 * the two scoped roles, the publication, and (where allowed) the logical-decoding
 * setting, then either preserve and reconcile the existing registration or
 * register both scoped connection strings with Ablo directly.
 *
 * The admin credential comes from `--url`, or `DATABASE_URL` as a fallback. It is
 * used on this machine only and is never persisted or sent anywhere. Nothing is
 * written to your `.env`: the generated role passwords go straight to Ablo's
 * control plane (encrypted) via registration, and your app keeps holding only
 * `ABLO_API_KEY`. That is what makes "registering the database is the whole
 * switch" literally true — and what keeps a replication-only credential from ever
 * landing in the generic `DATABASE_URL` your ORM reads.
 */
export async function runConnectApply(args: ConnectArgs): Promise<void> {
  const rotating = args.rotate;
  const verb = rotating ? 'connect rotate' : 'connect apply';

  let adminUrl = args.url ?? readProjectAdminDatabaseUrl();
  // Show which database we resolved, and how — the admin credential is used once
  // here and then discarded, so the operator should see exactly what it points at
  // before confirming. (When it came from DATABASE_URL, that's job 1: a one-time
  // admin input, not a credential Ablo keeps.)
  const adminSource = args.url ? '--url' : 'DATABASE_URL';
  let target = 'your database';
  try {
    if (!adminUrl) throw new Error('not resolved yet');
    const parsed = new URL(adminUrl);
    target = `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    /* keep the generic label if the URL doesn't parse */
  }

  // Registration needs the project key. Resolve it before touching the database,
  // so we never provision roles we then can't hand to Ablo.
  const apiKey = resolveMutationApiKey();
  if (!apiKey) {
    // `ablo login` stores a MANAGEMENT credential; registering a database needs
    // a branch-bound DATA key. Reporting "not logged in" when
    // a login is sitting on disk sends the reader back through the browser to
    // arrive exactly here again, which is the one instruction guaranteed not to
    // work. Tell them which credential is missing, not that they have none.
    const loggedIn = resolveManagementKey() !== undefined;
    const ambient = ambientEnvKeyNote();
    const retry = `npx ablo connect ${rotating ? 'rotate' : 'apply'} --env-file .env.local --yes`;
    throw new AbloAuthenticationError(
      loggedIn
        ? `You are logged in, but connect needs a branch-bound runtime key.\n\n` +
          `Logging in stores an mk_ management credential; it can manage branches but cannot read, write, or register a database. Set ABLO_API_KEY to the sk_ key for the exact branch this database should join. The server confirms whether that branch is the production root or a development child; the CLI does not infer it from the key spelling.` +
          `${ambient ? `\n\n${ambient}\n\nUse it explicitly with:\n  ${retry}` : ''}`
        : `Not logged in, and no ABLO_API_KEY is set. Run \`ablo login\` (or set ABLO_API_KEY) so Ablo knows which project to register this database for.${ambient ? `\n\n${ambient}` : ''}`,
      { code: 'cli_api_key_missing' }
    );
  }

  // An existing registration is not a reason to stop or rotate. Ask Ablo's
  // own network first: a healthy registration is a true no-op, a snapshot
  // interrupted after database repair resumes at the snapshot step, and only
  // actual database drift needs the transient owner URL below.
  const apiUrl = apiBaseUrl();
  const planeState = await fetchDataSourceState(apiUrl, apiKey);
  const existingRegistration =
    !rotating &&
    planeState.kind === 'connected' &&
    planeState.connections.includes('direct');
  let existingNeedsSnapshot = false;
  if (existingRegistration) {
    const inspected = inspectRegisteredConnection(
      await requestRemoteValidation({ apiUrl, apiKey }),
    );
    if (inspected.code === 'ready') {
      emitReconcileStatus(inspected, args.json);
      return;
    }
    if (inspected.code === 'loading') {
      emitReconcileStatus(inspected, args.json);
      return;
    }
    if (!inspected.needsDatabaseReconcile && inspected.needsSnapshotRequest) {
      const snapshot = await requestInitialSnapshot({ apiUrl, apiKey });
      const resumed: ConnectReconcileStatus = {
        ...inspected,
        code:
          snapshot.replication_slot?.released === false
            ? 'operator_action_required'
            : 'loading',
        steps: {
          ...inspected.steps,
          snapshot: snapshot.replication_slot?.released === false ? 'action_required' : 'loading',
          readiness: snapshot.replication_slot?.released === false ? 'action_required' : 'pending',
        },
        ...(snapshot.replication_slot?.released === false
          ? { detail: snapshot.replication_slot.detail ?? 'replication_slot_active' }
          : {}),
      };
      emitReconcileStatus(resumed, args.json);
      return;
    }
    if (inspected.code === 'operator_action_required') {
      throw new AbloConnectionError(
        `The registered source needs operator action before it can be reconciled (${inspected.detail ?? 'not ready'}).`,
        { code: 'cli_database_unreachable', details: { ...inspected } },
      );
    }
    existingNeedsSnapshot = inspected.needsSnapshotRequest;
  }

  if (!adminUrl) {
    throw new AbloValidationError(
      'This connection needs database reconciliation. Pass the transient owner connection with --url <admin-conn> (or set DATABASE_URL) and re-run the same `ablo connect apply` operation.',
      { code: 'cli_database_url_missing' }
    );
  }

  if (!args.json) {
    console.log(
      `\n  ${brand('ablo')} ${pc.dim(verb)}  ${pc.dim(rotating ? 're-key the scoped roles' : 'set up your database for Ablo')}\n`
    );
    console.log(
      `  ${pc.dim('→')} ${pc.bold(target)}${adminSource === 'DATABASE_URL' ? pc.dim('  (admin via DATABASE_URL)') : ''}\n`
    );
  }

  // Refuse a pooled host before provisioning rather than after. Roles created
  // through a pooler are real — it fronts the same database — but replication
  // cannot run over the session it terminates, so registration fails at the end
  // of a flow that has already asked for a confirmation and written two roles.
  // The detector lives in this file and was, until now, never consulted here.
  //
  // Only a NAMED pooled endpoint stops the run. A port match is a convention,
  // not a fact: a pooler is routinely moved off it and a Postgres routinely put
  // on it, so refusing there would block a working database with a confident
  // explanation and no way past. The hint is still worth saying out loud, since
  // the failure it predicts arrives disguised as a wrong password.
  const pooledAdmin = detectPooler(adminUrl);
  if (pooledAdmin?.confidence === 'host') {
    if (pooledAdmin.direct) {
      // Same database, same credential, the endpoint replication can actually
      // run over. The pooled URL stays right for the app runtime; refusing
      // here handed the reader a URL to copy back in by hand, when the run
      // already knew it.
      adminUrl = pooledAdmin.direct;
      const pooledLabel = target;
      try {
        const parsed = new URL(adminUrl);
        target = `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
      } catch {
        /* keep the previous label if the derived URL doesn't parse */
      }
      if (!args.json) console.log(
        `  ${pc.yellow('!')} ${pc.bold(pooledLabel)} is a connection pooler, so this run uses the direct host:\n` +
          `    ${pc.bold(target)}\n` +
          pc.dim(
            `    A pooler terminates the session, so replication cannot run over it. Your app\n` +
              `    keeps the pooled URL; the setup needs the database itself.\n`
          )
      );
    } else {
      console.error(
        `  ${pc.yellow('!')} ${pc.bold(target)} is a connection pooler, not the database.\n`
      );
      console.error(
        pc.dim(
          `    A pooler terminates the session, so replication cannot run over it. Setting up\n` +
            `    through it creates roles that Ablo then cannot use to stream.\n`
        )
      );
      console.error(`    Re-run against the direct database host, not the pooled one.\n`);
      process.exit(1);
    }
  }
  if (pooledAdmin?.confidence === 'port') {
    if (!args.json) console.log(
      `  ${pc.yellow('!')} Port ${pc.bold(new URL(adminUrl).port)} is the one a connection pooler usually answers on.\n` +
        pc.dim(
          `    Replication cannot run over a pooler, so if that is what this is, point ${pc.bold('--url')}\n` +
            `    at the database itself. Carrying on, since a database can use this port too.\n`
        )
    );
  }

  // `--tables` scopes the publication; absent it, every table is published, as
  // before. The schema is read for a different purpose: it names the tables Ablo
  // COORDINATES, which is what the readiness check should judge.
  //
  // Narrowing the publication by default was tried and reverted. It fixed the
  // right complaint — another tool's tables blocking a connect — by the wrong
  // mechanism, and bought a permanent one: an explicit membership list has to
  // track the schema forever, so every added model becomes a table that accepts
  // writes and never confirms them until someone reconciles it. On a database
  // with seventeen published tables and four declared models it also silently
  // dropped thirteen from replication. The complaint was never caused by
  // publishing those tables; it was caused by CHECKING them.
  // Which plane is this actually acting on? `push` has asked since it shipped;
  // `connect` never has, so a key from an ambient `.env.local` could target a
  // different project than the one selected and nothing said so. That silence
  // is expensive here: a deregister aimed at the wrong plane reports "no data
  // source" and reads as "nothing to disconnect", which sends the operator
  // looking for a problem that is not there. Same reconciliation `push` uses.
  const connectTarget = await resolveTarget({
    url: apiBaseUrl(),
    apiKey,
    keySource: 'env',
  }).catch(() => null);
  const mismatch = connectTarget ? describeMismatches(connectTarget.mismatches) : null;
  if (mismatch) {
    if (!args.json) console.log(`  ${pc.yellow('!')} ${mismatch}\n`);
  }

  const confirmed = connectTarget?.confirmed;
  if (!confirmed?.branchId) {
    throw new AbloConnectionError(
      'Ablo could not confirm the branch this key targets, so it cannot derive an isolated database footprint safely. Check the API URL/key and re-run.',
      { code: 'cli_database_unreachable' }
    );
  }
  const footprint = footprintNamesFor({
    organizationId: confirmed.organizationId,
    branchId: confirmed.branchId,
    ...(confirmed.projectId ? { projectId: confirmed.projectId } : {}),
  });
  const role = args.role === ABLO_REPLICATION_ROLE ? footprint.replicationRole : args.role;
  const writeRole = args.writeRole === ABLO_WRITE_ROLE ? footprint.writeRole : args.writeRole;
  const publication = footprint.publication;

  // Is this database already streaming to another plane? The registration guard
  // has always known, and only said so after a run had written two roles and a
  // publication. Asking first turns that into a refusal with nothing touched.
  const heldElsewhere = alreadyConnectedElsewhere(
    await locateExistingConnection({
      apiUrl: apiBaseUrl(),
      apiKey,
      connectionString: adminUrl,
      schema: args.schema,
    })
  );
  if (heldElsewhere) {
    console.error(`  ${pc.yellow('!')} ${heldElsewhere}\n`);
    console.error(
      pc.dim(`    Your database is untouched.\n`) +
        `  To move it here, disconnect it there first with ${pc.cyan('ablo connect deregister')}\n` +
        pc.dim(`  (run with a key for that plane). Match the project id to a name with `) +
        pc.bold('ablo projects list --json') +
        pc.dim('.') +
        '\n'
    );
    process.exit(1);
  }

  // A known ownership conflict is more fundamental than the local schema
  // selection: report it before asking the caller for tables. Both checks are
  // read-only, but only the conflict explains why this plane cannot proceed at
  // all. This also preserves the preflight guarantee for an empty project.
  const coordinatedTables = (await schemaDeclaredTables()) ?? [];
  const tables = args.tables.length > 0 ? args.tables : coordinatedTables;
  if (tables.length === 0) {
    throw new AbloValidationError(
      `No mapped tables were found for schema ${args.schema}. Push the Ablo schema first, or pass --tables a,b,c. A project binding must enumerate its own schema-qualified tables; it cannot publish every table in a shared database.`,
      { code: 'cli_invalid_arguments' }
    );
  }
  if (args.tables.length === 0) {
    if (!args.json) console.log(
      pc.dim(
        `  publishing the ${tables.length} table${tables.length === 1 ? '' : 's'} declared by your Ablo schema in ${pc.bold(args.schema)} ` +
          `(${pc.bold('--tables')} to override)\n`
      )
    );
  }

  // Rotate re-keys before it registers, so a rotate that cannot register strands
  // the database on a password Ablo never receives. Ask the control plane what
  // THIS plane holds first: nothing to re-key means the registration is a first
  // connect, and a first connect is what the one-database-one-branch rule
  // declines. See rotateWithoutConnection.
  // What this plane holds, for rotate's guard. The key-rejected arm refuses
  // HERE, before any dial: a key Ablo declines cannot be told a new password.
  // The nothing-to-re-key arm waits for step 1e, where the database has said
  // whether the scoped roles exist — a plane with no registration but the
  // roles present is the stranded state rotate exists to recover, and judging
  // it from the control plane alone built an apply↔rotate refusal loop.
  let rotatePlane: { planeHasConnection: boolean; known: boolean; keyRejected: boolean } | null =
    null;
  if (rotating) {
    const state = await fetchDataSourceState(apiBaseUrl(), apiKey).catch(
      (): { kind: 'unknown'; detail: string } => ({ kind: 'unknown', detail: 'unreachable' })
    );
    rotatePlane = {
      planeHasConnection: state.kind === 'connected',
      known: state.kind !== 'unknown',
      // 401/403 is Ablo answering and declining the key, not a network failure.
      keyRejected: state.kind === 'unknown' && /HTTP 40[13]/.test(state.detail),
    };
    if (rotatePlane.keyRejected) {
      const refusal = rotateWithoutConnection({ rotating, ...rotatePlane, existingRoles: [] });
      if (refusal) {
        console.error(`  ${pc.yellow('!')} ${refusal}\n`);
        console.error(pc.dim(`    Your database is untouched.\n`));
        process.exit(1);
      }
    }
  }

  // 1. Confirm the admin credential can actually create/alter roles.
  const admin = postgres(adminUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    onnotice: () => {
      // Swallow postgres NOTICE chatter (role already exists, etc.) — the plan narrates its own steps.
    },
  });
  let capability: AdminCapabilityRow | null;
  try {
    capability = await adminCanCreateRoles(admin);
  } catch (err) {
    await admin.end({ timeout: 2 }).catch(() => undefined);
    const pg = (err ?? {}) as PgErrorLike;
    throw new AbloConnectionError(`Couldn't connect: ${pg.message ?? String(err)}`, {
      code: 'cli_database_unreachable',
      details: { target },
      cause: err,
    });
  }
  if (!capability || !(capability.rolsuper || capability.rolcreaterole)) {
    await admin.end({ timeout: 2 });
    console.error(
      pc.red(`  ${capability?.rolname ?? 'This role'} can't create roles.`) +
        pc.dim(` Point ${pc.bold('--url')} at your owner/admin connection and re-run.`)
    );
    process.exit(1);
  }

  // 1b. Ownership preflight. The plan publishes and grants on your tables and the
  // idempotency ledger — operations Postgres reserves for each object's owner. When
  // a relation is owned by a role this admin reaches only through a non-inheriting
  // membership (the common managed-Postgres shape), apply grants the admin that
  // inheritance itself, as the first stage of the plan, so the run proceeds with no
  // manual step. Only ownership it genuinely can't take over stops the run.
  const ledger = await ledgerBlocker(admin, args.schema).catch(() => null);
  const foreignTables = await publishedTableBlockers(admin, tables, args.schema).catch(() => []);
  const { inheritGrants, unresolved } = ownershipRemediation(
    [...(ledger ? [ledger] : []), ...foreignTables],
    capability.rolname
  );
  if (unresolved.length > 0) {
    await admin.end({ timeout: 2 });
    console.error(formatUnresolvedOwnership(unresolved, capability.rolname, target));
    process.exit(1);
  }

  // 1c. Decide the write-ahead-log step from reality, not hope: read the current
  // wal_level (a SHOW every role can run) and identify the provider. When it is
  // already logical, the step drops out entirely; when it isn't, the plan and the
  // follow-up both speak the provider's language instead of printing an
  // ALTER SYSTEM that a managed host can't run.
  const provider = detectProvider(target);
  const walReady = (await currentWalLevel(admin)) === 'logical';

  // Rotation guards a LIVE source, so nothing may be re-keyed unless the run
  // can plausibly reach registration: a database that isn't sharing changes
  // would be re-keyed and then stopped at the readiness gate, stranding
  // credentials Ablo doesn't hold while the current ones still work. Refuse
  // up front instead — the database is untouched and writes keep flowing on
  // the existing password until this is fixed.
  if (rotating && !walReady) {
    await admin.end({ timeout: 2 });
    console.error(
      `  ${pc.yellow('!')} Your database isn't sharing changes with Ablo right now, so the roles were ${pc.bold('not')} re-keyed\n` +
        `    (re-keying here would break the working credentials before Ablo could take the new ones).\n` +
        `    ${logicalReplicationGuidance(provider)}.\n` +
        `\n  Then re-run:  ${pc.cyan(`npx ablo ${verb}`)}\n`
    );
    process.exit(1);
  }

  // 1d. Read the publication's live membership so the plan can reconcile it to
  // exactly `--tables`. A pre-existing publication from an earlier connect with a
  // different table set is the common cause of a "writer not ready" rejection: the
  // writer gets granted on the new tables while the publication still points at the
  // old ones. Reconciling keeps the two in step (see reconcilePublicationPlan).
  const existingPublication = await readPublicationState(admin, {
    schema: args.schema,
    publication,
  }).catch(
    (): PublicationState => ({ exists: false, allTables: false, tables: [] })
  );
  const pubReconcile = reconcilePublicationPlan(existingPublication, tables, {
    schema: args.schema,
    publication,
  });

  // 1e. The last read before anything is written: are the scoped roles already
  // here? `apply` creates roles and keeps an existing one's password, so it has
  // no new password to give Ablo for a role it finds. See reapplyBlocker.
  const existingRoles = await presentRoles(admin, [role, writeRole]).catch(() => []);
  if (existingRegistration && existingRoles.length !== 2) {
    await admin.end({ timeout: 2 });
    throw new AbloValidationError(
      `The registered source's scoped role pair is incomplete (${existingRoles.length}/2 present). Re-run with \`ablo connect rotate\` to repair credentials explicitly; no database changes were made.`,
      { code: 'cli_invalid_arguments', details: { existingRoles: [...existingRoles] } },
    );
  }
  // Rotate's nothing-to-re-key arm, now that the database has answered: no
  // registration AND no roles means a first connect wearing the wrong verb;
  // roles without a registration is the stranded state, and rotate proceeds.
  if (rotatePlane) {
    const refusal = rotateWithoutConnection({ rotating, ...rotatePlane, existingRoles });
    if (refusal) {
      await admin.end({ timeout: 2 });
      console.error(`  ${pc.yellow('!')} ${refusal}\n`);
      console.error(pc.dim(`    Your database is untouched.\n`));
      process.exit(1);
    }
  }
  const blocker = reapplyBlocker({
    rotating,
    // A complete, registered pair keeps its current passwords: apply repairs
    // only non-secret invariants and never re-registers it. A partial pair is
    // still refused because it cannot be completed without credential repair.
    existingRoles:
      existingRegistration && existingRoles.length === 2 ? [] : existingRoles,
  });
  if (blocker) {
    await admin.end({ timeout: 2 });
    if (!args.json) console.log(
      `  ${pc.yellow('!')} ${blocker.roles.map((r) => pc.bold(r)).join(' and ')} ${blocker.plural ? 'are' : 'is'} already set up here.\n`
    );
    console.log(
      pc.dim(
        `    Your database is untouched. ${pc.bold('connect apply')} keeps the password of a role it\n` +
          `    finds, since another connection may still be using it, so this run has no new\n` +
          `    password to give Ablo.\n`
      )
    );
    console.log(
      `  Issue fresh passwords and hand them to Ablo:  ${pc.cyan('npx ablo connect rotate')}\n`
    );
    process.exit(1);
  }

  // 2. Generate fresh role passwords and build the plan. `rotate` runs the same
  // plan with one difference: an existing role has its password re-keyed.
  const replicationPassword = generateRolePassword();
  const writePassword = generateRolePassword();
  const buildPlan = (mode: PasswordMode): readonly ApplyStep[] =>
    connectApplyPlan({
      tables,
      role,
      writeRole,
      schema: args.schema,
      publication,
      rotate: rotating,
      credentials: {
        replicationClause: passwordClause(replicationPassword, mode),
        writeClause: passwordClause(writePassword, mode),
      },
      walAlreadyLogical: walReady,
      provider,
      existingPublication,
      inheritGrants,
      // Read off the connected admin rather than guessed from the hostname. A
      // role can only hand out an attribute it holds, and on RDS and Aurora
      // BYPASSRLS is reserved to `rdsadmin`, so the recipe substitutes explicit
      // SELECT policies for the reader.
      canGrantBypassRls: capability?.rolbypassrls === true,
      // Same rule, second attribute: RDS and Aurora keep REPLICATION on
      // rdsadmin and lend it as `rds_replication`, so the recipe grants that
      // role rather than setting an attribute this admin cannot pass on.
      canGrantReplication: capability?.rolreplication === true,
    });
  const steps = buildPlan('scram-verifier');

  // 3. Show the plan in plain language and confirm. When reconciling narrows the
  // publication, surface the removals first — they stop replicating to Ablo, so the
  // operator sees the destructive part before confirming, not after.
  if (pubReconcile.removed.length > 0 || pubReconcile.recreated) {
    if (!args.json) {
      console.log(
        `  ${pc.yellow('!')} ${pc.bold(publication)} already publishes a different set; reconciling to your mapped tables:`
      );
      for (const t of pubReconcile.added) console.log(`      ${pc.green('+')} ${t}`);
      for (const t of pubReconcile.removed) {
        console.log(`      ${pc.red('-')} ${t} ${pc.dim('(stops replicating to Ablo)')}`);
      }
      if (pubReconcile.recreated && existingPublication.allTables) {
        console.log(
          `      ${pc.red('-')} ${pc.dim('every other table (was FOR ALL TABLES)')}`
        );
      }
      console.log();
    }
  }
  if (!args.json) printPlan(steps, args.showSql);
  if (!args.yes) {
    if (!process.stdout.isTTY) {
      await admin.end({ timeout: 2 });
      console.error(
        pc.dim(`  Re-run with ${pc.bold('--yes')} to apply this in a non-interactive session.\n`)
      );
      process.exit(1);
    }
    const proceed = await confirm({
      message: rotating ? `Re-key Ablo's roles on ${target}?` : `Provision Ablo on ${target}?`,
      initialValue: true,
    });
    if (isCancel(proceed) || !proceed) {
      await admin.end({ timeout: 2 });
      console.log(
        pc.dim(`  Nothing applied. Run ${pc.bold('ablo connect --manual')} to see the setup SQL.\n`)
      );
      process.exit(0);
    }
  }

  // 4. Apply. From the first ALTER ROLE until registration lands, a rotate has
  // the database on passwords Ablo doesn't hold yet — a cancel in that window
  // (Ctrl-C, a closed terminal sending SIGTERM) strands a live source on dead
  // credentials with no explanation. The handler makes even that exit tell the
  // operator exactly how to recover; `apply` has no live source to strand.
  const onRotateInterrupt = (): void => {
    console.error(`\n\n  ${pc.red(ROTATE_STRANDED_CREDENTIALS_NOTICE.split('\n').join('\n  '))}\n`);
    process.exit(130);
  };
  if (rotating) {
    process.once('SIGINT', onRotateInterrupt);
    process.once('SIGTERM', onRotateInterrupt);
  }
  try {
    await executePlan(admin, steps, () => buildPlan('plaintext'));
  } catch (err) {
    await admin.end({ timeout: 2 }).catch(() => undefined);
    const pg = (err ?? {}) as PgErrorLike;
    console.error(
      pc.red(`\n  Setup stopped: ${pg.message ?? String(err)}`) +
        pc.dim(`  Every step is safe to re-run.\n`)
    );
    if (rotating) {
      // The plan may have re-keyed a role before stopping — same recovery.
      console.error(`  ${pc.red(ROTATE_STRANDED_CREDENTIALS_NOTICE.split('\n').join('\n  '))}\n`);
    }
    process.exit(1);
  }
  await admin.end({ timeout: 2 });

  if (existingRegistration) {
    // The control plane already owns the working scoped credentials. Validate
    // through those credentials after the database mutation; never construct
    // or register the generated passwords, which intentionally were not
    // applied to the existing roles.
    const after = inspectRegisteredConnection(
      await requestRemoteValidation({ apiUrl, apiKey }),
    );
    if (after.needsDatabaseReconcile || after.code === 'operator_action_required') {
      throw new AbloConnectionError(
        `Database reconciliation did not reach the snapshot boundary (${after.detail ?? after.repairItems.join(', ')}).`,
        { code: 'cli_database_unreachable', details: { ...after } },
      );
    }
    if (existingNeedsSnapshot || after.needsSnapshotRequest) {
      const snapshot = await requestInitialSnapshot({ apiUrl, apiKey });
      const reconciled: ConnectReconcileStatus = {
        ...after,
        code:
          snapshot.replication_slot?.released === false
            ? 'operator_action_required'
            : 'loading',
        steps: {
          ...after.steps,
          database: 'changed',
          registration: 'unchanged',
          snapshot: snapshot.replication_slot?.released === false ? 'action_required' : 'loading',
          readiness: snapshot.replication_slot?.released === false ? 'action_required' : 'pending',
        },
        ...(snapshot.replication_slot?.released === false
          ? { detail: snapshot.replication_slot.detail ?? 'replication_slot_active' }
          : {}),
      };
      emitReconcileStatus(reconciled, args.json);
      return;
    }
    emitReconcileStatus(after, args.json);
    return;
  }

  // 5. Build the scoped connection strings in memory — never written to disk.
  const replicationUrl = rewriteDatabaseUrl(adminUrl, role, replicationPassword);
  const writeUrl = rewriteDatabaseUrl(adminUrl, writeRole, writePassword);
  if (!args.json) console.log(`\n  ${pc.green('✓')} Roles ${rotating ? 're-keyed' : 'created'}.\n`);

  // 6. If logical replication isn't on yet, registration would be refused, so the
  // roles are ready but the source is not. This is an INCOMPLETE setup — exit
  // non-zero so an unattended run can't read it as success — with the one
  // provider-specific step left. Re-running rotates the passwords, so nothing is
  // left stranded.
  if (!walReady) {
    console.error(
      `  ${pc.yellow('!')} One step left — your database isn't sharing changes with Ablo yet.\n` +
        `    ${logicalReplicationGuidance(provider)}.\n` +
        `\n  Then re-run:  ${pc.cyan(`npx ablo ${verb}`)}\n`
    );
    process.exit(1);
  }

  // 7. Prove it locally where we can. A machine that can't dial the host says
  // nothing about whether Ablo can — the server re-checks from its own network at
  // registration — so a local dial failure is a note, not a stop.
  //
  // BOTH roles are probed, because they fail independently and only one of them
  // used to be looked at. The writer is the role the engine's write gate judges,
  // and its least-privilege checklist is the one that catches a schema where
  // PUBLIC still holds CREATE — a stock PostgreSQL 14 or earlier, where the
  // recipe deliberately leaves schema-level CREATE alone. Verifying only the
  // replication role meant apply reported a connected database whose every write
  // the engine would then refuse, with the refusal arriving later from Ablo's
  // network as a permission error against a role apply had just created.
  const replicationProbe = await probeAsRole(replicationUrl, (sql) =>
    probeReadiness(sql, {
      coordinatedTables,
      schema: args.schema,
      publication,
      // The reader may hold REPLICATION through the provider's role rather than
      // the attribute, which is the only shape available on RDS and Aurora.
      replicationGrantRole: replicationGrantRole(provider),
    })
  );
  const writeProbe = await probeAsRole(writeUrl, (sql) =>
    probeDirectWriteReadiness(sql, { schema: args.schema, publication })
  );

  // A refused credential is the one dial failure that says nothing about the
  // network: the database answered, and turned down the very password about to
  // be registered. Reported as "couldn't verify from here" it would arrive again
  // from Ablo's network, where the same words read as an unreachable host and
  // send the reader to look at firewalls. Name it here instead, while the cause
  // is still local. A rotate carries on regardless: it has already re-keyed, so
  // registration is what keeps Ablo's copy in step.
  const refused = [
    ...(replicationProbe.credentialRefused ? [role] : []),
    ...(writeProbe.credentialRefused ? [writeRole] : []),
  ];
  if (refused.length > 0 && !rotating) {
    console.log(
      `\n  ${pc.yellow('!')} ${refused.map((r) => pc.bold(r)).join(' and ')} did not take the password from this run.\n`
    );
    console.log(
      pc.dim(
        `    Your database answered, so this is about the password, not the network,\n` +
          `    and nothing was registered with Ablo.\n`
      )
    );
    console.log(
      `  Issue fresh passwords and hand them to Ablo:  ${pc.cyan('npx ablo connect rotate')}\n`
    );
    process.exit(1);
  }
  if (replicationProbe.items === null || writeProbe.items === null) {
    if (!args.json) console.log(pc.dim(`  Couldn't verify from here; Ablo will validate from its own network.\n`));
  }

  const items = [...(replicationProbe.items ?? []), ...(writeProbe.items ?? [])];
  const failed = items.filter((i) => !i.ok);
  if (failed.length > 0) {
    // With the fix, not just the finding. These checklists carry the exact
    // statement that resolves each one (the schema-CREATE item carries the
    // `REVOKE CREATE ON SCHEMA … FROM PUBLIC` the recipe leaves to the
    // operator), and a finding whose remedy is withheld sends the reader
    // back to the docs for something already in hand.
    for (const item of failed) {
      console.log(`  ${pc.yellow('!')} ${item.label}`);
      if (item.fix) {
        for (const line of item.fix.split('\n')) console.log(pc.dim(`      ${line}`));
      }
    }
    if (!rotating) {
      console.log(`\n  ${pc.dim('Resolve, then re-run')}  ${pc.cyan(`npx ablo ${verb}`)}\n`);
      process.exit(1);
    }
    // A rotate has already re-keyed the roles, so stopping here would strand a
    // live source on credentials Ablo doesn't hold — over findings this machine
    // may simply be unable to judge. Registration is the authority (the engine
    // re-validates from its own network); let it decide, and its failure path
    // already carries the recovery notice.
    console.log(
      `\n  ${pc.dim('Continuing to registration — Ablo re-checks these from its own network.')}\n`
    );
  }

  // 8. Hand both scoped roles to Ablo directly. Nothing is left in your .env.
  // Registration includes Ablo's server-side read-back, so a success return is
  // proof the new credential works — and on failure we never exit success.
  const registered = await registerDirectDataSource({
    apiUrl,
    apiKey,
    replicationUrl,
    writeUrl,
    route: args.route,
    schema: args.schema,
    replicationSlot: footprint.slot,
    publication,
    quiet: args.json,
  });
  // The stranded-credential window is over: from here the outcome itself says
  // whether recovery is needed, so the interrupt handler must not speak again.
  process.off('SIGINT', onRotateInterrupt);
  process.off('SIGTERM', onRotateInterrupt);
  const outcome = postRegistrationOutcome({ rotating, registered });
  if (outcome.notice) {
    console.error(`\n  ${pc.red(outcome.notice.split('\n').join('\n  '))}\n`);
  }
  if (args.json && registered) {
    const initial = absentConnectionStatus();
    emitReconcileStatus(
      {
        ...initial,
        code: 'loading',
        steps: {
          database: 'changed',
          registration: 'changed',
          snapshot: 'loading',
          readiness: 'pending',
        },
      },
      true
    );
  }
  process.exit(outcome.exitCode);
}
