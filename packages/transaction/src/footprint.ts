/**
 * The footprint — every object Ablo leaves inside a customer's own database,
 * declared once.
 *
 * Four things need this list and each used to carry its own copy: the setup SQL
 * that creates the objects, the replication runtime that reads them, the audit
 * that tells a customer what Ablo put there, and (eventually) the teardown that
 * removes them. They drifted, as hand-maintained copies do — `ABLO_PUBLICATION`
 * was declared twice, under a comment insisting the literals "MUST equal the
 * CLI's" and pointing at a file that no longer held it, and the audit went on
 * looking for a footprint from an earlier era while seeing none of what Ablo
 * installs today.
 *
 * The audit is the copy that matters most. A customer runs it to answer "what is
 * still in my database", and a stale list answers "nothing" — which reads as
 * clean rather than as unexamined. So the list lives here, every consumer
 * derives from it, and an object added to Ablo's setup is visible to the audit
 * because it could not have been added anywhere else.
 *
 * Retired objects stay in the list, marked {@link FootprintArtifact.retired}.
 * They are no longer installed, but a database connected to an older Ablo still
 * holds them, and those are precisely the ones a customer would never think to
 * look for.
 */

/** The Postgres object class, which decides how the audit looks it up. */
export type FootprintKind = 'publication' | 'slot' | 'role' | 'table' | 'type';

export interface FootprintArtifact {
  readonly kind: FootprintKind;
  readonly name: string;
  /** What it is for, in the words a customer reading an audit would want. */
  readonly purpose: string;
  /**
   * Installed only for a data source that reports through the signed endpoint
   * rather than the write-ahead log.
   */
  readonly endpointOnly?: boolean;
  /**
   * No longer installed by any current version. A database that once ran an
   * older Ablo still holds it; the audit reports it so it can be cleaned up.
   */
  readonly retired?: boolean;
  /**
   * What it costs to leave behind, when leaving it behind costs something. The
   * audit leads with this, because "you still have an object named X" is not a
   * reason to act and "this one is retaining your write-ahead log" is.
   */
  readonly hazard?: string;
}

// ── The names, for the code that creates and reads these objects ────────────

/** Prefix used to derive a branch-scoped publication name. The exact unsuffixed
 * name is retained only so `ablo connect scan` can identify an old installation. */
export const ABLO_PUBLICATION = 'ablo_publication';
/** Prefix used to derive the branch-scoped replication slot. */
export const ABLO_REPLICATION_SLOT = 'ablo_slot';
/** Prefix used to derive the branch-scoped least-privilege replication login. */
export const ABLO_REPLICATION_ROLE = 'ablo_replicator';
/** Prefix used to derive the branch-scoped login used only for row writes. */
export const ABLO_WRITE_ROLE = 'ablo_writer';
/** The bookkeeping table that makes a retried write land once. */
export const ABLO_IDEMPOTENCY_TABLE = 'ablo_idempotency';
/** The transactional outbox an endpoint source reports through. */
export const ABLO_OUTBOX_TABLE = 'ablo_outbox';

/**
 * Postgres will not accept a replication slot name outside this shape — the
 * check is in `ReplicationSlotValidateNameInternal`, and identifier quoting does
 * not exempt a name from it. Anything derived into a slot name is validated
 * here, at the point it is derived, rather than failing at the point it is used.
 */
export const REPLICATION_SLOT_NAME = /^[a-z0-9_]{1,63}$/;

export function isValidReplicationSlotName(name: string): boolean {
  return REPLICATION_SLOT_NAME.test(name);
}

// ── Per-connection names (ADR 0020) ─────────────────────────────────────────

/** The immutable branch coordinates that identify one customer Data Source. */
export interface DataSourceIdentity {
  readonly organizationId: string;
  readonly branchId: string;
  /** Omitted for the organization-default project. */
  readonly projectId?: string;
}

/** The names one connection owns. Nothing here is shared with another Data Source. */
export interface FootprintNames {
  readonly slot: string;
  readonly publication: string;
  readonly replicationRole: string;
  readonly writeRole: string;
}

/**
 * Sixteen hex characters. `ablo_replicator_` is the longest prefix at sixteen
 * bytes, so the longest derived name is thirty-two — comfortably inside the
 * sixty-three Postgres allows, and inside the same ceiling for a role.
 */
const SUFFIX_LENGTH = 16;

/**
 * FNV-1a over the Data Source identity, in hex.
 *
 * Deliberately not a cryptographic hash: this module is imported by the CLI,
 * which runs in environments without `node:crypto` guaranteed, and the property
 * needed is distinctness rather than unforgeability — the suffix is a label on
 * an object inside a database the customer already controls. Two 32-bit rounds
 * over different seeds give the sixteen hex characters, which is ample for the
 * handful of planes any one database is ever connected to.
 */
