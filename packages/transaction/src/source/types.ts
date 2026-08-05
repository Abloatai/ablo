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
import type { CommitOperationType, OnStaleMode } from '../coordination/schema.js';
import type { ParticipantKind } from '../types/participant.js';

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
  readonly participantKind?: ParticipantKind;
  readonly organizationId?: string;
  /** Immutable branch selected by the authenticating credential. */
  readonly branchId?: string;
  /** Trusted project selected by the authenticating credential. */
  readonly projectId?: string;
  readonly requiredSyncGroups?: readonly string[];
}

/**
 * A single change Ablo asks your source to apply — a create, update, delete,
 * archive, or unarchive of one row of `model`. Operations arrive in your
 * `commit` handler through {@link SourceCommitParams}. `onStale` says what to
 * do when the row changed since it was read at `readAt`.
 */
export interface SourceOperation {
  readonly type: CommitOperationType;
  readonly model: string;
  readonly id?: string | null;
  readonly input?: Record<string, unknown> | null;
  readonly transactionId?: string | null;
  readonly readAt?: number | null;
  readonly onStale?: OnStaleMode | null;
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
 * the stable `id`. A mediated endpoint write carries `correlationId` plus the
 * operation's `transactionId`; those fields promote its queued receipt after
 * the event is durably appended. External writes omit them.
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
   * @deprecated Legacy echo identity. It is not trusted for queued confirmation;
   * use `correlationId` and `transactionId` for mediated endpoint writes.
   */
  readonly clientTxId?: string;
  /** Scoped server-authored identity of the queued mediated commit. */
  readonly correlationId?: string;
  /** Stable per-operation identity within the correlated commit. */
  readonly transactionId?: string;
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
   * @deprecated Legacy echo identity. Prefer the explicit correlation fields.
   */
  readonly clientTxId?: string;
  readonly correlationId?: string;
  /** Defaults to `operation.transactionId` when present. */
  readonly transactionId?: string;
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
  const transactionId = options.transactionId ?? options.operation.transactionId ?? undefined;
  return {
    id: options.eventId,
    model: options.operation.model,
    entityId,
    type: options.operation.type,
    ...(options.data !== undefined ? { data: options.data } : {}),
    ...(options.organizationId ? { organizationId: options.organizationId } : {}),
    ...(options.clientTxId ? { clientTxId: options.clientTxId } : {}),
    ...(options.correlationId ? { correlationId: options.correlationId } : {}),
    ...(transactionId ? { transactionId } : {}),
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

/**
 * Requests a commit-correlated marker in the customer's Postgres WAL.
 *
 * This is opt-in because ordinary Data Source endpoints can be backed by
 * stores other than Postgres. Connected Postgres planes request it for
 * `wait: 'confirmed'`: the row changes and the logical message must be written
 * by the same customer-side transaction, so a rollback publishes neither.
 */
export interface SourceCommitEcho {
  readonly kind: 'postgres-wal';
  /**
   * Opaque, versioned marker payload authored by Ablo. A source handler must
   * pass these exact bytes to `pg_logical_emit_message` inside the write
   * transaction; it must not reconstruct or normalize the JSON.
   */
  readonly payload: string;
}

/** Prefix reserved for Ablo commit-correlation messages in pgoutput. */
export const ABLO_POSTGRES_COMMIT_ECHO_PREFIX = 'ablo';

/**
 * Maximum source commit-correlation key length. This matches the server's
 * idempotency-key contract: a WAL marker longer than this can never name an
 * accepted Ablo commit and must not be appended as an apparently correlatable
 * echo.
 */
export const ABLO_SOURCE_CLIENT_TX_ID_MAX_LENGTH = 255;

/** Connected-source batches are deliberately smaller than the generic wire cap. */
export const ABLO_SOURCE_ECHO_MAX_OPERATIONS = 500;

/** Maximum UTF-8 bytes accepted for one transactional WAL marker payload. */
export const ABLO_SOURCE_ECHO_MAX_PAYLOAD_BYTES = 256 * 1024;

export interface SourceCommitEchoOperation {
  readonly model: string;
  readonly id: string;
  readonly action: 'I' | 'U' | 'D';
  readonly transactionId: string;
}

/** Strict payload encoded into {@link SourceCommitEcho.payload}. */
export interface SourceCommitEchoMarker {
  readonly version: 1;
  readonly correlationId: string;
  readonly operations: readonly SourceCommitEchoOperation[];
}

/** The arguments passed to a top-level {@link SourceCommitHandler}. */
export interface SourceCommitParams<TAuth = unknown> {
  readonly operations: readonly SourceOperation[];
  /** Scoped, server-authored customer-ledger identity. */
  readonly correlationId?: string;
  /** @deprecated Legacy wire name for `correlationId`. */
  readonly clientTxId?: string;
  /**
   * Canonical hash of the complete caller intent (operations plus guarded
   * context), authored and signed by Ablo. Persist it beside `correlationId` and
   * reject a replay whose hash differs; this protects an ambiguous retry even
   * if Ablo's local execution row rolled back after your commit succeeded.
   */
  readonly intentHash?: string;
  /** Present when the caller requires a transaction-correlated WAL echo. */
  readonly echo?: SourceCommitEcho;
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
   * Commit idempotency keys on the scoped `correlationId`, and event replay protection
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
   * transaction. Your handler must be idempotent on the scoped server
   * `correlationId`, so that a retried commit does not apply the change twice.
   */
  commit?(params: {
    readonly operations: readonly SourceOperation[];
    /** Scoped, server-authored customer-ledger identity. */
    readonly correlationId?: string;
    /** @deprecated Legacy wire name for `correlationId`. */
    readonly clientTxId?: string;
    /** Persist and compare this hash as part of the idempotency ledger. */
    readonly intentHash?: string;
    /** Emit this marker inside the same transaction as the operations. */
    readonly echo?: SourceCommitEcho;
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
  /** Scoped, server-authored customer-ledger identity. */
  readonly correlationId?: string;
  /** @deprecated Legacy wire name for `correlationId`. */
  readonly clientTxId?: string;
  /** Signed canonical hash of the complete server-side commit intent. */
  readonly intentHash?: string;
  /** Commit-confirmation marker requested by a connected Postgres plane. */
  readonly echo?: SourceCommitEcho;
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
