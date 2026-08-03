/**
 * The `connect apply` PLAN: the statements a run would execute, and how they
 * read to a person.
 *
 * Pure and deterministic. Nothing here dials a database, so the plan a test
 * asserts is byte-identical to the one an operator confirms. The privilege
 * statements are taken verbatim from {@link connectSetupSql} — the same recipe
 * `ablo connect` prints — and only the statements that must differ to run
 * unattended are replaced: the two role creations, the publication, and the
 * write-ahead-log step.
 *
 * It also owns how the plan RENDERS, because what a plan claims and what it
 * shows have to move together. {@link effectsOnOthers} is the load-bearing part:
 * it derives, from the SQL itself, which effects reach past Ablo's own objects,
 * so a recipe change cannot leave the notice describing a statement that is no
 * longer there.
 */

import pc from 'picocolors';
import {
  ABLO_REPLICATION_ROLE,
  ABLO_WRITE_ROLE,
  connectSetupSql,
  quoteIdent,
  reconcilePublicationPlan,
  type PublicationState,
} from './connectSetup';
import { logicalReplicationGuidance, type DbProvider } from './dbProvider';
import { scramSha256Verifier } from './dbRole';

/** How a role's password is written into the SQL — mirrors {@link scopedRoleStatements}. */
export type PasswordMode = 'scram-verifier' | 'plaintext';

/**
 * A single stage of the apply plan. `title`/`detail` are the plain-language
 * summary a person reads; `sql` is what actually runs. `kind` lets the runner
 * treat the write-ahead-log stage specially — it is the one stage a managed
 * provider may refuse, and the only one that can need a restart.
 */
export interface ApplyStep {
  readonly key: 'own' | 'wal' | 'publication' | 'replication-role' | 'write-role' | 'grants';
  readonly title: string;
  readonly detail: string;
  readonly sql: readonly string[];
  /**
   * Effects this step has on things Ablo does not own, in plain language.
   *
   * Almost every statement here concerns Ablo's own roles, publication and
   * ledger, and needs no special notice. A few reach further: revoking the
   * database defaults changes what OTHER roles may do, and publishing every
   * table enlists tables belonging to whatever else shares the database.
   *
   * Those belong in front of the operator BEFORE the confirmation rather than
   * inside a recipe they have to ask to see. A plan that renders a privilege
   * taken from someone else's roles identically to a grant on Ablo's own is
   * accurate and still misleading, because consent given to the whole is not
   * consent to the part nobody could pick out.
   */
  readonly affectsOthers?: readonly string[];
}

/**
 * A single stage of the apply plan. `title`/`detail` are the plain-language
 * summary a person reads; `sql` is what actually runs. `kind` lets the runner
 * treat the write-ahead-log stage specially — it is the one stage a managed
 * provider may refuse, and the only one that can need a restart.
 */
export interface ApplyStep {
  readonly key: 'own' | 'wal' | 'publication' | 'replication-role' | 'write-role' | 'grants';
  readonly title: string;
  readonly detail: string;
  readonly sql: readonly string[];
  /**
   * Effects this step has on things Ablo does not own, in plain language.
   *
   * Almost every statement here concerns Ablo's own roles, publication and
   * ledger, and needs no special notice. A few reach further: revoking the
   * database defaults changes what OTHER roles may do, and publishing every
   * table enlists tables belonging to whatever else shares the database.
   *
   * Those belong in front of the operator BEFORE the confirmation rather than
   * inside a recipe they have to ask to see. A plan that renders a privilege
   * taken from someone else's roles identically to a grant on Ablo's own is
   * accurate and still misleading, because consent given to the whole is not
   * consent to the part nobody could pick out.
   */
  readonly affectsOthers?: readonly string[];
}

/** The password material for the two roles, already turned into a SQL literal. */
export interface ApplyCredentials {
  readonly replicationClause: string;
  readonly writeClause: string;
}

