/**
 * `@abloatai/transaction/server` — the `DataAdapter` storage contract.
 *
 * A `DataAdapter` is the boundary between the sync engine and a database. The
 * engine asks it to do three things — `read` canonical rows, `commit` a change,
 * and `sync` the change log — and expects nothing beyond that. Everything
 * higher up, such as proposing a change or resolving a conflict, is handled
 * before the adapter is ever called.
 *
 * This module declares the contract and the value types that travel through it;
 * you supply the implementation for your own database. The reference Postgres
 * implementation ships separately, because it carries a SQL driver and raw
 * queries that have no place in this browser-safe build.
 *
 * Every shape here builds on {@link Row}, the single canonical form of a
 * database row that the rest of the engine reads and writes.
 */

import type {
  SourceListQuery,
  SourceOperation,
  SourceRequestContext,
} from '../source/index.js';
import type { ServerSyncDelta } from '../observation/contract.js';
import type { BootstrapModel } from './readConfig.js';
import type { CommitContext, CommitExecutionResult } from './commit.js';
import type { StorageMode } from './storageMode.js';
import type { SubjectRule } from '../schema/subject.js';

/**
 * A canonical database row: one record, keyed by column name. The value type is
 * `unknown` by design, not `any` — columns arrive as JSON or in whatever form
 * the driver hands back, so a caller must narrow a value before using it. Reach
 * for this type wherever a row is passed around; it is the one name for that
 * shape, and a later schema-typed `read<T>()` can specialize it to a concrete
 * model without changing any call site.
 */
export type Row = Record<string, unknown>;

// ── read results ───────────────────────────────────────────────────────────

/**
 * The result of a {@link Row} read. Its two shapes mirror the two kinds of
 * {@link ReadRequest}:
 *  - `bootstrap`: a full load, returned as a map from model name to its rows.
 *  - `query`: the rows of a single filtered query.
 */
export type ReadResult =
  | {
      readonly kind: 'bootstrap';
      /** model name → its rows. Empty models are omitted. */
      readonly models: Record<string, Row[]>;
      /** Models whose read failed (partial success), if any. */
      readonly failedModels?: string[];
      /**
       * Present when a paged read (`ReadRequest.page`) stopped at its row
       * limit with rows remaining: pass it back as the next page's cursor.
       * Absent on the final page and on unpaged reads.
       */
      readonly nextCursor?: string;
    }
  | {
      readonly kind: 'query';
      readonly rows: readonly Row[];
      /** Opaque upstream cursor when a source-backed list has another page. */
      readonly nextCursor?: string;
    };

// ── sync ─────────────────────────────────────────────────────────────────────

/**
 * Where a `sync` call resumes: the client's last-seen position in the
 * `sync_deltas` change log. The cursor carries only that position. Everything
 * else a sync needs — the organization, the sync groups, the largest gap it
 * will stream — is bound onto the adapter when it is resolved, so a client can
 * never ask to read an organization other than its own. A `lastSyncId` of zero
 * or less means "no position yet", which `sync` answers with `needsFullRead`.
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
 * A request for canonical rows, in one of two shapes:
 *  - `bootstrap`: the full-load reader — every enabled model's rows at once.
 *  - `query`: a single filtered query against one model, used by the live
 *    `/sync/query` path.
 *
 * A `query` carries its own execution as the `runHosted` closure, the same way
 * a {@link ChangeSet} carries its write. This lets the adapter decide how to
 * answer the request — a data source runs the customer's `list`, a hosted
 * database runs the closure — without the query engine itself having to live
 * inside the adapter.
 */
export type ReadRequest =
  | {
      readonly kind: 'bootstrap';
      readonly models: readonly BootstrapModel[];
      readonly requestedModels?: readonly string[];
      readonly scope?: SourceRequestContext;
      /**
       * Keyset pagination for a SINGLE-model read (`requestedModels` names
       * exactly one model): return at most `limit` rows, starting after the
       * row whose id equals `cursor`. The result carries `nextCursor` while
       * rows remain. Ignored for multi-model reads and by adapters whose
       * backend pages upstream on its own.
       */
      readonly page?: { readonly cursor?: string; readonly limit: number };
    }
  | {
      readonly kind: 'query';
      readonly model: string;
      /** Source-side model name, when it differs from `model`. */
      readonly sourceModel?: string;
      /** `__typename` stamped on each returned row. */
      readonly typename: string;
      readonly subject?: SubjectRule;
      readonly query: SourceListQuery;
      readonly scope?: SourceRequestContext;
      /** Runs the query against a hosted database: compile, take the tenant pool, apply row-level security, unpack the rows. */
      readonly runHosted: () => Promise<Row[]>;
    };

// ── change set (commit input) ──────────────────────────────────────────────

/**
 * A change to apply to the canonical store. `runHosted` holds the write already
 * bound to its execution: a hosted adapter simply runs it, while a data-source
 * adapter ignores it and ships the operations to the customer's own endpoint.
 * The adapter therefore decides how a change is applied, while the write logic
 * itself is prepared above it.
 */
export interface ChangeSet {
  readonly operations: readonly SourceOperation[];
  readonly context: CommitContext;
  readonly clientTxId: string;
  readonly runHosted: () => Promise<CommitExecutionResult>;
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
 * The interface every storage mode implements. The package defines the
 * contract; you implement it against your own database. An adapter is
 * responsible for one thing — reaching the data — and offers exactly three
 * methods to do it: `read` fetches canonical rows, `commit` applies a change,
 * and `sync` reads the change log. Anything above that line, such as proposing
 * a change or resolving a conflict, happens before the adapter is called.
 * `propose` is an optional capability, not a required method.
 */
export interface DataAdapter {
  /** Names the adapter's storage mode, for diagnostics. Routing is decided by
   *  the resolver, not by reading this field. */
  readonly mode: StorageMode;
  readonly capabilities: DataAdapterCapabilities;
  read(req: ReadRequest): Promise<ReadResult>;
  commit(change: ChangeSet): Promise<CommitExecutionResult>;
  sync(cursor: SyncCursor): Promise<SyncResult>;
}

/** A `DataAdapter` whose backend can dry-run a change. Narrow to this only after confirming the `propose` capability. */
export interface ProposableDataAdapter extends DataAdapter {
  propose(change: ChangeSet): Promise<ProposalResult>;
}

/** Resolves an authenticated scope to the adapter that serves it. */
export type AdapterResolver = (
  scope: { readonly projectId: string; readonly accountScope?: string },
) => Promise<DataAdapter> | DataAdapter;
