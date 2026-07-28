/**
 * The conflict types a policy decides on. The engine detects a conflict and
 * hands it to your {@link ConflictPolicy}, which returns a
 * {@link ConflictDecision}.
 *
 * There are two conflict shapes. A {@link StaleContextConflict} is a write
 * whose `readAt` watermark is older than the latest delta on the target row. A
 * {@link ClaimHeldConflict} is a participant trying to claim a target that
 * someone else already holds. {@link Conflict} is the discriminated union of
 * the two; switch on `kind` to narrow it.
 */

import type { z } from 'zod';
import type { ParticipantRef } from '../types/participant.js';
import type { CommitOperationType, OnStaleMode } from '../coordination/schema.js';
import type { conflictAxisWireSchema } from '../wire/accountResponses.js';

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
  readonly type: CommitOperationType;
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
   * intersection of the fields the committer wrote and the columns a newer
   * delta touched. An empty array means the conflicting delta was a
   * whole-entity change, such as a create or delete, which conflicts with any
   * write. A policy can use this to decide at field granularity — for example,
   * allowing the write when the only overlap is on a cosmetic field.
   */
  readonly conflictingFields?: readonly string[];
  /**
   * The committer's declared `onStale` intent for this operation. The default
   * policy honors it: `'notify'` holds the write and notifies, and anything
   * else rejects. A custom policy may override this. When absent, it is treated
   * as `'reject'`, the default for an unguarded write.
   */
  readonly requestedMode?: OnStaleMode;
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
   * The capability operations granted to the committer — the allowlist carried
   * by its key. A policy decides purely from the conflict it is given, so this
   * is the only place it can read the committer's privileges. It lets a policy
   * express a rule such as "preempt only if the committer holds `claim.preempt`"
   * (see {@link capabilityPreemptPolicy}). Empty for a human session that
   * carries no allowlist.
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
   * Evict the current holder and grant the target to the committer. This is
   * only meaningful for a `claim_held` conflict raised at claim time: the
   * holder receives a `claim_lost` notification with reason `'preempted'`, and
   * the committer takes the lease ahead of anyone already waiting in line for
   * it. Return it only for a committer you consider higher priority — for
   * example, a supervisor over its own sub-agents, or an identity that holds a
   * preempt capability. At commit time there is no holder to evict, so a
   * `preempt` decision is treated as `allow`.
   */
  | { readonly action: 'preempt'; readonly reason?: string }
  /**
   * Hold the write instead of aborting it. This is only meaningful for a
   * `stale_context` conflict. The engine withholds the conflicting operation
   * and returns a `StaleNotification` carrying the current value, so the actor
   * — an agent or a human — can reconcile and re-commit. The rest of the batch
   * still commits. It maps from `onStale: 'notify'`.
   *
   * The monotonic `sync_id` landing order decides who yields: the stale
   * committer always recomputes against the newer value, an asymmetry that
   * prevents two notifying writers from looping against each other.
   *
   * That rules out livelock, and NOT starvation. Each round adopts a newer
   * `observedSyncId`, so no baseline repeats — but a peer writing faster than
   * the committer's read→decide→write gap keeps winning, and the rounds are
   * unbounded because the engine does not re-issue: the actor does. Progress in
   * the watermark is not progress in the work. The functional `update(id, fn)`
   * bounds its own loop; a hand-rolled one must bound itself. To stop an actor
   * writing at all while a belief it holds is stale, gate the belief —
   * `track(..., { onStale: 'reject' })` — rather than the write.
   */
  | { readonly action: 'notify'; readonly reason?: string };

/**
 * The function that decides a conflict. It receives a {@link Conflict} and
 * returns a {@link ConflictDecision}, either synchronously or as a promise.
 * Register your implementation with the engine; the example below allows a
 * cosmetic "linter" writer and defers everything else to {@link defaultPolicy}.
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
 * The conflict policy the engine uses when you do not supply your own. It
 * favors people: a human is never blocked, while agents and automated writers
 * yield to a claim someone else holds.
 *
 * For a `claim_held` conflict, the decision follows the committer's kind:
 *
 *   • `user`   → `allow`  — a human is never blocked by a claim. A claim is a
 *                           coordination hint among agents, not a lock on
 *                           people.
 *   • `agent`  → `reject` — an agent yields to a claim held by someone else.
 *                           The one sanctioned exception is the privileged
 *                           `claim.preempt` capability; see
 *                           {@link capabilityPreemptPolicy}.
 *   • `system` → `reject` — automated and backend writers serialize through
 *                           claims the same way agents do, so a server job
 *                           cannot silently overwrite a held row. Declare the
 *                           model's conflict axis to overwrite if you want that.
 *
 * Allowing only `user` by default is deliberate: a backend key is a
 * full-access credential, and claim serialization depends on those writers
 * respecting claims unless a model opts out.
 *
 * For a `stale_context` conflict, the decision honors the committer's declared
 * `onStale` intent: `'notify'` holds the write and notifies the actor to
 * resolve it, and anything else (including `'reject'` or an absent value)
 * rejects. An `onStale` of `'overwrite'` never reaches a policy — it is a hard
 * opt-out resolved before the conflict is detected.
 *
 * To change this behavior for a model, declare its conflict axis in the schema;
 * a declared axis overrides this default.
 */
