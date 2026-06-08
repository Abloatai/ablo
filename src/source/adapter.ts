/**
 * The Data Source adapter — ONE interface every ORM backend implements, and the
 * bridge that wires it into the core `dataSource()` handler.
 *
 * Pattern (Auth.js / Better Auth): one core interface, one package per ORM
 * (`prismaDataSource`, `drizzleDataSource`, `kyselyDataSource`), each provably
 * correct via the shared conformance suite. The adapter owns reading and writing
 * the database, plus the transactional outbox and idempotency, so a customer never
 * hand-writes them:
 *
 *   export const POST = dataSource({
 *     schema, apiKey: process.env.ABLO_API_KEY!,
 *     ...sourceHandlersFromAdapter(prismaDataSource(prisma, schema), schema),
 *   });
 *
 * The bridge below connects the adapter to the core: it turns ONE adapter into the
 * core handler's `commit` / `events` / per-model `load`+`list` — no per-ORM
 * branching anywhere above the adapter.
 */

import type { SourceListQuery, SourceRequestContext } from './index.js';
import type {
  AdapterCapabilities,
  ChangeSet,
  EventsPage,
  Migration,
} from './contract.js';

/**
 * A canonical row keyed by schema FIELD name (e.g. `operatorId`) — the SDK shape,
 * NOT physical column names. Each adapter is the translation boundary: Prisma maps
 * via its `@map`, Drizzle via the schema's `camelToSnake`/`column` rule. `unknown`
 * leaf is narrowed by codegen later.
 */
export type Row = Record<string, unknown>;

/** A read against the canonical store — a single-row load or a filtered list. */
export type AdapterReadRequest =
  | { readonly kind: 'load'; readonly model: string; readonly id: string; readonly scope?: SourceRequestContext }
  | { readonly kind: 'list'; readonly model: string; readonly query?: SourceListQuery; readonly scope?: SourceRequestContext };

export interface AdapterCommitResult {
  /** Canonical rows after the write — Ablo derives deltas from these. */
  readonly rows: readonly Row[];
}

/**
 * The adapter interface. An ORM adapter implements exactly these. `read`/`commit`
 * read and write the database; `events` reads the outbox; `migrations` ships the
 * `ablo_idempotency` + `ablo_outbox` table-creation SQL so the customer never writes it.
 */
export interface DataSourceAdapter {
  readonly capabilities: AdapterCapabilities;
  /** The table-creation SQL the adapter ships for its own tables (`ablo_idempotency` + `ablo_outbox`). */
  migrations(): readonly Migration[];
  /** Canonical rows for a load/list. */
  read(req: AdapterReadRequest): Promise<readonly Row[]>;
  /**
   * Apply a change set transactionally and idempotently by `clientTxId`:
   * a duplicate `clientTxId` returns the original rows without re-applying.
   * Writes the `ablo_outbox` rows in the SAME transaction as the app rows.
   */
  commit(change: ChangeSet): Promise<AdapterCommitResult>;
  /** Read outbox events after `cursor` (null = from the beginning), up to `limit`. */
  events(cursor: string | null, limit: number): Promise<EventsPage>;
}

export type { AdapterCapabilities, ChangeSet, Migration, OutboxEvent, EventsPage } from './contract.js';
