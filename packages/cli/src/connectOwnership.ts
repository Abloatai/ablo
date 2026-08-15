/**
 * Ownership preflight for `ablo connect --apply`.
 *
 * The setup grants the writer role DML on your published tables and, on an
 * upgrade, alters the `ablo_idempotency` ledger — both operations Postgres
 * reserves for the object's owner. So a relation left owned by an earlier
 * integration's role the connecting admin can't act as would stop the plan
 * partway through with a bare `must be owner of table …`. This module detects
 * that up front and turns it into the fix that actually runs.
 *
 * The fix is never `ALTER TABLE … OWNER TO`: reassigning ownership is itself
 * reserved for the current owner, which — by definition of being blocked — the
 * admin isn't. When the admin is a member of the owning role with admin option
 * (the ordinary managed-Postgres case, where it reaches the role only through a
 * NOINHERIT membership it administers), the runnable fix is to make that
 * membership inherit — `GRANT <owner> TO <admin> WITH INHERIT TRUE`, the
 * per-membership INHERIT option Postgres 16 introduced — so the admin acts with
 * the owner's authority and the grants succeed, with no ownership change.
 */
import { z } from 'zod';
import pc from 'picocolors';
import type postgres from 'postgres';
import { quoteIdent } from './connectSetup.js';

/**
 * A relation's ownership as seen from the connected admin. Parsed at the query
 * boundary rather than cast, so a shape drift surfaces as a validation error
 * here instead of an `undefined` field flowing downstream.
 */
export const ownedRelationRowSchema = z.object({
  /** Schema-qualified relation, e.g. `public.records`. */
  relation: z.string(),
  owner: z.string(),
  /**
   * The admin can act as the owner for grants — it owns the relation OR is an
   * INHERITing member of the owning role (`pg_has_role(current_user, owner,
   * 'USAGE')`). A plain NOINHERIT membership is false: the plan doesn't
   * `SET ROLE`, so the grant would fail.
   */
  can_manage: z.boolean(),
  is_superuser: z.boolean(),
  /**
   * The admin is a member of the owning role WITH admin option, so it can run
   * `GRANT <owner> TO <admin> WITH INHERIT TRUE` itself to gain the inheritance
   * the grants need — the runnable fix reassigning ownership can't be.
   */
  can_grant_inherit: z.boolean(),
});
export type OwnedRelationRow = z.infer<typeof ownedRelationRowSchema>;

/** A relation the admin can neither own nor act as owner for. */
export interface OwnershipBlocker {
  readonly relation: string;
  readonly owner: string;
  /** The admin can flip its own membership to inheriting — see `can_grant_inherit`. */
  readonly canGrantInherit: boolean;
}

/**
 * The relations the admin can't grant on — empty when it can manage them all (or
 * is a superuser). Pure, so it is testable without a live connection.
 */
export function ownershipBlockers(
  rows: readonly OwnedRelationRow[]
): readonly OwnershipBlocker[] {
  return rows
    .filter((row) => !row.can_manage && !row.is_superuser)
    .map((row) => ({
      relation: row.relation,
      owner: row.owner,
      canGrantInherit: row.can_grant_inherit,
    }));
}

/**
 * Turn the blocked relations into the fix that runs: one inherit-grant per owning
 * role the admin can self-grant (deduplicated — many tables can share an owner),
 * and the owners it can't as `unresolved` for the honest fallback.
 */
export function ownershipRemediation(
  blockers: readonly OwnershipBlocker[],
  admin: string
): { readonly inheritGrants: readonly string[]; readonly unresolved: readonly OwnershipBlocker[] } {
  const grantableByOwner = new Map<string, boolean>();
  for (const blocker of blockers) {
    grantableByOwner.set(
      blocker.owner,
      (grantableByOwner.get(blocker.owner) ?? false) || blocker.canGrantInherit
    );
  }
  const resolvedOwners = new Set<string>();
  const inheritGrants: string[] = [];
  for (const [owner, grantable] of grantableByOwner) {
    if (grantable) {
      inheritGrants.push(`GRANT ${quoteIdent(owner)} TO ${quoteIdent(admin)} WITH INHERIT TRUE;`);
      resolvedOwners.add(owner);
    }
  }
  const unresolved = blockers.filter((blocker) => !resolvedOwners.has(blocker.owner));
  return { inheritGrants, unresolved };
}

// The ownership columns both preflight queries select, keyed on `current_user`
// aliased `r` and the target relation `c`. One fragment so the two queries can
// never drift in how they judge "can this admin manage this relation".
const OWNERSHIP_COLUMNS = `
        pg_get_userbyid(c.relowner) AS owner,
        pg_has_role(current_user, c.relowner, 'USAGE') AS can_manage,
        r.rolsuper AS is_superuser,
        EXISTS (
          SELECT 1 FROM pg_auth_members m
           WHERE m.member = r.oid AND m.roleid = c.relowner AND m.admin_option
        ) AS can_grant_inherit`;

