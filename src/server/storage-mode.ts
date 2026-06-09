/**
 * `@abloatai/ablo/server` — the storage-mode vocabulary the `DataAdapter`
 * contract supports. Analogous to Better Auth's adapter `id`/`adapterId`: a
 * diagnostic discriminator on the adapter, NOT a routing switch (routing goes
 * through the resolver/factory). The package owns this enum so the contract and
 * every host adapter agree on the closed set:
 *   - `hosted`     — Ablo's control-plane database.
 *   - `selfHosted` — the customer's database, same execution path as hosted.
 *   - `source`     — a customer-owned endpoint (credentialless ingestion).
 *
 * @internal Deployment topology, not product vocabulary. Customers never see a
 * "storage mode" — their story is `Ablo({ schema, apiKey, databaseUrl })` and
 * one `datasource` resource (docs/plans/sync-engine-stripe-story-scope.md).
 * This export exists for the sync-server host only.
 */
import { z } from 'zod';

/** @internal See module note — host-deployment vocabulary, never customer-facing. */
export const storageModeSchema = z.enum(['hosted', 'source', 'selfHosted']);
/** @internal See module note — host-deployment vocabulary, never customer-facing. */
export type StorageMode = z.infer<typeof storageModeSchema>;
