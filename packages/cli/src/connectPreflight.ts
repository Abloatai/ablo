/**
 * The READS `connect apply` takes before it writes anything, and the decisions
 * that rest on them.
 *
 * Every function here runs against a database that is still untouched, which is
 * the point: a run that cannot succeed should be refused while refusing still
 * costs nothing. Two of these exist because a run once proceeded without them —
 * {@link reapplyBlocker}, which caught a password generated but never set, and
 * the role probes, which caught a writer created and never verified.
 *
 * Kept apart from the plan and the command so a preflight can be added without
 * touching either, and so the decisions ({@link reapplyBlocker}) stay pure and
 * testable next to the reads that feed them.
 */

import postgres from 'postgres';
import {
  datasourceLocationResponseSchema,
  type DatasourceLocationResponse,
} from '@abloatai/transaction/wire';
import { tryControlPlane } from './controlPlane';
import { loadSchema, DEFAULT_SCHEMA_PATH, DEFAULT_EXPORT } from './push';
import { serializeSchema, type SchemaJSON } from '@abloatai/transaction/schema';
import { looksLikeCredentialRefusal } from './readiness';
import type { CheckItem } from './connectSetup';

/**
 * Whether this run would hand Ablo a password the database never took, and the
 * plain-language reason when it would.
 *
 * `apply` generates both passwords before the plan runs, and {@link idempotentRole}
 * creates only roles that are absent, so a role that already exists keeps the
 * password it was created with. Everything downstream still uses the generated
 * one: the connection strings are built from it, the local probe dials with it,
 * and registration hands it to Ablo. The database then refuses Ablo the same way
 * it refuses the probe, and because that refusal arrives from Ablo's network it
 * reads as a firewall or private-host problem rather than a stale password.
 *
 * So the answer is a decision, taken before anything is written: `apply` stops
 * and names `rotate`, the verb whose whole purpose is a new password. `rotate`
 * re-keys what it finds, so an existing role is exactly what it expects.
 */
export function reapplyBlocker(input: {
  readonly rotating: boolean;
  readonly existingRoles: readonly string[];
}): { readonly roles: readonly string[]; readonly plural: boolean } | null {
  if (input.rotating || input.existingRoles.length === 0) return null;
  return { roles: input.existingRoles, plural: input.existingRoles.length > 1 };
}

/** Whether the currently-connected role can create other roles (needed to run the plan). */
export interface AdminCapabilityRow {
  readonly rolname: string;
  readonly rolsuper: boolean;
  readonly rolcreaterole: boolean;
  /**
   * Whether this admin can hand out BYPASSRLS, which Postgres permits only to a
   * role that holds it. Managed providers withhold it: on Amazon RDS and Aurora
   * it belongs to `rdsadmin` alone, so neither the master user nor
   * `rds_superuser` can create the replication role the canonical recipe asks
   * for. Read rather than inferred from the hostname, because the same is true
   * of any locked-down cluster whose name says nothing.
   */
  readonly rolbypassrls: boolean;
  /**
   * Whether this admin can hand out REPLICATION, subject to the same rule as
   * BYPASSRLS. Managed providers withhold it and expose the capability as a
   * grantable role instead — `rds_replication` on Amazon RDS and Aurora.
   */
  readonly rolreplication: boolean;
}

/** Look up whether the connected admin role can create the scoped roles. */
export async function adminCanCreateRoles(sql: postgres.Sql): Promise<AdminCapabilityRow | null> {
  const rows = await sql.unsafe<AdminCapabilityRow[]>(
    `SELECT rolname, rolsuper, rolcreaterole, rolbypassrls, rolreplication FROM pg_roles WHERE rolname = current_user`
  );
  return rows[0] ?? null;
}

