/**
 * Model RESIDENCY — which database a model's rows live in. A sibling axis to
 * `tenancy` (which says how rows are isolated *within* a database):
 *
 *   - `tenant`  — the tenant data plane. For a customer-connected database
 *                 this is THEIR database; provisioning emits these tables there.
 *   - `control` — Ablo's control plane (the sync log, attribution, audit, …).
 *                 Never emitted into a customer DB; lives only in Ablo's own DB.
 *
 * Named `residency` (not `plane`) because "plane" is the server's tenancy
 * scope — (org, environment[, project, sandbox]) — the dominant meaning in the
 * engine. The serialized model option is still the `plane` KEY (wire format,
 * frozen until the next wire-version bump); only the TS vocabulary moved.
 *
 * P1 of the sync-delta decomposition (`docs/plans/sync-delta-zod-decomposition.md`):
 * declaring the boundary lets provisioning *derive* "what a customer DB gets"
 * (`residency === 'tenant'`) instead of hand-coding it. Defaults to `tenant`.
 */

import { z } from 'zod';

export const residencySchema = z.enum(['tenant', 'control']);
export type ModelResidency = z.infer<typeof residencySchema>;

/** Default residency for a model that doesn't declare one — the tenant data plane. */
export const DEFAULT_RESIDENCY: ModelResidency = 'tenant';

// ── Deprecated aliases (published schema subpath) ───────────────────────────
/** @deprecated Use `residencySchema`. */
export const planeSchema = residencySchema;
/** @deprecated Use `ModelResidency`. */
export type SchemaPlane = ModelResidency;
/** @deprecated Use `DEFAULT_RESIDENCY`. */
export const DEFAULT_PLANE = DEFAULT_RESIDENCY;
