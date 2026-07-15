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
 * The canonical form is an exhaustively switchable discriminated union, so the type
 * system enforces the isolation boundary at every consumer. The authoring form is a
 * flat object whose `by` names the choice and whose per-branch rules are checked by a
 * refinement — the opt-out from tenant scoping (`{ by: 'none' }`) and the
 * source-derived case (`{ by: 'source' }`) are explicit, named values rather than
 * falsy flags, important because `none` makes an entire table readable across tenants.
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
  /**
   * Scoped by the data source itself: the model carries no tenancy column, and the
   * owning organization is derived from the connected source that registered it — the
   * registration is the tenant boundary. This is the natural default for a
   * single-tenant connected database (`ablo connect`), which holds one org's rows and
   * so has no per-row `organization_id` to read. Carries no payload for the same
   * reason `none` does: the binding lives in the source registration, not the model.
   */
  z.object({ kind: z.literal('source') }),
]);
export type Tenancy = z.infer<typeof tenancySchema>;

/**
 * The authoring form of tenancy — what a schema author writes as the model's
 * `policy` option. The name follows SQL row-level security, where a policy is the
 * rule that decides which rows a tenant may read.
 *
 * The four choices `by` can take:
 *
 * - `{ by: 'column' }` — a row-local tenancy column (the default). `column`
 *   overrides the name (default {@link DEFAULT_ORG_COLUMN}).
 * - `{ by: 'parent', fk, parent }` — inherit tenancy through a foreign key when
 *   this table has no tenancy column of its own. `parentKey` (default `'id'`) and
 *   `parentTenantColumn` (default {@link DEFAULT_ORG_COLUMN}) are optional overrides.
 * - `{ by: 'source' }` — derive the organization from the connected source that
 *   registered the model, for a single-tenant connected database that carries no
 *   `organization_id` column. The registration is the tenant boundary.
 * - `{ by: 'none' }` — genuinely global or reference data. This makes the whole
 *   table readable across tenants, so it is correct only for tables that have no tenant.
 *
 * The runtime schema is one flat object rather than a discriminated union: `by`
 * selects the branch, and the {@link https://zod.dev | superRefine} pass enforces
 * the per-branch field rules (`parent` requires `fk` and `parent`; the other three
 * take no branch fields). The exported {@link PolicyInput} type is hand-written as a
 * precise union so the compiler still requires the right fields per `by` — the flat
 * schema validates at runtime, the union guides at author time, and the type guard
 * below keeps the two from drifting.
 */
export const policyInputSchema = z
  .object({
    by: z.enum(['column', 'parent', 'none', 'source']),
    /** `by: 'column'` — override the physical tenancy column name. Default {@link DEFAULT_ORG_COLUMN}. */
    column: z.string().min(1).optional(),
    /** `by: 'parent'` — column on this table that points at the parent (for example, `'slideId'`). */
    fk: z.string().min(1).optional(),
    /** `by: 'parent'` — parent table name (e.g. `'slides'`). */
    parent: z.string().min(1).optional(),
    /** `by: 'parent'` — column on the parent that `fk` references. Default `'id'`. */
    parentKey: z.string().min(1).optional(),
    /** `by: 'parent'` — column on the parent holding the tenant id. Default {@link DEFAULT_ORG_COLUMN}. */
    parentTenantColumn: z.string().min(1).optional(),
  })
  .superRefine((policy, ctx) => {
    if (policy.by === 'parent') {
      if (!policy.fk) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fk'],
          message:
            "A `by: 'parent'` policy needs `fk` — the column on this table that points at the parent row whose tenancy it inherits.",
        });
      }
      if (!policy.parent) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['parent'],
          message:
            "A `by: 'parent'` policy needs `parent` — the name of the parent table this table is scoped through.",
        });
      }
    }
    // A `column` policy may carry `column`; the parent fields belong only to `parent`.
    // Flag a field that landed on the wrong branch so a typo doesn't silently no-op.
    const parentOnly = ['fk', 'parent', 'parentKey', 'parentTenantColumn'] as const;
    if (policy.by !== 'parent') {
      for (const field of parentOnly) {
        if (policy[field] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `\`${field}\` only applies to a \`by: 'parent'\` policy; remove it or set \`by: 'parent'\`.`,
          });
        }
      }
    }
    if (policy.by !== 'column' && policy.column !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['column'],
        message: "`column` only applies to a `by: 'column'` policy; remove it or set `by: 'column'`.",
      });
    }
  });

/**
 * The precise authoring type. Hand-written rather than inferred from
 * {@link policyInputSchema} so the compiler enforces the per-branch fields the flat
 * runtime schema can only check at parse time — an author writing `{ by: 'parent' }`
 * gets a type error for the missing `fk`/`parent`, not a runtime one.
 */
export type PolicyInput =
  | { by: 'column'; column?: string }
  | { by: 'parent'; fk: string; parent: string; parentKey?: string; parentTenantColumn?: string }
  | { by: 'source' }
  | { by: 'none' };

// Drift guard: every PolicyInput branch must be representable by the flat schema, so
// the two definitions cannot fall out of sync without a compile error here.
type _PolicyInputMatchesSchema = PolicyInput extends z.input<typeof policyInputSchema> ? true : never;
const _policyInputAssignable: _PolicyInputMatchesSchema = true;
void _policyInputAssignable;

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
    case 'source':
      return { kind: 'source' };
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
