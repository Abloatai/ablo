/**
 * `@abloatai/ablo/server` — the COMMIT contract types.
 *
 * `CommitContext` is the attribution/intent envelope the host's commit executor
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
   * FK to AgentCapabilityRoot.capabilityId. Non-null for agent / system commits
   * authorized by a Biscuit; null for human-direct commits. Embedded in every
   * delta so the audit chain "delta → capability → human" is one FK hop.
   */
  capabilityId?: string | null;
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
   * sets it (turns/tasks removed; attribution rides on the claim/intent id
   * + server-stamped actor/capability). Still validated + written onto
   * `caused_by_task_id` when present, but client writes leave it `null`.
   */
  causedByTaskId?: string | null;
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
}