/**
 * The tables to publish when `--tables` was not given: the ones this project's
 * own schema declares, or `null` when the project has no schema to read.
 *
 * A publication is the list of tables Ablo asks the database to stream, and
 * `FOR ALL TABLES` asks for every one of them — including tables belonging to
 * whatever else shares the database. That is not a hypothetical: an agent
 * framework co-resident in a customer's Postgres owns its own tables, and two
 * of them had no primary key, so `FOR ALL TABLES` made another tool's schema
 * decisions into a refusal to connect at all. The customer never asked for
 * those tables to be replicated and could not act on the complaint.
 *
 * So the default narrows to what Ablo was actually told about. `defineSchema`
 * resolves `tableName` onto every model, so the resolved value is read here
 * rather than restating the `tableName ?? key` fallback a caller can't see.
 */
export async function schemaDeclaredTables(): Promise<readonly string[] | null> {
  try {
    const schema = await loadSchema(DEFAULT_SCHEMA_PATH, DEFAULT_EXPORT);
    const json = JSON.parse(serializeSchema(schema)) as SchemaJSON;
    const tables = Object.entries(json.models).map(([key, model]) => model.tableName ?? key);
    return tables.length > 0 ? tables : null;
  } catch {
    // No schema in this project, or one that doesn't load. Not an error here:
    // `connect` legitimately runs before `push`, so the caller decides.
    return null;
  }
}

/**
 * Dial as one scoped role and run its readiness checklist.
 *
 * Both scoped roles are verified the same way and fail in the same two ways, so
 * they share one dialer: `items` is the checklist when the dial succeeded and
 * `null` when it did not, and `credentialRefused` separates the database turning
 * down the password from this machine being unable to reach the host at all.
 */
