/**
 * Defines how a model's rows are scoped to a tenant. Two forms live here, and the
 * separation between them is deliberate:
 *
 *   1. The canonical form, {@link Tenancy} — a discriminated union that every
 *      consumer reads (provisioning and row-level security, introspection, the
 *      runtime, and the CLI) and the shape that crosses the wire in `ModelJSON`.
 *      One exhaustively switchable shape, so the type system enforces the isolation
 *      boundary.
 *   2. The authoring form, {@link PolicyInput} — the `policy: { by }` option a
 *      schema author writes. The name follows SQL row-level security, where a
 *      policy is the rule that decides which rows a tenant may read.
 *      {@link resolvePolicy} converts it to the canonical {@link Tenancy} when the
 *      model is built, so the authoring vocabulary never reaches the wire or any
 *      consumer.
 *
 * Both forms discriminate on a single tag, which makes the opt-out from tenant
 * scoping (`{ by: 'none' }`) an explicit, named branch rather than a falsy flag —
 * important, because that branch makes an entire table readable across tenants.
 */

import { z } from 'zod';

/** The default physical tenancy column. This is the single canonical definition of that column name. */
export const DEFAULT_ORG_COLUMN = 'organization_id';

/**
 * Scopes a table's rows through a parent table, for rows that carry no tenancy
 * column of their own (for example, slide layers scoped through their slide, deck,
 * and organization). This is the canonical `parent` payload; authors write the
 * friendlier {@link PolicyInput} `{ by: 'parent', fk, parent }` form, which
 * {@link resolvePolicy} normalizes into this.
 */
export const scopedViaRefSchema = z.object({
  /** Column on this table that points at the parent (for example, `'team_id'`). */
  localKey: z.string().min(1),
  /** Parent table name (e.g. `'team'`). */
  parentTable: z.string().min(1),
  /** Column on the parent that `localKey` references. Default `'id'`. */
  parentKey: z.string().min(1).optional(),
  /** Column on the parent holding the tenant id. Default {@link DEFAULT_ORG_COLUMN}. */
  parentOrgColumn: z.string().min(1).optional(),
});
export type ScopedViaRef = z.infer<typeof scopedViaRefSchema>;

/** How a model's rows are scoped to a tenant — the canonical, wire-facing form. */
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
 * The authoring form of tenancy — what a schema author writes as the model's
 * `policy` option. The name follows SQL row-level security, where a policy is the
 * rule that decides which rows a tenant may read. It is a discriminated union on
 * `by`, so the three branches are mutually exclusive and the opt-out
 * (`{ by: 'none' }`) is an explicit, named choice rather than a falsy flag.
 *
 * - `{ by: 'column' }` — a row-local tenancy column (the default). `column`
 *   overrides the name (default {@link DEFAULT_ORG_COLUMN}).
 * - `{ by: 'parent', fk, parent }` — inherit tenancy through a foreign key when
 *   this table has no tenancy column of its own. `parentKey` (default `'id'`) and
 *   `parentTenantColumn` (default {@link DEFAULT_ORG_COLUMN}) are optional overrides.
 * - `{ by: 'none' }` — genuinely global or reference data. This makes the whole
 *   table readable across tenants, so it is correct only for tables that have no tenant.
 */
export const policyInputSchema = z.discriminatedUnion('by', [
  z.object({
    by: z.literal('column'),
    /** Override the physical tenancy column name. Default {@link DEFAULT_ORG_COLUMN}. */
    column: z.string().min(1).optional(),
  }),
  z.object({
    by: z.literal('parent'),
    /** Column on this table that points at the parent (for example, `'slideId'`). */
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
 * Normalizes the authoring {@link PolicyInput} into the canonical {@link Tenancy}.
 * Called once, when the model is built, so that `ModelDef`, `ModelJSON`, and every
 * consumer see only the canonical union. Omitting `policy` defaults to a row-local
 * `organization_id` column.
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
 * Reads the canonical {@link Tenancy} off an already-built model definition (or a
 * parsed `ModelJSON`), defaulting to a row-local `organization_id` column when it is
 * absent.
 *
 * This is the read-side helper. Consumers — provisioning and row-level security, the
 * membership resolver, DDL generation, and the CLI — call it to get a model's
 * tenancy without re-deriving the default each time. It is not the authoring
 * normalizer; that is {@link resolvePolicy}.
 */
export function resolveTenancy(def: { tenancy?: Tenancy }): Tenancy {
  return def.tenancy ?? { kind: 'column', column: DEFAULT_ORG_COLUMN };
}

/** The physical tenancy column for a column-scoped model, else `null`. */
export function tenancyColumn(t: Tenancy): string | null {
  return t.kind === 'column' ? t.column : null;
}
