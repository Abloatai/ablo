/**
 * `@abloatai/ablo/server` — the COMMIT contract types.
 *
 * `CommitContext` is the attribution/claim envelope the host's commit executor
 * stamps onto every delta a batch produces; `CommitResult` is the receipt. Both
 * are PURE descriptors (no `postgres`, no SQL, no functions), which is why they
 * live in the portable package while the SQL engine that consumes them
 * (`executeCommit`) stays host-side. They feed the `ChangeSet`/`DataAdapter`
 * contract.
 *
 * The attribution fields reuse the canonical `ParticipantKind` /
 * `ConfirmationState` / `ParticipantRef` so the commit-time shape and the
 * stored/broadcast delta shape share ONE source of truth (these were previously
 * a server-local interface "kept in sync by convention").
 */
import type { ParticipantKind, ConfirmationState } from '../schema/sync-delta-row.js';
import type { ParticipantRef } from '../schema/sync-delta-wire.js';
import type { Environment } from '../environment.js';
import type { StaleNotification, ReadDependency } from '../coordination/schema.js';

export interface CommitContext {
  participantId: string;
  /**
   * Typed participant classification — required so every delta written through
   * the commit executor carries structured attribution, not a string-prefix
   * convention.
   */
  participantKind: ParticipantKind;
  organizationId: string;
  /**
   * Product/project scope for routing source-mode storage. Omitted means the
   * org-default project (the legacy behavior).
   */
  projectId?: string;
  /** Optional external account scope forwarded to storage resolvers. */
  accountScope?: string;
  /**
   * Canonical environment for this commit. Source-mode adapters forward this to
   * customer handlers so sandbox and production traffic can hit distinct
   * customer-owned stores.
   */
  environment?: Environment;
  /**
   * The participant's own subscribed sync groups (from the WS upgrade or
   * capability token). Appended to every delta's `sync_groups` so writes fan
   * out to agents scoped to entity-level groups (e.g. `deck:abc`), not only the
   * default `org:X` / `user:Y` surface. Callers that omit this fall back to the
   * legacy `[org, user]` broadcast behavior.
   */
  syncGroups?: readonly string[];
  /**
   * Sandbox keys should not stamp `org:<organizationId>` on deltas — otherwise
   * live org subscribers would see test-environment writes.
   */
  omitOrgSyncGroup?: boolean;
  /**
   * On-behalf-of attribution — whose authority the actor acted under. For
   * human-direct commits, equals the actor. For agent commits, the human at the
   * root of the capability's delegation chain. Null for `system` principals.
   */
  onBehalfOf?: ParticipantRef | null;
  /**
   * Scoped credential id. Non-null for agent / system commits when the
   * authorizing credential is known; null for human-direct commits.
   */
  capabilityId?: string | null;
  /**
   * Human user id at the root of the delegated authority chain. Stored directly
   * on `sync_deltas` so audit triggers never need to join mutable credential
   * tables while appending the hash chain.
   */
  delegationChainRootUserId?: string | null;
  /**
   * ApiKey row id when the caller authenticated with an API key. Used by the
   * idempotency cache and usage attribution. Null for session / capability
   * callers.
   */
  apiKeyId?: string | null;
  /**
   * Whether the human explicitly approved the change. Defaults to `auto` until
   * the chat-side previewed/approved plumbing lands.
   */
  confirmationState?: ConfirmationState;
  /**
   * Dormant FK to the agent-task id (`agent_tasks.id`). The SDK no longer
   * sets it (turns/tasks removed; attribution rides on the claim/claim id
   * + server-stamped actor/capability). Still validated + written onto
   * `caused_by_task_id` when present, but client writes leave it `null`.
   */
  causedByTaskId?: string | null;
  /**
   * Batch-level read dependencies (the STORM read-set layer). The committer
   * declares rows/groups it READ to form this batch; the engine validates none
   * changed since their `readAt` and fires each entry's `onStale` disposition
   * over the whole batch. Distinct from the per-op `readAt` guard, which only
   * validates the rows being WRITTEN. Omit for write-target-only checking.
   */
  reads?: ReadDependency[] | null;
}

/**
 * The receipt of a commit. Pins the exact `sync_deltas` id range the batch
 * produced, so a caller can broadcast just THIS batch's deltas
 * (`getDeltasInRange(firstSyncId - 1, lastSyncId, …)`) without racing concurrent
 * commits with adjacent ids. `firstSyncId` is 0 when the batch produced no
 * deltas (empty ops / all no-ops).
 */
export interface CommitResult {
  lastSyncId: number;
  firstSyncId: number;
  /**
   * Stale-context notifications for ops the committer guarded with
   * `onStale: 'notify'. Present (non-empty) only when a guarded write
   * collided with a concurrent change; the committer self-heals from these
   * rather than receiving an `AbloStaleContextError`. See
   * `StaleNotification` in `coordination/schema.ts`.
   */
  notifications?: StaleNotification[];
  /**
   * Ids of UPDATE/DELETE targets that matched ZERO rows — the row doesn't
   * exist (or is outside the caller's org). The engine has always detected
   * this (and logged it); surfacing it here lets the client turn a silent
   * no-op into a loud `AbloNotFoundError`. Present (non-empty) only when at
   * least one op missed. Ids are globally-unique uuids, so a caller can match
   * its own target id against this set without ambiguity.
   */
  missingIds?: string[];
}
