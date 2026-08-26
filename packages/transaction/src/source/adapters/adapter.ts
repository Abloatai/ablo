/**
 * The canonical interface every data-source backend implements, together with the bridge
 * that wires an implementation into the `dataSource()` HTTP handler. This package
 * defines the contract and ships PostgreSQL bindings for three object-relational mappers —
 * {@link prismaDataSource}, {@link drizzleDataSource}, and {@link kyselyDataSource} —
 * each verified by shared mutation checks plus endpoint-only outbox checks. The
 * direct Kysely wrapper runs only the shared mutation contract. You can also
 * write your own through the `defineDatabaseAdapter` factory. PostgreSQL, the ORM
 * binding, and WAL/outbox observation are recorded as separate profile axes;
 * an ORM name never implies database portability.
 *
 * An endpoint adapter reads and writes your database, and it owns the transactional
 * outbox and idempotency bookkeeping as well, so you never write those by hand.
 * Hand it to the handler in one slot:
 *
 *   export const POST = dataSource({
 *     schema, apiKey: process.env.ABLO_API_KEY!,
 *     adapter: prismaDataSource(prisma, schema),
 *   });
 *
 * That is the path to teach. {@link sourceHandlersFromAdapter} is the lower-level
 * bridge behind it — it expands one adapter into the handler's `commit`, `events`,
 * and per-model `load` and `list` operations, and is worth reaching for only when
 * you want to override one of those while the adapter serves the rest.
 */

import type { SourceListQuery, SourceRequestContext } from '../types.js';
import type {
  AdapterCapabilities,
  ChangeSet,
} from './contract.js';
import type { Migration } from './migration.js';
import type { EventsPage } from '../outbox/index.js';
import type { DatabaseAdapterProfile } from './adapterProfile.js';

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

/** What {@link MutationAdapter.commit} returns: the rows as they stand after the write. */
export interface AdapterCommitResult {
  /** The affected rows after the write. The change log is derived from these. */
  readonly rows: readonly Row[];
}

/**
 * Guarantees shared by direct and endpoint mutation wrappers. Both apply row DML
 * and write the permanent idempotency ledger in one transaction. The scoped,
 * server-authored `correlationId` is the ledger key; a caller-authored operation
 * transaction id is never used as that namespace.
 */
export interface MutationAdapter {
  /** Database, binding, and observation are separate, explicit axes. */
  readonly profile: DatabaseAdapterProfile;
  readonly capabilities: AdapterCapabilities;
  /** Infrastructure migrations required by this wrapper's advertised capabilities. */
  migrations(): readonly Migration[];
  /** The rows matching a load or list request. */
  read(req: AdapterReadRequest): Promise<readonly Row[]>;
  /**
   * Applies a change set in one transaction, keyed by its scoped `correlationId`.
   * Replaying the same correlation and canonical request hash returns the original
   * rows without applying DML again; a different hash fails closed.
   */
  commit(change: ChangeSet): Promise<AdapterCommitResult>;
}

/**
 * Endpoint-only extension of {@link MutationAdapter}. Its commit writes one
 * correlated outbox event per operation in the same transaction as the DML and
 * ledger. Direct wrappers deliberately do not implement this interface: WAL is
 * their authoritative source feed and they must never write `ablo_outbox`.
 */
export interface DataSourceAdapter extends MutationAdapter {
  readonly capabilities: AdapterCapabilities & { readonly outboxEvents: true };
  /** Pure read of events after `cursor`; `null` starts at the beginning. */
  events(cursor: string | null, limit: number): Promise<EventsPage>;
  /** Bounded cleanup through a consumer position Ablo has durably committed. */
  acknowledgeEvents(acknowledgedThrough: string): Promise<void>;
}

export type { AdapterCapabilities, ChangeSet } from './contract.js';
export type { Migration } from './migration.js';
export type { EventsPage, OutboxEvent } from '../outbox/index.js';
