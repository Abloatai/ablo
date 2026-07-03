/**
 * Shared Data Source wire + handler types.
 *
 * These are the cross-package shapes every source module speaks (operations,
 * events, list queries, handler contexts, the four wire request types). They
 * live in this leaf — not the `index.ts` barrel — so `contract.ts`,
 * `adapter.ts`, `pushQueue.ts` and the ORM adapters can import them directly
 * without routing a circular dependency through the barrel.
 *
 * `sourceEventForOperation` lives here too: it is the pure constructor for the
 * `SourceEvent` marker shape and has no dependency on the endpoint factory.
 */

import { AbloValidationError } from '../errors.js';
import type { Environment } from '../environment.js';

export type SourcePrimitive = string | number | boolean | null;

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

export interface SourceListQuery {
  readonly where?: readonly SourceWhere[];
  readonly limit?: number;
  readonly orderBy?: string;
  readonly order?: 'asc' | 'desc';
  readonly related?: readonly string[];
  /**
   * Opaque cursor returned by a previous `list` call. The customer's
   * `list` handler defines what this encodes (page index, last id,
   * keyset). Ablo treats it as a black box — round-trips it back to
   * fetch the next page until the handler returns no `nextCursor`.
   */
  readonly cursor?: string;
}

/**
 * Optional structured shape for a `list` handler that supports
 * pagination. Handlers may keep returning a plain `Row[]` (no
 * pagination, single-shot) or upgrade to this shape to expose a
 * cursor that Ablo will round-trip on the next request.
 */
export interface SourceListPage<Row> {
  readonly rows: readonly Row[];
  readonly nextCursor?: string;
}

export type SourceListResult<Row> =
  | readonly Row[]
  | SourceListPage<Row>;

/**
 * Read-side scope context that Ablo attaches to source requests so
 * the customer's `authorize` / model handlers can refuse calls that
 * fall outside the participant's permitted syncGroups.
 *
 * This is informational — the customer is the only side that can
 * actually enforce, since the canonical data lives in their store.
 * Mirrors how Auth0 Custom DB scripts receive the requested scope and
 * trust the script to honor it.
 */
export interface SourceRequestContext {
  readonly participantId?: string;
  readonly participantKind?: 'user' | 'agent' | 'system';
  readonly organizationId?: string;
  readonly requiredSyncGroups?: readonly string[];
  /**
   * Production/sandbox mode for this request. Customers branch their source
   * handlers on this (`if (mode === 'sandbox') db = sandboxDb`) so sandbox
   * traffic exercises the same code path against an isolated store.
   *
   * Mirrors Stripe's `sk_test_` / `sk_live_` prefixes: same wire
   * shape, same handler code, different namespace. Ablo's server-side
   * fan-out does not yet partition deltas by mode — that lands when
   * `sync_deltas.mode` ships. Until then, isolation is enforced
   * customer-side via this field, which is the right boundary anyway
   * (the customer's database is where the canonical data lives).
   *
   * Defaults to `'production'` when omitted so callers that don't opt in
   * keep the existing behavior.
   */
  readonly mode?: Environment;
}

export interface SourceOperation {
  readonly type: 'CREATE' | 'UPDATE' | 'DELETE' | 'ARCHIVE' | 'UNARCHIVE';
  readonly model: string;
  readonly id?: string | null;
  readonly input?: Record<string, unknown> | null;
  readonly transactionId?: string | null;
  readonly readAt?: number | null;
  readonly onStale?: 'reject' | 'overwrite' | 'notify' | null;
}

export interface SourceDelta {
  readonly model: string;
  readonly id: string;
  readonly type: SourceOperation['type'];
  readonly data?: Record<string, unknown> | null;
  readonly transactionId?: string | null;
}

/**
 * A change that happened in the customer's store. The source's
 * `events` handler returns these so Ablo can append them to
 * `sync_deltas` and fan them out to connected clients exactly like
 * SDK-originated commits.
 *
 * The events handler can return everything from the outbox unfiltered. Ablo
 * dedupes stable `event.id` values and uses `clientTxId` to filter SDK-origin
 * echoes after the direct append has already succeeded. If the direct append
 * failed, the same outbox event repairs it on poll/push because no matching
 * `mutation_log` row exists yet.
 */
export interface SourceEvent {
  /**
   * Globally unique event id from the customer's outbox. Used by Ablo
   * for replay protection — re-delivering the same id is a no-op.
   */
  readonly id: string;
  readonly model: string;
  readonly entityId: string;
  readonly type: SourceOperation['type'];
  readonly data?: Record<string, unknown> | null;
  /**
   * Tenant the event belongs to. Multi-tenant customers populate this
   * from the row's organization column. Single-tenant deployments may
   * omit it and let the poller fall back to its configured default.
   * Drives the sync-group fan-out: clients in `org:${organizationId}`
   * receive the resulting delta.
   */
  readonly organizationId?: string;
  /**
   * Originating Ablo SDK commit id, when known. If the customer's
   * outbox stores the `clientTxId` Ablo passed into the matching
   * `commit` handler, round-trip it here and Ablo will skip events
   * whose commit already produced a delta. External-origin events
   * (cron jobs, batch imports, manual edits) leave this unset.
   */
  readonly clientTxId?: string;
  /**
   * Wall-clock time the event occurred in the source. Optional; used
   * only for ordering hints. Ablo trusts the customer's response order
   * over this field.
   */
  readonly occurredAt?: number;
}

