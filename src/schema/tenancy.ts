/**
 * Tenancy — the single source of truth for how a model's rows are scoped to a
 * tenant. This replaces three scattered mechanisms (a hardcoded
 * `organization_id` literal, an `orgScoped` boolean, and a `scopedVia` ref) with
 * one Zod discriminated union, resolved in one place and consumed everywhere
 * (provision/RLS, introspection, runtime, CLI).
 *
 * Why a union: every consumer used to re-derive "how is this table scoped?" from
 * a flag plus a literal — a missed branch was a silent cross-tenant scoping bug.
 * A discriminated union makes the `switch` exhaustive, so the type system holds
 * the isolation boundary, and the physical column name lives in exactly one
 * place (the `column` variant) instead of being hardcoded across the codebase.
 */

import { z } from 'zod';

/** Default physical tenancy column. The ONLY place this literal is canonical. */
export const DEFAULT_ORG_COLUMN = 'organization_id';

/**
 * Scope a table's rows through a parent table (for rows that carry no tenancy
 * column of their own — e.g. `slide_layers` → slide → deck → org).
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

/** How a model's rows are scoped to a tenant. */
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
 * Ergonomic authoring shortcuts accepted on a model. These are *input only* —
 * `resolveTenancy` normalizes them into the canonical {@link Tenancy} at
 * model-build time, so they never reach the serialized JSON or any consumer.
 */
export interface TenancyInput {
  tenancy?: Tenancy;
  /** `false` → not tenant-scoped. */
  orgScoped?: boolean;
  /** Scope through a parent table. */
  scopedVia?: ScopedViaRef;
  /** Override the column name for a column-scoped model. */
  orgColumn?: string;
}

/**
 * Normalize authoring sugar into the one canonical {@link Tenancy}. Called once,
 * at model-build, so `ModelDef`/`ModelJSON` and every consumer see only
 * `tenancy`. Precedence: explicit `tenancy` → `scopedVia` → `orgScoped:false` →
 * column (default or `orgColumn`).
 */
export function resolveTenancy(input: TenancyInput): Tenancy {
  if (input.tenancy) return input.tenancy;
  if (input.scopedVia) return { kind: 'parent', via: input.scopedVia };
  if (input.orgScoped === false) return { kind: 'none' };
  return { kind: 'column', column: input.orgColumn ?? DEFAULT_ORG_COLUMN };
}

/** The physical tenancy column for a column-scoped model, else `null`. */
export function tenancyColumn(t: Tenancy): string | null {
  return t.kind === 'column' ? t.column : null;
}
