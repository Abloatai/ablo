/**
 * Conflict policy — the engine detects, the policy decides.
 *
 * Two conflict shapes today: `stale_context` (a write whose `readAt`
 * is older than the latest delta on the target) and `claim_held`
 * (a participant claims a target someone else is already claiming).
 * Adding new shapes is additive on the discriminated union.
 */

import type { ParticipantRef } from '../types/streams.js';
import type { OnStaleMode } from '../coordination/schema.js';

export type ConflictKind = 'stale_context' | 'claim_held';

/** Fields shared by every conflict shape. */
interface ConflictBase {
  readonly committer: ParticipantRef;
  readonly organizationId: string;
  /** Human at the root of the committer's delegation chain (if any). */
  readonly delegationChainRootUserId?: string | null;
}

/** The operation whose write conflicts. */
export interface ConflictOperation {
  readonly model: string;
  readonly id: string;
  readonly type: 'CREATE' | 'UPDATE' | 'DELETE' | 'ARCHIVE' | 'UNARCHIVE';
  readonly input?: Readonly<Record<string, unknown>>;
}

export interface StaleContextConflict extends ConflictBase {
  readonly kind: 'stale_context';
  readonly operation: ConflictOperation;
  /** Watermark the committer reasoned against. */
  readonly readAt: number;
  /** Most recent delta id on the target. */
  readonly observedSyncId: number;
  /**
   * The fields whose concurrent change triggered this conflict — the
   * intersection of the committer's written fields and the columns a
   * newer delta touched. Empty array means the conflicting delta was a
   * whole-entity change (CREATE/DELETE, or a pre-`changed_fields`
   * legacy delta), which conflicts with any write. Lets a policy decide
   * at field granularity, e.g. allow when the only collision is on a
   * cosmetic field. See `docs/internal/per-field-conflict-detection.md`.
   */
  readonly conflictingFields?: readonly string[];
  /**
   * The committer's declared `onStale` intent for this op. The default policy
   * honors it: `'notify'` → notify+hold, anything else → reject. A custom policy
   * may override (e.g. gate notify on claim ownership). Absent ⇒ treat as
   * `'reject'` (the unguarded-write default).
   */
  readonly requestedMode?: 'reject' | 'overwrite' | 'notify';
}

export interface ClaimHeldConflict extends ConflictBase {
  readonly kind: 'claim_held';
  readonly heldBy: ParticipantRef;
  readonly claimId: string;
  readonly entityType: string;
  readonly entityId: string;
  /** Holder's claim expiry (ms since epoch). */
  readonly expiresAt: number;
  /**
   * The committer's granted capability operations (the key's allowlist). A
   * policy is a pure function of the conflict value, so it can only authorize
   * on what's carried here — this is what lets a policy express "preempt iff
   * the committer holds `claim.preempt`" (see `capabilityPreemptPolicy`).
   * Empty for a human session with no allowlist.
   */
  readonly committerOperations: readonly string[];
}

/**
 * The discriminated union the policy receives. Switch on `.kind` to
 * narrow to the variant.
 */
export type Conflict = StaleContextConflict | ClaimHeldConflict;

/** What the policy returns. */
export type ConflictDecision =
  | { readonly action: 'reject'; readonly reason?: string }
  | { readonly action: 'allow'; readonly note?: string }
  /**
   * Evict the current holder and grant the target to the committer. Only
   * meaningful for an `claim_held` conflict at claim time (`claim_begin`):
   * the holder receives an `claim_lost` (reason `'preempted'`) and the
   * preemptor takes the lease, jumping ahead of any FIFO waiters. This is the
   * authorization seam for preemption — a policy returns `preempt` only for a
   * committer it deems higher-priority (e.g. a supervisor over its sub-agents,
   * or an identity holding a preempt capability). At commit time there is no
   * holder to evict, so a `preempt` decision there is treated as `allow`.
   */
  | { readonly action: 'preempt'; readonly reason?: string }
  /**
   * Notify-instead-of-abort (non-coercion). Only meaningful for a
   * `stale_context` conflict, and the engine's aligned disposition: HOLD the
   * conflicting op (don't write it) and return a `StaleNotification` with the
   * current value so the actor (agent or human) resolves and re-commits. The
   * rest of the batch still commits. Maps from `onStale: 'notify'`.
   *
   * Serialization order is supplied by the monotonic `sync_id` landing order
   * (the stale committer always yields/recomputes — an asymmetry that rules out
   * a symmetric notify-rewrite livelock). Unbounded retry is bounded by the
   * client's reconciliation retry cap.
   */
  | { readonly action: 'notify'; readonly reason?: string };

/**
 * Pluggable decision function. Sync or async.
 *
 * ```ts
 * const policy: ConflictPolicy = (conflict) => {
 *   if (conflict.committer.id.startsWith('linter:')) {
 *     return { action: 'allow', note: 'cosmetic writer' };
 *   }
 *   return defaultPolicy(conflict);
 * };
 * ```
 */
export type ConflictPolicy = (
  conflict: Conflict,
) => ConflictDecision | Promise<ConflictDecision>;

