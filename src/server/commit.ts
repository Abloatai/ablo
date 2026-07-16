/**
 * The commit contract types for the sync engine's server surface.
 *
 * {@link CommitContext} is the attribution envelope stamped onto every delta a
 * commit produces; {@link CommitResult} is the receipt returned when the commit
 * finishes. Both are plain data descriptors — no database driver, no SQL, no
 * functions — so they belong to this package's public contract, which your commit
 * implementation reads and writes. They feed the `ChangeSet` and `DataAdapter`
 * contracts defined alongside them.
 *
 * The attribution fields reuse the shared {@link ParticipantKind},
 * {@link ConfirmationState}, and {@link ParticipantRef} types, so the shape at
 * commit time and the shape of a stored or broadcast delta share one definition
 * rather than being kept in step by hand.
 */
import type { ParticipantKind, ConfirmationState } from '../schema/syncDeltaRow.js';
import type { ParticipantRef } from '../wire/delta.js';
import type { CommitExecutionResultInput } from '../wire/commit.js';
import type { Environment } from '../environment.js';
import type { ReadDependency, TrackDependency } from '../coordination/schema.js';

export interface CommitContext {
  participantId: string;
  /**
   * The kind of participant making the commit. Required, so that every delta carries
   * structured attribution rather than a string-prefix convention.
   */
  participantKind: ParticipantKind;
  organizationId: string;
  /**
   * Project scope used to route source-mode storage. When omitted, the commit
   * targets the organization's default project.
   */
  projectId?: string;
  /** Exact sandbox plane derived from the authenticated key, when present. */
  sandboxId?: string;
  /** Optional external account scope forwarded to storage resolvers. */
  accountScope?: string;
  /**
   * The environment this commit runs in. Source-mode adapters forward it to the
   * customer's handlers so that sandbox and production traffic can reach distinct
   * customer-owned stores.
   */
  environment?: Environment;
  /**
   * The sync groups this participant subscribes to, taken from the connection
   * upgrade or the capability token. Each is appended to every delta's `sync_groups`
   * so that writes fan out to subscribers of entity-level groups (such as
   * `deck:abc`), not only the default `org:X` and `user:Y` groups. When omitted, the
   * commit fans out to just the organization and user groups.
   */
  syncGroups?: readonly string[];
  /**
   * When true, the commit does not add `org:<organizationId>` to a delta's sync
   * groups. Set this for sandbox writes, so that live organization subscribers do
   * not receive test-environment changes.
   */
  omitOrgSyncGroup?: boolean;
  /**
   * The participant on whose authority the actor acted. For a direct human commit
   * this equals the actor; for an agent commit it is the human at the root of the
   * capability's delegation chain. Null for `system` principals.
   */
  onBehalfOf?: ParticipantRef | null;
  /**
   * The id of the scoped credential that authorized the commit. Non-null for agent
   * and system commits when that credential is known; null for direct human commits.
   */
  capabilityId?: string | null;
  /**
   * The id of the human user at the root of the delegated-authority chain. Stored
   * directly on `sync_deltas` so that audit triggers appending the hash chain never
   * need to join mutable credential tables.
   */
  delegationChainRootUserId?: string | null;
  /**
   * The id of the API key row when the caller authenticated with an API key. Used by
   * the idempotency cache and for usage attribution. Null for session and capability
   * callers.
   */
  apiKeyId?: string | null;
  /**
   * Whether a human explicitly approved the change. Defaults to `auto` when the
   * caller does not specify an approval state.
   */
  confirmationState?: ConfirmationState;
  /**
   * Optional foreign key to the task that caused the change, written to the
   * `caused_by_task_id` column when present. Validated when set; clients typically
   * leave it null and let attribution ride on the actor and capability instead.
   */
  causedByTaskId?: string | null;
  /**
   * Read dependencies for the whole batch. The committer declares the rows or groups
   * it read to form this batch; the engine checks that none of them changed since
   * each entry's `readAt` timestamp and applies that entry's `onStale` disposition
   * across the batch. This differs from the per-operation `readAt` guard, which
   * validates only the rows being written. Omit it to check the write targets alone.
   */
  reads?: ReadDependency[] | null;
  /**
   * Durable read-dependencies to persist for this commit's participant. Each entry
   * is kept in `track_dependencies` and re-checked against every future delta; a
   * later match opens a `StaleNotification` delivered out of band. Distinct from
   * `reads`, which is checked once here and discarded.
   */
  track?: TrackDependency[] | null;
}

/**
 * The server execution receipt persisted in `mutation_log`. Its runtime schema
 * lives with the HTTP/WS settlement contract so queued correlation cannot drift
 * between cache, transport, and client.
 */
export type CommitResult = CommitExecutionResultInput;
