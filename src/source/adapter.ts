/**
 * The interface every data-source backend implements, together with the bridge
 * that wires an implementation into the `dataSource()` HTTP handler. This package
 * defines the contract and ships adapters for three object-relational mappers —
 * {@link prismaDataSource}, {@link drizzleDataSource}, and {@link kyselyDataSource} —
 * each verified by the shared conformance suite. You can also write your own.
 *
 * An adapter reads and writes your database, and it owns the transactional outbox
 * and idempotency bookkeeping as well, so you never write those by hand:
 *
 *   export const POST = dataSource({
 *     schema, apiKey: process.env.ABLO_API_KEY!,
 *     ...sourceHandlersFromAdapter(prismaDataSource(prisma, schema), schema),
 *   });
 *
 * `sourceHandlersFromAdapter` is the bridge: it turns a single adapter into the
 * handler's `commit`, `events`, and per-model `load` and `list` operations, so no
 * code above the adapter needs to know which mapper you chose.
 */

import type { SourceListQuery, SourceRequestContext } from './types.js';
import type {
  AdapterCapabilities,
  ChangeSet,
  EventsPage,
  Migration,
} from './contract.js';

/**
 * A single row keyed by the schema's field names (for example `operatorId`), not
 * by physical column names. Each adapter is the boundary that translates between
 * the two, mapping a field name to whatever the underlying database column is
 * called. Values are typed as `unknown`, so a caller must narrow a value before
 * using it.
 */
export type Row = Record<string, unknown>;

/** A read request handed to an adapter: either a single-row load by id, or a filtered list. */
export type AdapterReadRequest =
  | { readonly kind: 'load'; readonly model: string; readonly id: string; readonly scope?: SourceRequestContext }
  | { readonly kind: 'list'; readonly model: string; readonly query?: SourceListQuery; readonly scope?: SourceRequestContext };

/** What {@link DataSourceAdapter.commit} returns: the rows as they stand after the write. */
export interface AdapterCommitResult {
  /** The affected rows after the write. The change log is derived from these. */
  readonly rows: readonly Row[];
}

/**
 * The interface an adapter implements to serve one data source. `read` and
 * `commit` read from and write to your database, `events` reads the outbox that
 * `commit` appends to, and `migrations` supplies the SQL that creates the adapter's
 * own two tables. `capabilities` advertises which optional features the adapter
 * supports.
 */
export interface DataSourceAdapter {
  readonly capabilities: AdapterCapabilities;
  /** The table-creation SQL the adapter needs for its own tables, `ablo_idempotency` and `ablo_outbox`. */
  migrations(): readonly Migration[];
  /** The rows matching a load or list request. */
  read(req: AdapterReadRequest): Promise<readonly Row[]>;
  /**
   * Applies a change set in one transaction, keyed for idempotency by `clientTxId`.
   * Replaying the same `clientTxId` returns the original rows without applying the
   * change again. The matching `ablo_outbox` rows are written in the same
   * transaction as the data rows, so the outbox can never drift from the data.
   */
  commit(change: ChangeSet): Promise<AdapterCommitResult>;
  /** Reads outbox events after `cursor` (`null` starts from the beginning), up to `limit` events. */
  events(cursor: string | null, limit: number): Promise<EventsPage>;
}

export type { AdapterCapabilities, ChangeSet, Migration, OutboxEvent, EventsPage } from './contract.js';