// Typed by its real synchronous shape with `satisfies`, rather than the
// async-permissive `ConflictPolicy` alias, so synchronous callers such as
// `interpretConflictAxis` and `capabilityPreemptPolicy` receive a plain
// `ConflictDecision` rather than `ConflictDecision | Promise<…>`. It remains
// assignable to `ConflictPolicy` wherever it is used as one.
export const defaultPolicy = ((conflict: Conflict): ConflictDecision => {
  if (conflict.kind === 'claim_held') {
    // A human (`user`) is never blocked; agents and system actors yield.
    // Keeping every non-`user` kind on `reject` here ensures an agent cannot
    // bypass a claim even on this default resolution path, which — unlike the
    // declared-axis path — has no separate agent guard of its own.
    return conflict.committer.kind === 'user'
      ? { action: 'allow', note: 'principal:not-blocked' }
      : { action: 'reject', reason: 'claim_conflict' };
  }
  return conflict.requestedMode === 'notify'
    ? { action: 'notify', reason: 'stale_notify_hold' }
    : { action: 'reject', reason: 'stale_context' };
}) satisfies ConflictPolicy;

/**
 * A ready-made policy that grants capability-gated preemption. When the
 * committer's capability allowlist includes the `claim.preempt` operation, a
 * `claim_held` conflict is preempted: the current holder is evicted and the
 * committer takes the lease. Every other conflict falls back to
 * {@link defaultPolicy}, which rejects. Register it as your conflict policy to
 * let a privileged identity take over a held entity without writing a bespoke
 * policy. The authorization rests on holding the capability, not on any
 * particular identity string.
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
 * A model's declared conflict disposition, keyed by the kind of committer. You
 * set it in the model's schema, for example
 * `conflict: { user: 'overwrite', agent: 'reject' }`, and the engine applies it
 * at commit time. It is plain data using the same `'reject' | 'overwrite' |
 * 'notify'` vocabulary as the write guards, so it travels through the schema
 * registry to the server without naming any application model.
 *
 * Each key is the committer's participant kind, which the server derives and a
 * client cannot forge; an omitted kind falls back to the engine default. So
 * `{ user: 'overwrite', agent: 'reject' }` reads as "a human's write wins, an
 * agent's write yields," and `system`, being unlisted, takes the default.
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
 * The same three members reach the server as `conflictAxisWireSchema`, which is
 * a runtime-validatable zod object rather than an interface — `wire/` is the
 * protocol leaf and cannot import this file, so the two are stated separately
 * and pinned to each other here, on the side of the edge that is allowed to
 * cross. A member added to one and not the other stops compiling.
 *
 * The import is type-only and erases, so nothing in the policy layer pulls the
 * wire module in at runtime.
 */
type _ConflictAxisMatchesWire =
  z.infer<typeof conflictAxisWireSchema> extends ConflictAxis ? true : never;
type _WireMatchesConflictAxis =
  ConflictAxis extends z.infer<typeof conflictAxisWireSchema> ? true : never;
const _conflictAxisPinned: [_ConflictAxisMatchesWire, _WireMatchesConflictAxis] = [true, true];
void _conflictAxisPinned;

/**
 * Resolves a declared {@link ConflictAxis} into a {@link ConflictDecision} for
 * one concrete conflict. It is pure and synchronous, doing no I/O, so it can
 * run on either the client or the server. It reads the committer's kind from
 * the conflict and maps the declared mode:
 *
 *   - undefined   → the engine default, {@link defaultPolicy}: a human is
 *                   allowed, an agent or system committer is rejected on a
 *                   `claim_held`, and a stale write honors `onStale: 'notify'`.
 *   - `overwrite` → `allow`; the write wins and the committer is never blocked.
 *   - `reject`    → `reject`; the committer yields.
 *   - `notify`    → on a `stale_context` conflict, hold the write and notify so
 *                   the committer re-reads and re-applies; on a `claim_held`
 *                   conflict there is no held write to reconcile (see
 *                   {@link ConflictDecision} `notify`), so it degrades to
 *                   `reject` rather than silently writing to a claimed row.
 *
 * This is only the generic interpretation. Stronger server-side rules — such as
 * an agent never bypassing a claim held by someone else — are enforced where
 * the decision is applied, not here.
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

