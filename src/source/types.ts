/**
 * The types that describe a data source — the shapes exchanged over the wire
 * and the handler interfaces you implement.
 *
 * A data source lets Ablo read from and write to your own database. These
 * types cover the four request kinds Ablo can send ({@link SourceRequest}),
 * the operations and change events they carry ({@link SourceOperation} and
 * {@link SourceEvent}), the list-query and pagination shapes, and the handler
 * and context types your source implements. {@link sourceEventForOperation}
 * builds a change-event marker from an operation.
 */

import { AbloValidationError } from '../errors.js';
import type { Environment } from '../environment.js';

/** A scalar value that can appear in a source filter. */
export type SourcePrimitive = string | number | boolean | null;

/**
 * A single filter condition on a `list` query: a field paired with a value,
 * or a field, comparison operator, and value. The two-element form is
 * shorthand for equality.
 */
export type SourceWhere =
  | readonly [field: string, value: SourcePrimitive]
  | readonly [
      field: string,
      op:
        | '='
        | '!='
        | '<'
        | '<='
        | '>'
        | '>='
        | 'IN'
        | 'NOT IN'
        | 'IS'
        | 'IS NOT'
        | 'LIKE'
        | 'NOT LIKE'
        | 'ILIKE'
        | 'NOT ILIKE',
      value: SourcePrimitive | readonly SourcePrimitive[],
    ];

/** The query Ablo passes to your `list` handler: filters, ordering, a limit, and a pagination cursor. */
export interface SourceListQuery {
  readonly where?: readonly SourceWhere[];
  readonly limit?: number;
  readonly orderBy?: string;
  readonly order?: 'asc' | 'desc';
  readonly related?: readonly string[];
  /**
   * An opaque cursor returned by a previous `list` call. Your `list` handler
   * decides what it encodes — a page index, a last id, a keyset. Ablo treats
   * it as a black box and hands it back to fetch the next page until your
   * handler stops returning a `nextCursor`.
   */
  readonly cursor?: string;
}

/**
 * The paginated return shape for a `list` handler. A handler may return a
 * plain `Row[]` for a single, unpaginated page, or return this shape to expose
 * a `nextCursor` that Ablo hands back on the following request.
 */
export interface SourceListPage<Row> {
  readonly rows: readonly Row[];
  readonly nextCursor?: string;
}

/** What a `list` handler returns: either a plain array of rows or a {@link SourceListPage}. */
export type SourceListResult<Row> =
  | readonly Row[]
  | SourceListPage<Row>;

/**
 * The scope of a source request: who is asking and what they are allowed to
 * see. Ablo attaches this so your `authorize` and model handlers can reject
 * calls that fall outside the participant's permitted sync groups.
 *
 * It is advisory. Because the canonical data lives in your database, your
 * handlers are the only place that can actually enforce these limits.
 */
export interface SourceRequestContext {
  readonly participantId?: string;
  readonly participantKind?: 'user' | 'agent' | 'system';
  readonly organizationId?: string;
  readonly requiredSyncGroups?: readonly string[];
  /**
   * Whether this request runs in production or sandbox mode. Branch your
   * handlers on it — for example, read and write a separate sandbox database
   * when `mode === 'sandbox'` — so sandbox traffic exercises the same code
   * against isolated data. Keeping the two apart is your handler's
   * responsibility, since your database holds the canonical rows.
   *
   * Defaults to `'production'` when omitted.
   */
  readonly mode?: Environment;
}

/**
 * A single change Ablo asks your source to apply — a create, update, delete,
 * archive, or unarchive of one row of `model`. Operations arrive in your
 * `commit` handler through {@link SourceCommitParams}. `onStale` says what to
 * do when the row changed since it was read at `readAt`.
 */
export interface SourceOperation {
  readonly type: 'CREATE' | 'UPDATE' | 'DELETE' | 'ARCHIVE' | 'UNARCHIVE';
  readonly model: string;
  readonly id?: string | null;
  readonly input?: Record<string, unknown> | null;
  readonly transactionId?: string | null;
  readonly readAt?: number | null;
  readonly onStale?: 'reject' | 'overwrite' | 'notify' | null;
}

