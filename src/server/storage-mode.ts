/**
 * `@abloatai/ablo/server` — the storage-mode vocabulary the `DataAdapter`
 * contract supports. Analogous to Better Auth's adapter `id`/`adapterId`: a
 * diagnostic discriminator on the adapter, NOT a routing switch (routing goes
 * through the resolver/factory). The package owns this enum so the contract and
 * every host adapter agree on the closed set:
 *   - `hosted`     — Ablo's control-plane database.
 *   - `selfHosted` — the customer's database, same execution path as hosted.
 *   - `source`     — a customer-owned endpoint (credentialless ingestion).
 */
import { z } from 'zod';

export const storageModeSchema = z.enum(['hosted', 'source', 'selfHosted']);
export type StorageMode = z.infer<typeof storageModeSchema>;
