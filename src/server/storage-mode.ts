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
 * Deployment topology, not product vocabulary. Customers never see a
 * "storage mode" — their story is `ablo connect` (WAL replication: reads tail
 * their database's logical-replication stream, the data stays in their DB)
 * with the signed `dataSource()` endpoint as the marked fallback (ADR 0002,
 * docs/decisions/0002-read-path-logical-replication-vs-data-hosting.md).
 * The `databaseUrl` dial-in that this enum's `selfHosted` arm serves is
 * DEPRECATED pending the WAL read cutover — do not build on it.
 * This export exists for the sync-server host only.
 *
 * NOT `@internal`-tagged: tsconfig.build.json sets `stripInternal`, and these
 * symbols are re-exported by `server/index.ts` — tagging them strips them from
 * the emitted d.ts, leaving an empty `export {}` module behind a live
 * re-export. `skipLibCheck` masks the break and `StorageMode` silently
 * degrades to an error-any for every dist consumer (the sync-server host).
 */
import { z } from 'zod';

/** See module note — host-deployment vocabulary, never customer-facing. */
export const storageModeSchema = z.enum(['hosted', 'source', 'selfHosted']);
/** See module note — host-deployment vocabulary, never customer-facing. */
export type StorageMode = z.infer<typeof storageModeSchema>;