/**
 * A computed change to one row, ready to append to the change log. Your
 * `commit` handler may return these directly, or return rows and let Ablo
 * derive the deltas from them.
 */
export interface SourceDelta {
  readonly model: string;
  readonly id: string;
  readonly type: SourceOperation['type'];
  readonly data?: Record<string, unknown> | null;
  readonly transactionId?: string | null;
}

/**
 * A change that already happened in your database. Your `events` handler
 * returns these, and Ablo appends them to the `sync_deltas` change log and
 * fans them out to connected clients, exactly as it would a change made
 * through the SDK.
 *
 * Your handler can return the whole outbox unfiltered. Ablo deduplicates on
 * the stable `id` and uses `clientTxId` to drop echoes of changes the SDK
 * already committed. If that earlier commit never landed, the same outbox
 * event repairs the gap on the next poll or push.
 */
export interface SourceEvent {
  /**
   * A globally unique event id from your outbox. Ablo uses it for replay
   * protection, so re-delivering the same id is a no-op.
   */
  readonly id: string;
  readonly model: string;
  readonly entityId: string;
  readonly type: SourceOperation['type'];
  readonly data?: Record<string, unknown> | null;
  /**
   * The tenant this event belongs to. Populate it from the row's organization
   * column for multi-tenant data; a single-tenant source may omit it and let
   * the poller fall back to its configured default. It drives fan-out: clients
   * in `org:${organizationId}` receive the resulting change.
   */
  readonly organizationId?: string;
  /**
   * The originating SDK commit id, when you know it. If your outbox records the
   * `clientTxId` that Ablo passed into the matching `commit` handler, echo it
   * back here and Ablo will skip events whose commit already produced a change.
   * Leave it unset for changes made outside the SDK, such as cron jobs, batch
   * imports, or manual edits.
   */
  readonly clientTxId?: string;
  /**
   * When the change occurred in your database. Optional and used only as an
   * ordering hint; Ablo trusts the order of your handler's response over this
   * field.
   */
  readonly occurredAt?: number;
}

/** Inputs to {@link sourceEventForOperation}. */
export interface SourceEventForOperationOptions {
  /**
   * The stable id from your outbox table. It is Ablo's replay-protection key,
   * so retries must return the same id.
   */
  readonly eventId: string;
  readonly operation: SourceOperation;
  /**
   * The committed row id. Defaults to `operation.id`; pass it explicitly for
   * creates where the database assigns the id inside the transaction.
   */
  readonly entityId?: string;
  /**
   * The row's payload after the write. Pass `null` for a delete. When omitted,
   * the event carries no payload, which is valid but leaves less for clients to
   * hydrate from in realtime.
   */
  readonly data?: Record<string, unknown> | null;
  /**
   * The commit request's idempotency key. Echoing it lets Ablo drop echoes of
   * a change the SDK already committed, while still letting the outbox event
   * repair that change if it never landed.
   */
  readonly clientTxId?: string;
  readonly organizationId?: string;
  readonly occurredAt?: number | Date;
}

/**
 * Build the {@link SourceEvent} marker you should record in your outbox table,
 * within the same transaction as the row change it describes.
 *
 * This helper only shapes the marker; it does not persist anything. Writing the
 * returned event through your ORM or raw SQL keeps every source emitting the
 * fields Ablo expects when it reconciles the change.
 */
export function sourceEventForOperation(
  options: SourceEventForOperationOptions,
): SourceEvent {
  const entityId = options.entityId ?? options.operation.id;
  if (typeof entityId !== 'string' || entityId.length === 0) {
    throw new AbloValidationError(
      'sourceEventForOperation requires operation.id or an explicit entityId',
      { code: 'source_event_invalid' },
    );
  }
  const occurredAt = normalizeEventOccurredAt(options.occurredAt);
  return {
    id: options.eventId,
    model: options.operation.model,
    entityId,
    type: options.operation.type,
    ...(options.data !== undefined ? { data: options.data } : {}),
    ...(options.organizationId ? { organizationId: options.organizationId } : {}),
    ...(options.clientTxId ? { clientTxId: options.clientTxId } : {}),
    ...(occurredAt !== undefined ? { occurredAt } : {}),
  };
}