function dataSourceDigest(identity: DataSourceIdentity): string {
  // The organization-default project may be omitted or repeated as the
  // organization id; both spell the same branch coordinates.
  const project =
    identity.projectId === identity.organizationId ? '' : (identity.projectId ?? '');
  // Delimit the coordinates. Concatenation alone makes structurally different
  // planes such as ("ab", "c") and ("a", "bc") hash the same input.
  const key = [identity.organizationId, project, identity.branchId].join('\0');

  const round = (seed: number): string => {
    let hash = seed;
    for (let i = 0; i < key.length; i++) {
      hash ^= key.charCodeAt(i);
      // FNV prime, via shifts so the result stays a 32-bit integer.
      hash = Math.imul(hash, 0x0100_0193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  };

  return `${round(0x811c_9dc5)}${round(0x2545_f491)}`.slice(0, SUFFIX_LENGTH);
}

/**
 * The objects this connection owns, named so no other connection can claim them.
 *
 * A slot stores ONE position, so two connections sharing a name compete for the
 * same marker and Postgres reports nothing. The publication
 * and roles are derived from the same digest so a database's footprint reads as
 * one set per connection rather than a mix of shared and private objects.
 *
 * Stable: the same plane always derives the same names, so re-running setup is a
 * no-op rather than a second installation.
 */
export function footprintNamesFor(identity: DataSourceIdentity): FootprintNames {
  const suffix = dataSourceDigest(identity);
  const names: FootprintNames = {
    slot: `${ABLO_REPLICATION_SLOT}_${suffix}`,
    publication: `${ABLO_PUBLICATION}_${suffix}`,
    replicationRole: `${ABLO_REPLICATION_ROLE}_${suffix}`,
    writeRole: `${ABLO_WRITE_ROLE}_${suffix}`,
  };
  // The slot charset is the strictest of the four and Postgres checks it after
  // parsing, so a bad name would fail at CREATE_REPLICATION_SLOT rather than
  // here. Assert at the derivation site, which is the only place that can be
  // wrong.
  if (!isValidReplicationSlotName(names.slot)) {
    throw new Error(`derived replication slot name is not valid Postgres: ${names.slot}`);
  }
  return names;
}

/** Everything Ablo has ever put in a customer's database, current and retired. */
export const ABLO_FOOTPRINT: readonly FootprintArtifact[] = [
  {
    kind: 'publication',
    name: ABLO_PUBLICATION,
    purpose: 'marks which of your tables stream their changes to Ablo',
  },
  {
    kind: 'slot',
    name: ABLO_REPLICATION_SLOT,
    purpose: "holds Ablo's position in your write-ahead log",
    hazard:
      'a slot no longer being read still holds the log back, and Postgres cannot ' +
      'reclaim that space or vacuum past it — left alone, it fills the disk',
  },
  {
    kind: 'role',
    name: ABLO_REPLICATION_ROLE,
    purpose: 'the read-only login Ablo follows your changes with',
  },
  {
    kind: 'role',
    name: ABLO_WRITE_ROLE,
    purpose: 'the login Ablo writes rows with — your row-level security governs it',
  },
  {
    kind: 'table',
    name: ABLO_IDEMPOTENCY_TABLE,
    purpose: 'remembers which writes already landed, so a retry cannot duplicate one',
  },
  {
    kind: 'table',
    name: ABLO_OUTBOX_TABLE,
    endpointOnly: true,
    purpose: 'the outbox your endpoint reports committed changes through',
  },

  // ── Retired: an earlier Ablo kept its whole log in the customer's database ──
  // Today the log lives on Ablo's side and none of these are created. They are
  // listed so the audit can still find them where they were left.
  {
    kind: 'table',
    name: 'sync_deltas',
    retired: true,
    purpose: "an earlier Ablo's change log, kept in your database",
  },
  {
    kind: 'table',
    name: 'sync_id_seq',
    retired: true,
    purpose: "an earlier Ablo's change-log sequence",
  },
  {
    kind: 'table',
    name: 'sync_metadata',
    retired: true,
    purpose: "an earlier Ablo's sync bookkeeping",
  },
  {
    kind: 'table',
    name: 'mutation_log',
    retired: true,
    purpose: "an earlier Ablo's write log",
  },
  {
    kind: 'type',
    name: 'participant_kind',
    retired: true,
    purpose: "an enum an earlier Ablo's tables used",
  },
  {
    kind: 'type',
    name: 'backfill_provenance',
    retired: true,
    purpose: "an enum an earlier Ablo's tables used",
  },
  {
    kind: 'type',
    name: 'confirmation_state',
    retired: true,
    purpose: "an enum an earlier Ablo's tables used",
  },
];