/** Build the password clause for a role, either the SCRAM verifier or an escaped plaintext literal. */
export function passwordClause(password: string, mode: PasswordMode): string {
  return mode === 'scram-verifier' ? scramSha256Verifier(password) : password.replace(/'/g, "''");
}

/**
 * Create a role, or — only when re-keying is the point — set its password.
 *
 * The distinction is load-bearing and used not to be. This once recovered from
 * `duplicate_object` by running `ALTER ROLE … PASSWORD` unconditionally, which
 * is idempotent in the sense of not erroring and destructive in the sense that
 * matters: any second `apply` against a database silently re-keyed a role
 * another connection was still authenticating with. Because the secret store is
 * per-plane, each plane then held its own now-wrong copy of one role's password,
 * and the failure surfaced later and elsewhere as a rejected credential.
 *
 * So `apply` creates and otherwise leaves the role alone, and `rotate` — the
 * verb whose whole purpose is a new password — is the only thing that re-keys.
 * Postgres has no `CREATE ROLE IF NOT EXISTS`, so the guard is an explicit
 * `pg_roles` check rather than an exception handler. Attributes are never
 * re-asserted on an existing role: that trips managed-Postgres permission walls,
 * and the server-side probe audits the live attributes anyway.
 */
function idempotentRole(
  role: string,
  attributes: string,
  clause: string,
  rotate: boolean,
): string {
  const lines = [
    'DO $$ BEGIN',
    `  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role.replace(/'/g, "''")}') THEN`,
    `    CREATE ROLE ${quoteIdent(role)} WITH ${attributes} LOGIN PASSWORD '${clause}';`,
  ];
  if (rotate) {
    lines.push('  ELSE', `    ALTER ROLE ${quoteIdent(role)} WITH LOGIN PASSWORD '${clause}';`);
  }
  lines.push('  END IF;', 'END $$;');
  return lines.join('\n');
}

/**
 * Turn the canonical recipe from {@link connectSetupSql} into an executable,
 * idempotent, real-password plan. Every privilege statement is taken verbatim
 * from the recipe; only the write-ahead-log switch, the publication, and the two
 * role creations are replaced — the statements that must be idempotent and carry
 * a real password to run unattended.
 *
 * Pure and deterministic, so a test can assert the plan reuses exactly the
 * recipe's grants and swaps exactly the three heads.
 */
export function connectApplyPlan(input: {
  readonly tables?: readonly string[];
  readonly role?: string;
  readonly writeRole?: string;
  readonly schema?: string;
  readonly publication: string;
  /**
   * Re-key roles that already exist. `apply` leaves an existing role's password
   * alone — another connection may be authenticating with it — so only `rotate`,
   * whose whole purpose is a new password, passes this.
   */
  readonly rotate?: boolean;
  readonly credentials: ApplyCredentials;
  /** Omit the write-ahead-log step when the cluster is already `wal_level = logical`. */
  readonly walAlreadyLogical?: boolean;
  /** Shapes the write-ahead-log step's guidance; managed providers show a
   *  console/setting action instead of an `ALTER SYSTEM` that can't run. */
  readonly provider?: DbProvider;
  /** The publication's live membership. When given, the publish step reconciles it
   *  to `--tables` (declarative); when omitted, it falls back to create-if-absent. */
  readonly existingPublication?: PublicationState;
  /** Inherit-grants that let this admin manage tables an earlier integration's role
   *  owns, run first so the publish and grant steps apply cleanly. See connectOwnership. */
  readonly inheritGrants?: readonly string[];
}): readonly ApplyStep[] {
  const role = input.role && input.role.length > 0 ? input.role : ABLO_REPLICATION_ROLE;
  const writeRole =
    input.writeRole && input.writeRole.length > 0 ? input.writeRole : ABLO_WRITE_ROLE;
  const tables = input.tables ?? [];
  const schema = input.schema ?? 'public';
  const publication = input.publication;
  const provider = input.provider ?? 'generic';

  // The canonical recipe. We keep every statement except the three we must
  // replace to run unattended, identified by their leading verb so a change to
  // the recipe's wording surfaces in the drift test rather than silently.
  const recipe = connectSetupSql({ tables, role, writeRole, schema, publication });
  const isWal = (s: string): boolean => s.startsWith('ALTER SYSTEM SET wal_level');
  const isPublication = (s: string): boolean => s.startsWith('CREATE PUBLICATION');
  const isRoleCreate = (s: string): boolean => s.startsWith('CREATE ROLE ');
  const grants = recipe.filter((s) => !isWal(s) && !isPublication(s) && !isRoleCreate(s));

  const publicationTarget =
    tables.length > 0
      ? `FOR TABLE ${tables.map((table) => `${quoteIdent(schema)}.${quoteIdent(table)}`).join(', ')}`
      : 'FOR ALL TABLES';
  const affectsOthers = effectsOnOthers({ grants, allTables: tables.length === 0 });

  // The write-ahead-log step: nothing to do when the cluster is already
  // logical; a plain SQL statement on self-hosted; a console/setting action
  // (no SQL) on managed providers that reject ALTER SYSTEM.
  const walStep: readonly ApplyStep[] = input.walAlreadyLogical
    ? []
    : [
        provider === 'generic'
          ? {
              key: 'wal',
              title: 'Let Ablo see your changes as they happen',
              detail: 'lets Ablo read your changes as they happen (needs a restart to take effect)',
              sql: [`ALTER SYSTEM SET wal_level = 'logical';`],
            }
          : {
              key: 'wal',
              title: 'Let Ablo see your changes as they happen',
              detail: logicalReplicationGuidance(provider),
              sql: [],
            },
      ];

  // With live state, reconcile the publication to exactly `--tables` (declarative,
  // Debezium-"filtered" style). Without it — the pure/fresh-DB path — create it if
  // absent; a re-run against a matching publication is then a no-op.
  const reconcile = input.existingPublication
    ? reconcilePublicationPlan(input.existingPublication, tables, { schema, publication })
    : null;
  const publicationSql = reconcile
    ? reconcile.sql
    : [
        `DO $$ BEGIN
  CREATE PUBLICATION ${quoteIdent(publication)} ${publicationTarget};
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;`,
      ];
  const publicationDetail =
    reconcile?.sql.length === 0
      ? 'already sharing exactly these tables — nothing to change'
      : tables.length > 0
        ? `a live feed of the ${tables.length} table${tables.length === 1 ? '' : 's'} you chose`
        : 'a live feed of your tables';

  // When an earlier integration's role owns your tables, grant this admin
  // inheritance of that role first — so the publish and grant steps, which
  // Postgres reserves for the owner, apply cleanly. Runs before everything else.
  const ownStep: readonly ApplyStep[] =
    input.inheritGrants && input.inheritGrants.length > 0
      ? [
          {
            key: 'own',
            title: 'Let this admin manage tables owned by another role',
            detail:
              'your admin inherits the owning role so the steps below apply — reversible, no ownership change',
            sql: input.inheritGrants,
          },
        ]
      : [];

  return [
    ...ownStep,
    ...walStep,
    {
      key: 'publication',
      title: 'Publish your tables to Ablo',
      detail: publicationDetail,
      sql: publicationSql,
    },
    {
      key: 'replication-role',
      title: 'Create the read-only login Ablo reads with',
      detail: `${role} — it can follow your changes and snapshot the same published rows, including through RLS`,
      sql: [
        idempotentRole(
          role,
          'NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE REPLICATION NOINHERIT',
          input.credentials.replicationClause,
          input.rotate === true,
        ),
        // Unlike a password, this is a required invariant rather than secret
        // material owned by one plane. Re-assert it for an existing pre-snapshot
        // role so `connect apply` repairs the exact upgrade gap that otherwise
        // certifies an RLS-filtered empty snapshot as complete.
        `ALTER ROLE ${quoteIdent(role)} WITH BYPASSRLS;`,
      ],
    },
    {
      key: 'write-role',
      title: 'Create the login Ablo writes with',
      detail: `${writeRole} — writes rows through Ablo; where a table has row-level-security policies, they govern its writes too (it can't bypass them)`,
      sql: [
        idempotentRole(
          writeRole,
          'NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT',
          input.credentials.writeClause,
          input.rotate === true,
        ),
      ],
    },
    {
      key: 'grants',
      title: 'Grant each role exactly what it needs',
      detail:
        'read access for the reader, row writes for the writer — no ownership, no schema changes',
      sql: grants,
      ...(affectsOthers.length > 0 ? { affectsOthers } : {}),
    },
  ];
}

/**
 * The effects of a plan that reach past Ablo's own objects, named from the SQL
 * that causes them rather than from a list kept alongside it.
 *
 * Derived, so a recipe change cannot leave the notice describing a statement
 * that is no longer there, nor stay silent about one newly added.
 */
export function effectsOnOthers(input: {
  readonly grants: readonly string[];
  readonly allTables: boolean;
}): readonly string[] {
  const effects: string[] = [];
  if (input.grants.some((s) => /REVOKE\s+TEMPORARY,\s*CREATE\s+ON\s+DATABASE/i.test(s))) {
    effects.push(
      'Every role in this database loses the ability to create temporary tables, ' +
        'not only Ablo\'s. Postgres grants that to PUBLIC by default, and PUBLIC ' +
        'reaches every login, so Ablo\'s writer holds it until it is withdrawn. ' +
        'Re-grant it to any role that needs it: GRANT TEMPORARY ON DATABASE <db> TO <role>;'
    );
  }
  if (input.allTables) {
    effects.push(
      'Every table in this database is published to Ablo, including any belonging ' +
        'to other tools that share it. Their design then has to satisfy replication ' +
        'too. Pass --tables to publish only yours.'
    );
  }
  return effects;
}

/** Print the plan as a short, scannable checklist — titles only, SQL only if asked. */
export function printPlan(steps: readonly ApplyStep[], showSql: boolean): void {
  console.log(`  This sets up your database for Ablo:\n`);
  for (const step of steps) {
    console.log(`    ${pc.green('•')} ${step.title}`);
    if (showSql) {
      for (const statement of step.sql) {
        for (const line of statement.split('\n')) console.log(`        ${pc.dim(line)}`);
      }
    }
  }
  console.log(
    pc.dim(
      `\n  Your admin password stays on this machine.${showSql ? '' : ' (--show-sql for the exact statements)'}\n`
    )
  );

  // Last, and unmissable: what this reaches beyond Ablo's own objects. Placed
  // after the plan so it is the final thing read before the confirmation.
  const reaching = steps.flatMap((step) => step.affectsOthers ?? []);
  if (reaching.length > 0) {
    console.log(`  ${pc.yellow('!')} This also changes things Ablo does not own:\n`);
    for (const effect of reaching) {
      for (const line of wrapToWidth(effect, 74)) console.log(`      ${line}`);
      console.log();
    }
  }
}

/** Wrap plain prose to a column so a multi-sentence notice stays readable in a terminal. */
function wrapToWidth(text: string, width: number): readonly string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/)) {
    if (current.length === 0) current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}
