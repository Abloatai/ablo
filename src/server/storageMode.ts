/**
 * The set of storage modes a `DataAdapter` can run in. An adapter carries one of
 * these as a label for diagnostics; it does not decide routing, which the adapter
 * resolver handles separately. The package defines the enum so that the contract
 * and every adapter agree on the same closed set of values:
 *
 *   - `hosted`     — a database this engine operates on the caller's behalf.
 *   - `selfHosted` — the caller's own database, reached through the same execution
 *                    path as `hosted`.
 *   - `source`     — a caller-owned endpoint that accepts changes over HTTP without
 *                    database credentials.
 *
 * These names describe where the data lives, not anything an end user sees.
 */
import { z } from 'zod';

/** Runtime validator for the storage-mode values; {@link StorageMode} is its inferred type. */
export const storageModeSchema = z.enum(['hosted', 'source', 'selfHosted']);
/** The storage mode an adapter runs in — one of the values described in the module overview. */
export type StorageMode = z.infer<typeof storageModeSchema>;