function normalizeEventOccurredAt(
  value: number | Date | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  const timestamp = value instanceof Date ? value.getTime() : value;
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

/** What your `commit` handler returns after applying operations. */
export interface SourceCommitResult<Row = Record<string, unknown>> {
  /**
   * The rows as they stand after the write. Ablo uses them to update its
   * realtime projections and append the resulting changes.
   */
  readonly rows?: readonly Row[];
  /**
   * Explicit changes, for sources that already compute them. Most sources can
   * return rows instead and let Ablo derive the change payload.
   */
  readonly deltas?: readonly SourceDelta[];
}

/** The arguments passed to a top-level {@link SourceCommitHandler}. */
export interface SourceCommitParams<TAuth = unknown> {
  readonly operations: readonly SourceOperation[];
  readonly clientTxId?: string;
  readonly context: SourceHandlerContext<TAuth>;
}

/**
 * The operation an API key is permitted to invoke, one per request kind:
 * `load` and `list` read, `commit` writes, and `events` reads the change feed.
 * A key carries the set of scopes it is allowed to use.
 */
export type SourceScope = 'load' | 'list' | 'commit' | 'events';

/** What your `events` handler returns: a batch of changes and an optional next cursor. */
export interface SourceEventsResult {
  readonly events: readonly SourceEvent[];
  /**
   * The cursor for the next poll. When omitted, Ablo treats the feed as fully
   * drained for this round and reuses the last event's cursor, or the initial
   * cursor, on the following call.
   */
  readonly nextCursor?: string;
}

/**
 * Your handler for the `events` request. Return the changes since `cursor` so
 * Ablo can append and fan them out. See {@link SourceEvent}.
 */
export type SourceEventsHandler<TAuth = unknown> = (params: {
  /**
   * The cursor from a previous `events` call, or undefined on the first poll of
   * a newly connected source. You decide what it encodes — a last event id, a
   * timestamp, a log sequence number.
   */
  readonly cursor?: string;
  /**
   * A suggested upper bound on how many events to return. You may return fewer;
   * returning many more risks tripping Ablo's per-poll cap.
   */
  readonly limit?: number;
  readonly context: SourceHandlerContext<TAuth>;
}) => Promise<SourceEventsResult> | SourceEventsResult;

/** The request being authorized, passed to a function-form {@link SourceApiKey} or an `authorize` hook. */
export interface SourceAuthorizeContext {
  readonly request: Request;
  readonly body: unknown;
  readonly rawBody: string;
}

export interface SourceHandlerContext<TAuth = unknown> {
  readonly auth: TAuth;
  readonly request: Request;
  /**
   * The `webhook-id` from the signed request, globally unique per the
   * Standard Webhooks specification. Dedupe by this id to defend against
   * replay: Ablo does not deduplicate at the source-handler boundary.
   * Commit idempotency keys on `clientTxId`, and event replay protection
   * keys on the outbox event `id`.
   */
  readonly messageId?: string;
  readonly signedAt?: number;
  /**
   * The scope context Ablo attached to this request, naming the participant
   * and the sync groups they are allowed to see. Present when the host
   * opted into scope-aware requests. Use it in `authorize` to reject
   * out-of-scope calls, and in `list` and `load` to filter rows down to
   * what the participant may see.
   *
   * Absent for requests made without scope context, such as tests or
   * single-tenant deployments that do not need scoped fan-out.
   */
  readonly scope?: SourceRequestContext;
}

export interface SourceModelHandlers<Row, CreateInput, TAuth = unknown> {
  load?(params: {
    readonly id: string;
    readonly context: SourceHandlerContext<TAuth>;
  }): Promise<Row | null> | Row | null;

  list?(params: {
    readonly query: SourceListQuery;
    readonly context: SourceHandlerContext<TAuth>;
  }):
    | Promise<SourceListResult<Row>>
    | SourceListResult<Row>;

  /**
   * Apply one or more operations for this model within your own database
   * transaction. Your handler must be idempotent on the operation and its
   * `clientTxId`, so that a retried commit does not apply the change twice.
   */
  commit?(params: {
    readonly operations: readonly SourceOperation[];
    readonly clientTxId?: string;
    readonly context: SourceHandlerContext<TAuth>;
  }): Promise<SourceCommitResult<Row>> | SourceCommitResult<Row>;
}

export type SourceCommitHandler<TAuth = unknown> = (
  params: SourceCommitParams<TAuth>,
) => Promise<SourceCommitResult> | SourceCommitResult;

export type SourceApiKey =
  | string
  | ((context: SourceAuthorizeContext) => Promise<string> | string);

export interface SourceLoadRequest {
  readonly type: 'load';
  readonly model: string;
  readonly id: string;
  readonly scope?: SourceRequestContext;
}

export interface SourceListRequest {
  readonly type: 'list';
  readonly model: string;
  readonly query?: SourceListQuery;
  readonly scope?: SourceRequestContext;
}

export interface SourceCommitRequest {
  readonly type: 'commit';
  /**
   * Optional single-model hint. Omit for cross-model commits; top-level
   * `commit` receives the whole operation array unchanged.
   */
  readonly model?: string;
  readonly operations: readonly SourceOperation[];
  readonly clientTxId?: string;
  readonly scope?: SourceRequestContext;
}

export interface SourceEventsRequest {
  readonly type: 'events';
  readonly cursor?: string;
  readonly limit?: number;
  readonly scope?: SourceRequestContext;
}

export type SourceRequest =
  | SourceLoadRequest
  | SourceListRequest
  | SourceCommitRequest
  | SourceEventsRequest;

export type SourceResponse<Row = Record<string, unknown>> =
  | {
      readonly row: Row | null;
    }
  | {
      readonly rows: readonly Row[];
      readonly nextCursor?: string;
    }
  | {
      readonly rows?: readonly Row[];
      readonly deltas?: readonly SourceDelta[];
    };

// DataSource* aliases, each one-to-one with the matching Source* name above.
export type DataSourcePrimitive = SourcePrimitive;
export type DataSourceWhere = SourceWhere;
export type DataSourceListQuery = SourceListQuery;
export type DataSourceListPage<Row> = SourceListPage<Row>;
export type DataSourceListResult<Row> = SourceListResult<Row>;
export type DataSourceRequestContext = SourceRequestContext;
export type DataSourceOperation = SourceOperation;
export type DataSourceDelta = SourceDelta;
export type DataSourceEvent = SourceEvent;
export type DataSourceEventForOperationOptions =
  SourceEventForOperationOptions;
export type DataSourceCommitResult<Row = Record<string, unknown>> =
  SourceCommitResult<Row>;
export type DataSourceCommitParams<TAuth = unknown> =
  SourceCommitParams<TAuth>;
export type DataSourceScope = SourceScope;
export type DataSourceEventsResult = SourceEventsResult;
export type DataSourceEventsHandler<TAuth = unknown> =
  SourceEventsHandler<TAuth>;
export type DataSourceAuthorizeContext = SourceAuthorizeContext;
export type DataSourceHandlerContext<TAuth = unknown> =
  SourceHandlerContext<TAuth>;
export type DataSourceModelHandlers<
  Row,
  CreateInput,
  TAuth = unknown,
> = SourceModelHandlers<Row, CreateInput, TAuth>;
export type DataSourceCommitHandler<TAuth = unknown> =
  SourceCommitHandler<TAuth>;
export type DataSourceApiKey = SourceApiKey;
export type DataSourceLoadRequest = SourceLoadRequest;
export type DataSourceListRequest = SourceListRequest;
export type DataSourceCommitRequest = SourceCommitRequest;
export type DataSourceEventsRequest = SourceEventsRequest;
export type DataSourceRequest = SourceRequest;
export type DataSourceResponse<Row = Record<string, unknown>> =
  SourceResponse<Row>;
