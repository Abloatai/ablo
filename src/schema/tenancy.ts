/**
 * Tenancy — the single source of truth for how a model's rows are scoped to a
 * tenant. There are exactly two layers here, and keeping them separate is the
 * whole point:
 *
 *   1. The CANONICAL form — {@link Tenancy}, a Zod discriminated union. This is
 *      what every consumer (provision/RLS, introspection, runtime, CLI) reads
 *      and what crosses the wire in `ModelJSON`. One shape, exhaustively
 *      switchable, so the type system holds the isolation boundary.
 *   2. The AUTHORING form — {@link PolicyInput}, the `policy: { by }` option a
 *      schema author writes. The name follows Postgres/Supabase RLS vocabulary:
 *      a `policy` is the rule that decides which rows a tenant may read.
 *      {@link resolvePolicy} maps it to the canonical {@link Tenancy} at
 *      `model()`-build time (much as Supabase's `create policy` compiles to a
 *      `pg_policy` row), so the authoring vocabulary never reaches the wire or
 *      any consumer.
 *
 * Why one authoring option (`policy`) instead of the old
 * `orgScoped`/`scopedVia`/`orgColumn` trio: those three were synonyms for one
 * decision ("how is this row scoped?"), and the most dangerous of them
 * (`orgScoped: false`) silently exposed a whole table cross-tenant. Collapsing
 * them into a single discriminated union makes the opt-out (`{ by: 'none' }`) a
 * loud, deliberate branch instead of a falsy flag — one concept, one name.
 */

import { z } from 'zod';

/** Default physical tenancy column. The ONLY place this literal is canonical. */
export const DEFAULT_ORG_COLUMN = 'organization_id';

/**
 * Scope a table's rows through a parent table (for rows that carry no tenancy
 * column of their own — e.g. `slide_layers` → slide → deck → org). This is the
 * CANONICAL `parent` payload; authors write the friendlier {@link PolicyInput}
 * `{ by: 'parent', fk, parent }` shape, normalized into this by
 * {@link resolvePolicy}.
 */
export const scopedViaRefSchema = z.object({
  /** Column on THIS table pointing at the parent (e.g. `'team_id'`). */
  localKey: z.string().min(1),
  /** Parent table name (e.g. `'team'`). */
  parentTable: z.string().min(1),
  /** Column on the parent that `localKey` references. Default `'id'`. */
  parentKey: z.string().min(1).optional(),
  /** Column on the parent holding the tenant id. Default {@link DEFAULT_ORG_COLUMN}. */
  parentOrgColumn: z.string().min(1).optional(),
});
export type ScopedViaRef = z.infer<typeof scopedViaRefSchema>;

/** How a model's rows are scoped to a tenant — the CANONICAL, wire-facing form. */
export const tenancySchema = z.discriminatedUnion('kind', [
  /** Row-local tenancy column (default name `organization_id`, overridable). */
  z.object({ kind: z.literal('column'), column: z.string().min(1) }),
  /** Scoped through a parent table's tenancy. */
  z.object({ kind: z.literal('parent'), via: scopedViaRefSchema }),
  /** Not tenant-scoped (global / reference data). */
  z.object({ kind: z.literal('none') }),
]);
export type Tenancy = z.infer<typeof tenancySchema>;

/**
 * The AUTHORING form of tenancy — what a schema author writes as the model's
 * `policy` option (Postgres/Supabase RLS vocabulary: a policy is the rule that
 * scopes which rows a tenant may read). A Zod discriminated union on `by`, so
 * the three branches are mutually exclusive and the dangerous opt-out
 * (`{ by: 'none' }`) is an explicit, named choice rather than a falsy flag.
 *
 * - `{ by: 'column' }`            — row-local tenancy column (the default).
 *   `column` overrides the name (default {@link DEFAULT_ORG_COLUMN}).
 * - `{ by: 'parent', fk, parent }` — inherit tenancy through a foreign key when
 *   this table has no tenancy column of its own. `parentKey` (default `'id'`)
 *   and `parentTenantColumn` (default {@link DEFAULT_ORG_COLUMN}) are overrides.
 * - `{ by: 'none' }`             — genuinely global / reference data. ⚠ Makes
 *   the whole table readable cross-tenant — only correct for tenant-less tables.
 */
export const policyInputSchema = z.discriminatedUnion('by', [
  z.object({
    by: z.literal('column'),
    /** Override the physical tenancy column name. Default {@link DEFAULT_ORG_COLUMN}. */
    column: z.string().min(1).optional(),
  }),
  z.object({
    by: z.literal('parent'),
    /** Column on THIS table pointing at the parent (e.g. `'slideId'`). */
    fk: z.string().min(1),
    /** Parent table name (e.g. `'slides'`). */
    parent: z.string().min(1),
    /** Column on the parent that `fk` references. Default `'id'`. */
    parentKey: z.string().min(1).optional(),
    /** Column on the parent holding the tenant id. Default {@link DEFAULT_ORG_COLUMN}. */
    parentTenantColumn: z.string().min(1).optional(),
  }),
  z.object({ by: z.literal('none') }),
]);
export type PolicyInput = z.infer<typeof policyInputSchema>;

/**
 * Normalize the authoring {@link PolicyInput} into the one canonical
 * {@link Tenancy}. Called once, at `model()`-build, so `ModelDef`/`ModelJSON`
 * and every consumer see only the canonical union. Omitting `policy` defaults
 * to a row-local `organization_id` column.
 */
export function resolvePolicy(input?: PolicyInput): Tenancy {
  if (!input) return { kind: 'column', column: DEFAULT_ORG_COLUMN };
  switch (input.by) {
    case 'column':
      return { kind: 'column', column: input.column ?? DEFAULT_ORG_COLUMN };
    case 'parent':
      return {
        kind: 'parent',
        via: {
          localKey: input.fk,
          parentTable: input.parent,
          parentKey: input.parentKey,
          parentOrgColumn: input.parentTenantColumn,
        },
      };
    case 'none':
      return { kind: 'none' };
  }
}

/**
 * Read the canonical {@link Tenancy} off an already-built model def (or parsed
 * `ModelJSON`), defaulting to a row-local `organization_id` column when absent.
 *
 * This is the READ-side helper — consumers (provision/RLS, membership resolver,
 * DDL, CLI) call it to get a model's tenancy without re-deriving the default in
 * each place. It is NOT the authoring normalizer; that's {@link resolveIsolation}.
 */
export function resolveTenancy(def: { tenancy?: Tenancy }): Tenancy {
  return def.tenancy ?? { kind: 'column', column: DEFAULT_ORG_COLUMN };
}

/** The physical tenancy column for a column-scoped model, else `null`. */
export function tenancyColumn(t: Tenancy): string | null {
  return t.kind === 'column' ? t.column : null;
}
