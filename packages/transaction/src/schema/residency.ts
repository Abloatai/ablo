/**
 * A model's residency: which database its rows live in. This is a sibling axis
 * to `tenancy`, which instead describes how rows are isolated within a single
 * database.
 *
 *   - `tenant`  — the tenant data plane. For a customer-connected database this
 *                 is the customer's own database, and provisioning creates these
 *                 tables there.
 *   - `control` — the coordination plane the engine owns: the change log,
 *                 attribution, audit, and the like. These tables are never
 *                 created in a customer's database.
 *
 * The name is `residency` rather than `plane` because "plane" already refers to
 * the server's tenancy scope — organization, environment, and optionally
 * project and sandbox. On the wire the serialized option is still keyed as
 * `plane`, a frozen part of the wire format; only the TypeScript name differs.
 *
 * Declaring this boundary lets provisioning derive what a customer's database
 * receives — the models whose residency is `tenant` — rather than hand-coding
 * that list. Defaults to `tenant`.
 */

import { z } from 'zod';

export const residencySchema = z.enum(['tenant', 'control']);
export type ModelResidency = z.infer<typeof residencySchema>;

/** Default residency for a model that doesn't declare one — the tenant data plane. */
export const DEFAULT_RESIDENCY: ModelResidency = 'tenant';