export async function probeAsRole(
  url: string,
  probe: (sql: postgres.Sql) => Promise<readonly CheckItem[]>
): Promise<{ readonly items: readonly CheckItem[] | null; readonly credentialRefused: boolean }> {
  const sql = postgres(url, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    onnotice: () => {
      // Swallow postgres NOTICE chatter — the readiness checklist reports its own findings.
    },
  });
  try {
    return { items: await probe(sql), credentialRefused: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { items: null, credentialRefused: looksLikeCredentialRefusal(message) };
  } finally {
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
}

/**
 * Which of the scoped roles the database already has, in the order asked for.
 *
 * The one read {@link reapplyBlocker} needs. It runs while the database is still
 * untouched, so a second `apply` can be answered before it provisions anything.
 */
export async function presentRoles(
  sql: postgres.Sql,
  roles: readonly string[]
): Promise<readonly string[]> {
  const rows = await sql.unsafe<{ rolname: string }[]>(
    `SELECT rolname FROM pg_roles WHERE rolname = ANY($1)`,
    [[...roles]]
  );
  const found = new Set(rows.map((row) => row.rolname));
  return roles.filter((role) => found.has(role));
}

/** The cluster's current `wal_level`, or '' when it can't be read. `SHOW` is
 *  permitted for every role, so this works even where `ALTER SYSTEM` does not. */
export async function currentWalLevel(sql: postgres.Sql): Promise<string> {
  try {
    const rows = await sql.unsafe<{ wal_level: string }[]>(`SHOW wal_level`);
    return rows[0]?.wal_level ?? '';
  } catch {
    return '';
  }
}

/**
 * Whether `rotate` has anything to re-key.
 *
 * Rotate re-keys the database and only then registers, because Ablo validates a
 * credential by dialling with it, so the password must exist first. That order
 * is safe when there is something to update, and unsafe when there is not: the
 * run rotates the roles, registration is refused, and the database is left on
 * passwords Ablo does not hold.
 *
 * "Something to update" has TWO honest shapes, and conflating them built a
 * loop. A plane with a registration has a credential to re-key — the ordinary
 * rotate. A plane with NO registration but the scoped roles present in the
 * database is the STRANDED state: an apply or rotate that re-keyed the roles
 * and then failed to register, leaving passwords Ablo never received. Rotate
 * is precisely the recovery there — fresh passwords, then a registration that
 * this time can validate — and refusing it sent the reader to `apply`, whose
 * own guard on existing roles sent them straight back here. Only when the
 * plane has no registration AND the roles are absent is a rotate truly a
 * first connect wearing the wrong verb. (A database held by a DIFFERENT plane
 * is refused earlier, by the locate preflight, before this question is asked.)
 *
 * Returns the reason to refuse, or `null` when rotate has something to update.
 */
export function rotateWithoutConnection(input: {
  readonly rotating: boolean;
  /** What the control plane reports for the caller's own plane. */
  readonly planeHasConnection: boolean;
  /** False when the control plane could not be asked; unknown is not a refusal. */
  readonly known: boolean;
  /**
   * Ablo answered and turned the key down. Distinct from `known: false`, which
   * means nobody answered at all: an unreachable control plane says nothing
   * about whether registration would succeed, while a rejected key says it
   * cannot. Collapsing the two let a mistyped key re-key a live database and
   * then fail at registration, which is the failure this whole guard exists to
   * prevent, arriving through the one input that was allowed to skip it.
   */
  readonly keyRejected: boolean;
  /** The scoped role names already present in the database — the stranded
   *  state's tell. Present roles mean rotate has passwords to replace even
   *  when the plane holds no registration. */
  readonly existingRoles: readonly string[];
}): string | null {
  if (!input.rotating) return null;
  if (input.keyRejected) {
    return (
      'Ablo did not accept this API key, so it cannot be told about a new password. ' +
      'Rotate changes the password in your database first, so running it with a key ' +
      'Ablo refuses would leave the database on a password nobody holds.'
    );
  }
  if (!input.known || input.planeHasConnection) return null;
  if (input.existingRoles.length > 0) return null;
  return (
    "This branch has no connected database and Ablo's roles are not in this database, " +
    'so there is no credential to re-key. Connecting for the first time is ' +
    '`ablo connect apply`, which creates the roles and registers them in one run.'
  );
}

/** Where a database is already connected, as `POST /v1/datasources/locate`
 *  answers it — the wire contract's own `held` shape, never restated. */
export type HeldElsewhere =
  | NonNullable<DatasourceLocationResponse['held']>
  | { readonly private: true };

/**
 * Ask Ablo whether this database is already streaming to another plane, before
 * anything is created or re-keyed.
 *
 * The registration guard has always known this and only said so after a run had
 * already written two roles and a publication. Asking first turns a conflict
 * discovered at the end into one refused at the start, with the database
 * untouched. Returns `null` when nothing holds it, or when Ablo cannot be asked:
 * an unreachable control plane is not evidence of a conflict, and registration
 * remains the authority either way.
 */
export async function locateExistingConnection(input: {
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly connectionString: string;
  readonly schema?: string;
}): Promise<HeldElsewhere | null> {
  const result = await tryControlPlane({
    path: '/v1/datasources/locate',
    method: 'POST',
    baseUrl: input.apiUrl,
    apiKey: input.apiKey,
    body: {
      connectionString: input.connectionString,
      ...(input.schema ? { schema: input.schema } : {}),
    },
    responseSchema: datasourceLocationResponseSchema,
  });
  // Every failure — an unreachable control plane, a deployment without the
  // route (404), an unrecognized body — resolves to "no conflict found":
  // absence of an answer is not evidence of a conflict, and registration
  // remains the authority either way.
  if (!result.ok) return null;
  if (result.value.held) return result.value.held;
  return result.value.available === false ? { private: true } : null;
}

/** The refusal for a database already streaming to another plane, or null. */
export function alreadyConnectedElsewhere(held: HeldElsewhere | null): string | null {
  if (!held) return null;
  if ('private' in held) {
    return (
      'This database schema is already connected to another Ablo organization. ' +
      'Ablo does not reveal that organization’s project or branch.'
    );
  }
  const where = held.project
    ? `project ${held.project}, branch ${held.branch}`
    : `branch ${held.branch}`;
  return (
    `This database schema is already connected to ${where}. A (database, schema) ` +
    'binding belongs to one plane at a time.'
  );
}
