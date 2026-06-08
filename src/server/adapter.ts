/**
 * `@abloatai/ablo/server` — the DataAdapter CONTRACT vocabulary.
 *
 * This is the Better-Auth-style seam: the package defines the storage
 * interface and its value types; a host (today `apps/sync-server`, tomorrow a
 * consumer's app) implements it against a real database. The reference Postgres
 * implementation (`executeCommit` + `selectAdapter`) stays host-side — it
 * carries a `postgres` driver and raw SQL, which must never enter this
 * browser-shippable package.
 *
 * Scope note: this file holds the parts of the contract that are PURE — they
 * depend only on primitives and {@link Row}. The full `DataAdapter` interface
 * (and its `sync()` method) references `SyncDelta`, which currently has two
 * definitions (server `db/deltas` vs package `core`) pending unification; the
 * `commit`/`read` request envelopes reference server domain types
 * (`CommitContext`, `BootstrapModel`). Those stay server-local and re-import
 * these primitives until that canonicalization lands.
 */

import type {
  SourceListQuery,
  SourceOperation,
  SourceRequestContext,
} from '../source/index.js';
import type { ServerSyncDelta } from '../schema/sync-delta-wire.js';
import type { BootstrapModel } from './read-config.js';
import type { CommitContext, CommitResult } from './commit.js';
import type { StorageMode } from './storage-mode.js';

/**
 * A canonical row — one model record keyed by column name. The VALUE type is
 * `unknown`, on purpose and as a best practice: a row's columns are JSONB /
 * driver-dynamic, so `unknown` forces callers to narrow before use (the safe
 * opposite of `any`). This is the single named domain type for "a row"; nothing
 * in the spine uses a bare `unknown[]`. When the schema engine emits per-model
 * types, `read<T>()` can narrow this to `T` without touching call sites.
 */
export type Row = Record<string, unknown>;

// ── read results ───────────────────────────────────────────────────────────

/**
 * The result of a {@link Row} read. Two shapes mirror the two request kinds:
 *  - `bootstrap`: full-load — model name → its rows (empty models omitted).
 *  - `query`: a single filtered model query.
 */
export type ReadResult =
  | {
      readonly kind: 'bootstrap';
      /** model name → its rows. Empty models are omitted. */
      readonly models: Record<string, Row[]>;
      /** Models whose read failed (partial success), if any. */
      readonly failedModels?: string[];
    }
  | {
      readonly kind: 'query';
      readonly rows: readonly Row[];
    };

// ── sync ─────────────────────────────────────────────────────────────────────

/**
 * Resume position for `sync` — the client's last-seen `sync_deltas` watermark.
 * Deliberately JUST the position: org / syncGroups / maxGap are server-derived
 * and bound onto the adapter at resolve time (a trust boundary — the client
 * never supplies the org it reads). `lastSyncId <= 0` means "no position yet",
 * which `sync` reports as `needsFullRead`.
 */
export interface SyncCursor {
  readonly lastSyncId: number;
}

// ── capabilities ─────────────────────────────────────────────────────────────

export interface DataAdapterCapabilities {
  /** The backend can dry-run a change without committing it. */
  readonly propose?: boolean;
  /** `commit` is atomic (all-or-nothing) across the change's operations. */
  readonly transactions?: boolean;
  /** Changes fan out in real time (vs poll-only). */
  readonly realtime?: boolean;
  /** The backend can be introspected for its schema. */
  readonly schemaIntrospection?: boolean;
}

// ── proposal (capability-gated) ───────────────────────────────────────────────

/** Result of a dry-run proposal (only adapters with `capabilities.propose`). */
export interface ProposalResult {
  readonly ok: boolean;
  readonly conflicts?: readonly {
    readonly model: string;
    readonly id: string;
    readonly reason: string;
  }[];
  readonly rows?: readonly Row[];
}

// ── read request ───────────────────────────────────────────────────────────

/**
 * A request for canonical rows. Two shapes:
 *  - `bootstrap`: the full-load reader — give me every (enabled) model's rows.
 *  - `query`: a single filtered model query (the live `/sync/query` path).
 *
 * The `query` shape keeps the hosted SQL/tenant/RLS execution as a `runHosted`
 * closure (same seam as a commit's `runHosted`): the adapter DISPATCHES — source
 * → the customer's `list`, hosted/selfHosted → run the closure — but the query
 * engine itself stays host-side rather than leaking into the adapter.
 */
export type ReadRequest =
  | {
      readonly kind: 'bootstrap';
      readonly models: readonly BootstrapModel[];
      readonly requestedModels?: readonly string[];
      readonly scope?: SourceRequestContext;
    }
  | {
      readonly kind: 'query';
      readonly model: string;
      /** Source-side model name, when it differs from `model`. */
      readonly sourceModel?: string;
      /** `__typename` stamped on each returned row. */
      readonly typename: string;
      readonly query: SourceListQuery;
      readonly scope?: SourceRequestContext;
      /** Hosted/self-hosted execution (compile + tenant pool + RLS + unpack). */
      readonly runHosted: () => Promise<Row[]>;
    };

// ── change set (commit input) ──────────────────────────────────────────────

/**
 * A change to apply to the canonical store. `runHosted` is the pre-bound local
 * mutator execution (the hosted/self-hosted write path lives in the mutator
 * engine above the adapter); the hosted adapter simply runs it, while the source
 * adapter ignores it and ships the operations to the customer endpoint. This is
 * the seam that lets the adapter OWN the mode decision while the heavy mutator
 * logic stays host-side.
 */
export interface ChangeSet {
  readonly operations: readonly SourceOperation[];
  readonly context: CommitContext;
  readonly clientTxId: string;
  readonly runHosted: () => Promise<CommitResult>;
}

// ── sync result ────────────────────────────────────────────────────────────

export interface SyncResult {
  /** Deltas in `(cursor.lastSyncId, nextCursor.lastSyncId]`, scoped to syncGroups. */
  readonly changes: readonly ServerSyncDelta[];
  readonly nextCursor: { readonly lastSyncId: number };
  /** True when the gap was too large to stream — caller must full-`read`. */
  readonly needsFullRead: boolean;
}

// ── the interface ──────────────────────────────────────────────────────────

/**
 * The ONE interface every storage mode implements — the Better-Auth-style
 * `Adapter` seam. The package owns this contract; a host (today
 * `apps/sync-server`, tomorrow a consumer app) implements it against a real
 * database. Design rule (load-bearing, = Zero's mutator principle): **adapters
 * only guarantee reality access.** `read` fetches canonical rows, `commit`
 * applies a change, `sync` reads the change log; orchestration (proposal,
 * conflict policy) lives ABOVE the adapter. `propose` is a capability, never a
 * required method.
 */
export interface DataAdapter {
  /** Diagnostic discriminator (≈ Better Auth's `adapterId`). Routing decisions
   *  go through the resolver/factory, not this. */
  readonly mode: StorageMode;
  readonly capabilities: DataAdapterCapabilities;
  read(req: ReadRequest): Promise<ReadResult>;
  commit(change: ChangeSet): Promise<CommitResult>;
  sync(cursor: SyncCursor): Promise<SyncResult>;
}

/** An adapter whose backend can dry-run. Narrow to this only after checking the capability. */
export interface ProposableDataAdapter extends DataAdapter {
  propose(change: ChangeSet): Promise<ProposalResult>;
}

/** Resolves an authenticated scope to the adapter that serves it (≈ Better Auth's
 *  `createAdapter` factory seam). */
export type AdapterResolver = (
  scope: { readonly projectId: string; readonly accountScope?: string },
) => Promise<DataAdapter> | DataAdapter;
