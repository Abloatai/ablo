/**
 * Database PLANE — which database a model's rows live in. A sibling axis to
 * `tenancy` (which says how rows are isolated *within* a database):
 *
 *   - `tenant`  — the tenant data plane. For a BYO/dedicated customer this is
 *                 THEIR database; provisioning emits these tables there.
 *   - `control` — Ablo's control plane (the sync log, attribution, audit, …).
 *                 Never emitted into a customer DB; lives only in Ablo's own DB.
 *
 * P1 of the sync-delta decomposition (`docs/plans/sync-delta-zod-decomposition.md`):
 * declaring the boundary lets BYO provisioning *derive* "what a customer DB gets"
 * (`plane === 'tenant'`) instead of hand-coding it. Defaults to `tenant` —
 * today every `defineSchema` model is the customer's own data; only Ablo's
 * internal tables (once modeled in P2) declare `control`.
 */

import { z } from 'zod';

export const planeSchema = z.enum(['tenant', 'control']);
export type SchemaPlane = z.infer<typeof planeSchema>;

/** Default plane for a model that doesn't declare one — the tenant data plane. */
export const DEFAULT_PLANE: SchemaPlane = 'tenant';