/**
 * Default policy.
 *
 * `claim_held` conflicts always reject (a foreign claim is honored unless a
 * privileged policy preempts). `stale_context` conflicts honor the committer's
 * declared `onStale` intent:
 *
 *   • `'notify'` → notify + hold (op withheld; the actor resolves)
 *   • anything else (incl. `'reject'`, absent) → reject
 *
 * `'overwrite'` never reaches a policy — it's a hard opt-out resolved before
 * detection. This preserves the legacy always-reject default for callers that
 * don't opt into `notify`.
 */
// Typed by its real SYNCHRONOUS shape (via `satisfies`) rather than the
// async-permissive `ConflictPolicy` alias, so sync callers like
// `interpretConflictAxis` and `capabilityPreemptPolicy` get a plain
// `ConflictDecision` back (not `… | Promise<…>`). Still assignable to
// `ConflictPolicy` everywhere it's used as a policy.
export const defaultPolicy = ((conflict: Conflict): ConflictDecision => {
  if (conflict.kind !== 'stale_context') {
    return { action: 'reject', reason: 'claim_conflict' };
  }
  return conflict.requestedMode === 'notify'
    ? { action: 'notify', reason: 'stale_notify_hold' }
    : { action: 'reject', reason: 'stale_context' };
}) satisfies ConflictPolicy;

/**
 * Capability-gated preemption. An `claim_held` conflict is PREEMPTED when the
 * committer holds the `claim.preempt` operation in its capability allowlist
 * (the holder is evicted, the committer takes the lease); everything else falls
 * back to `defaultPolicy` (reject). Opt-in — wire it as a `conflictPolicies`
 * global to let a privileged identity jump a held entity without a bespoke
 * policy. The authorization is the capability, not an identity string.
 */
export const capabilityPreemptPolicy: ConflictPolicy = (conflict) => {
  if (
    conflict.kind === 'claim_held' &&
    conflict.committerOperations.includes('claim.preempt')
  ) {
    return { action: 'preempt', reason: 'capability:claim.preempt' };
  }
  return defaultPolicy(conflict);
};

/**
 * **Axis 3 — declared write-conflict disposition, per committer kind.**
 *
 * A model declares this in its schema (`conflict: { user: 'overwrite', agent:
 * 'reject' }`); the generic engine interprets it at the commit chokepoint. It's
 * pure data — the same `OnStaleMode` vocabulary used by write guards
 * (`'reject' | 'overwrite' | 'notify'`) — so it serializes through the schema
 * registry to the schema-agnostic server, which names no app model.
 *
 * Keys are the COMMITTER's participant kind (server-derived, forge-proof): an
 * omitted kind falls through to the engine default. So `{ user: 'overwrite',
 * agent: 'reject' }` reads "a human's write wins (never blocked); an agent's
 * write yields", and `system` (unlisted) takes the default.
 */
export interface ConflictAxis {
  /** What happens when a human (`user` session) commits into a conflict. */
  readonly user?: OnStaleMode;
  /** What happens when an AI `agent` commits into a conflict. */
  readonly agent?: OnStaleMode;
  /** What happens when a `system` / automation actor commits into a conflict. */
  readonly system?: OnStaleMode;
}

/**
 * Interpret a declared {@link ConflictAxis} for a concrete conflict — pure and
 * synchronous (no I/O), so it runs on either side of the schema-agnostic
 * boundary. Looks up the committer's kind and maps the declared `OnStaleMode`:
 *
 *   - undefined   → the engine default (`defaultPolicy`: reject; honor
 *                   `onStale: 'notify'` on a stale write)
 *   - `overwrite` → `allow` — the write wins / the committer is never blocked
 *   - `reject`    → `reject` — the committer yields
 *   - `notify`    → on `stale_context`: notify + hold (re-read & re-apply);
 *                   on `claim_held`: notify has no held op to reconcile against
 *                   (see {@link ConflictDecision} `notify`), so degrade to
 *                   `reject` rather than silently allowing a claimed-row write.
 *
 * NOTE: this is a generic interpretation only. Server-side invariants (e.g. an
 * agent may never bypass a foreign claim) are enforced where the decision is
 * applied, not here.
 */
export function interpretConflictAxis(
  axis: ConflictAxis,
  conflict: Conflict,
): ConflictDecision {
  const mode = axis[conflict.committer.kind];
  if (mode === undefined) return defaultPolicy(conflict);
  switch (mode) {
    case 'overwrite':
      return { action: 'allow', note: 'conflict:overwrite' };
    case 'reject':
      return {
        action: 'reject',
        reason: conflict.kind === 'claim_held' ? 'claim_conflict' : 'stale_context',
      };
    case 'notify':
      return conflict.kind === 'stale_context'
        ? { action: 'notify', reason: 'stale_notify_hold' }
        : { action: 'reject', reason: 'claim_conflict' };
    default: {
      // Exhaustiveness backstop: a future `OnStaleMode` member surfaces as a
      // localized compile error here, not a missing-return at the signature.
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

