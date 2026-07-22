/**
 * Per-call options accepted by any mutation.
 *
 * Every field here defines, orders, settles, or authorises *the change itself*
 * — request identity, commit disposition, fencing, and the premise it rests on.
 * None of it touches a local copy of rows, so it belongs with the settlement
 * core rather than the reactive consumer (ADR 0013 §4, ADR 0016).
 */

import type { CommitWait } from '../wire/commit.js';
import type { OnStaleMode, ReadDependency, TrackDependency } from '../coordination/schema.js';

/**
 * Per-call options accepted by any mutation, passed as the last argument.
 * Every field is optional; omitted fields fall back to sensible defaults.
 *
 * - `idempotencyKey` — when set, the server caches the response for 24 hours and
 *   returns the cached result on any retry using the same key. When omitted, the
 *   SDK generates a fresh UUID per mutation, so every call is retry-safe by
 *   default. `null` is retained for source compatibility and is treated like
 *   omission; write retries never opt out of request identity.
 * - `label` — a human-readable tag recorded with the mutation for debugging, such
 *   as "nightly cleanup" or "user click".
 */
export interface MutationOptions {
  idempotencyKey?: string | null;
  label?: string;
  wait?: CommitWait;
  readAt?: number | null;
  onStale?: OnStaleMode | null;
  /**
   * The fencing token (Option B) of the held claim this write belongs to. The
   * server validates it against the entity's persisted high-water and rejects a
   * stale token. Sourced from the claim handle, never set by hand.
   */
  fenceToken?: number | null;
  /** The id (or `{ id }`) of the claim this write belongs to. This is the
   *  low-level reference the commit carries so the write is attributed to a claim
   *  and can pass the holder's own lock. It is distinct from the `claim` handle on
   *  the model write parameters, which is the higher-level object you usually pass. */
  claimRef?: string | { readonly id: string } | null;
  /**
   * The batch premise — the answer to "did anything I looked at change?" Each
   * entry is a row (`{ model, id, readAt, fields? }`) or a sync group
   * (`{ group, readAt }`) that this write was premised on. The server checks
   * that none of them moved since their `readAt` and applies the entry's
   * `onStale` behavior to the whole batch. This is distinct from the per-operation
   * `readAt`, which guards only the row being written.
   *
   * See `packages/sync-engine/docs/concurrency-convention.md` (§3 the two
   * premises, §4 the batch premise) for the governing convention.
   */
  reads?: ReadDependency[] | null;
  /**
   * Durable premises — what this write (or the record it produces) should
   * keep watching. Unlike `reads`, which is checked once at commit and discarded,
   * each `track` entry is persisted and re-checked against every future delta; a
   * later matching change opens a `StaleNotification` for the tracking participant,
   * delivered at their next commit or live to a held claim. Each entry is a row
   * (`{ model, id }`) or a sync group (`{ group }`), optionally pinned to a `readAt`
   * baseline (defaults to this commit's watermark).
   *
   * See `packages/sync-engine/docs/groups.md` for how `track` drives propagation.
   */
  track?: TrackDependency[] | null;
}