export interface SourceEventForOperationOptions {
  /**
   * Stable id from the customer's outbox table. This is Ablo's replay-
   * protection key; retries must return the same id.
   */
  readonly eventId: string;
  readonly operation: SourceOperation;
  /**
   * Committed row id. Defaults to `operation.id`; pass this for generated-id
   * CREATEs where the database assigns the id inside the transaction.
   */
  readonly entityId?: string;
  /**
   * Canonical row payload after the write. Pass `null` for DELETE. When omitted
   * the event carries no row payload, which is valid but less useful for
   * realtime hydration.
   */
  readonly data?: Record<string, unknown> | null;
  /**
   * Batch idempotency key from the Data Source commit request. Round-tripping it
   * lets Ablo filter SDK-origin echoes after the direct append succeeds, while
   * still using the outbox event to repair a failed direct append.
   */
  readonly clientTxId?: string;
  readonly organizationId?: string;
  readonly occurredAt?: number | Date;
}

/**
 * Build the source-event marker customers should write to their outbox table in
 * the SAME transaction as their app-row mutation.
 *
 * This helper does not persist anything. It only standardizes the marker shape
 * so Prisma/Drizzle/Kysely/raw-SQL adapters all emit the fields Ablo's
 * reconciler expects.
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

export interface SourceCommitResult<Row = Record<string, unknown>> {
  /**
   * Canonical rows after the write. Ablo uses these to update hosted
   * realtime projections and append deltas.
   */
  readonly rows?: readonly Row[];
  /**
   * Optional explicit deltas when the source already computes them.
   * Most sources can return rows and let Ablo derive the delta payload.
   */
  readonly deltas?: readonly SourceDelta[];
}

export interface SourceCommitParams<TAuth = unknown> {
  readonly operations: readonly SourceOperation[];
  readonly clientTxId?: string;
  readonly context: SourceHandlerContext<TAuth>;
}

/**
 * Operation-level permission tag used by `resolveScopes`. Mirrors the
 * four wire request types: an API key carries the set of operations
 * it's allowed to invoke. Stripe's restricted-key model at the
 * operation granularity — model-level scoping is a future addition.
 */
export type SourceScope = 'load' | 'list' | 'commit' | 'events';

export interface SourceEventsResult {
  readonly events: readonly SourceEvent[];
  /**
   * Cursor for the next poll. When omitted Ablo treats the feed as
   * fully drained for this round and uses the last event's cursor (or
   * the initial cursor) for the next call.
   */
  readonly nextCursor?: string;
}

export type SourceEventsHandler<TAuth = unknown> = (params: {
  /**
   * Cursor returned by a previous `events` call. Undefined on the
   * first poll for a freshly-onboarded source. The customer decides
   * what it encodes (last event id, timestamp, LSN, etc).
   */
  readonly cursor?: string;
  /**
   * Caller-suggested upper bound on returned events. Customers may
   * return fewer; returning more risks tripping Ablo's per-poll cap.
   */
  readonly limit?: number;
  readonly context: SourceHandlerContext<TAuth>;
}) => Promise<SourceEventsResult> | SourceEventsResult;

export interface SourceAuthorizeContext {
  readonly request: Request;
  readonly body: unknown;
  readonly rawBody: string;
}

export interface SourceHandlerContext<TAuth = unknown> {
  readonly auth: TAuth;
  readonly request: Request;
  /**
   * `webhook-id` from the signed request — globally unique per the
   * Standard Webhooks spec. Customers should dedupe by this id to
   * defend against replay (Ablo doesn't dedupe at the source-handler
   * boundary; commit idempotency is `clientTxId`, and event replay
   * protection is the outbox event `id`).
   */
  readonly messageId?: string;
  readonly signedAt?: number;
  /**
   * Scope context Ablo attached to this request. Present when the
   * caller (sync-server) opted into scope-aware source mode. Customers
   * can use it in `authorize` (to reject out-of-scope calls) and in
   * `list` / `load` (to filter rows the participant is allowed to see).
   *
   * Absent for calls made without scope context, such as tests or
   * single-tenant deployments that do not need scoped fan-out yet.
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
   * Apply one or more operations for this model in the customer's own
   * transaction. The source must be idempotent by operation/clientTxId.
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

// ── DataSource* naming aliases (kept 1:1 with the Source* names above; any
// deprecation of one naming family is a separate decision) ──
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