const OWNERSHIP_FROM = `
   FROM pg_class c
   JOIN pg_namespace n ON n.oid = c.relnamespace
   JOIN pg_roles r ON r.rolname = current_user`;

/**
 * The published tables the admin can't grant on. Scoped to `--tables` when given;
 * otherwise every public base table the "all tables" grant would reach (the
 * ledger is excluded — it has its own check with its own remediation).
 */
export async function publishedTableBlockers(
  sql: postgres.Sql,
  tables: readonly string[],
  schema = 'public'
): Promise<readonly OwnershipBlocker[]> {
  const scoped = tables.length > 0;
  const raw = await sql.unsafe(
    `SELECT format('%I.%I', n.nspname, c.relname) AS relation, ${OWNERSHIP_COLUMNS}
     ${OWNERSHIP_FROM}
      WHERE c.relkind = 'r'
        AND n.nspname = $${scoped ? '2' : '1'}
        AND c.relname <> 'ablo_idempotency'
        ${scoped ? 'AND c.relname = ANY($1)' : ''}`,
    (scoped ? [tables, schema] : [schema]) as never[]
  );
  return ownershipBlockers(z.array(ownedRelationRowSchema).parse(raw));
}

/**
 * The `ablo_idempotency` ledger when it exists and the admin can't manage it, or
 * null. A ledger carried over from an earlier integration may be owned by a role
 * the admin only reaches through a NOINHERIT membership; the setup grants the
 * writer access to it and, on an upgrade, alters it — both reserved for the
 * owner — so surface it now rather than fail partway.
 */
export async function ledgerBlocker(
  sql: postgres.Sql,
  schema = 'public'
): Promise<OwnershipBlocker | null> {
  const raw = await sql.unsafe(
    `SELECT format('%I.%I', n.nspname, c.relname) AS relation, ${OWNERSHIP_COLUMNS}
     ${OWNERSHIP_FROM}
      WHERE c.relkind = 'r'
        AND n.nspname = $1
        AND c.relname = 'ablo_idempotency'`,
    [schema] as never[]
  );
  const rows = z.array(ownedRelationRowSchema).parse(raw);
  const row = rows[0];
  if (!row) return null;
  return ownershipBlockers([row])[0] ?? null;
}

/**
 * The one ownership error apply prints — for the rare case it can't fix itself.
 * Apply grants its admin inheritance of an owning role automatically when it holds
 * admin option on that role; when it doesn't, there is no statement it can run, so
 * it names the relations and the concrete grant an authorized role must run. If
 * the ledger is among them, it also offers the drop, which needs no other role.
 */
export function formatUnresolvedOwnership(
  unresolved: readonly OwnershipBlocker[],
  admin: string,
  target: string
): string {
  const list = unresolved.map((b) => `${b.relation} (owned by ${b.owner})`).join('\n      ');
  const owners = [...new Set(unresolved.map((b) => b.owner))];
  const ownerNames = owners.map((o) => pc.bold(o)).join(', ');
  const grants = owners
    .map((o) => `GRANT ${quoteIdent(o)} TO ${quoteIdent(admin)} WITH INHERIT TRUE;`)
    .join(' ');
  const one = unresolved.length === 1;
  const hasLedger = unresolved.some((b) => b.relation.endsWith('.ablo_idempotency'));
  return (
    pc.red(
      `\n  ${pc.bold(String(unresolved.length))} relation${one ? '' : 's'} on ${target} ` +
        `${one ? 'is' : 'are'} owned by a role ${pc.bold(admin)} can't manage or take over:`
    ) +
    `\n      ${list}\n` +
    `\n  Apply grants your admin inheritance of an owning role for you when it may, but ${admin}\n` +
    `  isn't a member with admin option of ${ownerNames}, so it can't here. Re-run ${pc.bold('--url')} as a\n` +
    `  role that owns ${one ? 'it' : 'them'}, or have a role with admin option on ${ownerNames} (or a\n` +
    `  superuser) run:\n` +
    `      ${pc.cyan(grants)}\n` +
    (hasLedger
      ? `\n  For ${pc.bold('ablo_idempotency')} you can instead drop it — it holds only idempotency replay\n` +
        `  records, safe to drop when no commit is in flight — and Ablo recreates it under this admin:\n` +
        `      ${pc.cyan('DROP TABLE ablo_idempotency;')}\n`
      : '')
  );
}
