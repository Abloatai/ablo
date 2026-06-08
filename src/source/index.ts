import type {
  Schema,
  SchemaRecord,
  InferCreate,
} from '../schema/schema.js';
import type { DataSourceAdapter } from './adapter.js';
import { changeSetSchema } from './contract.js';

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
   * Test/live mode for this request. Customers branch their source
   * handlers on this (`if (mode === 'test') db = testDb`) so test
   * traffic exercises the same code path against an isolated store.
   *
   * Mirrors Stripe's `sk_test_` / `sk_live_` distinction: same wire
   * shape, same handler code, different namespace. Ablo's server-side
   * fan-out does not yet partition deltas by mode — that lands when
   * `sync_deltas.mode` ships. Until then, isolation is enforced
   * customer-side via this field, which is the right boundary anyway
   * (the customer's database is where the canonical data lives).
   *
   * Defaults to `'live'` when omitted so callers that don't opt in
   * keep the existing behavior.
   */
  readonly mode?: 'test' | 'live';
}

export interface SourceOperation {
  readonly type: 'CREATE' | 'UPDATE' | 'DELETE' | 'ARCHIVE' | 'UNARCHIVE';
  readonly model: string;
  readonly id?: string | null;
  readonly input?: Record<string, unknown> | null;
  readonly transactionId?: string | null;
  readonly readAt?: number | null;
  readonly onStale?: 'reject' | 'force' | 'flag' | 'merge' | null;
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
    throw new Error(
      'sourceEventForOperation requires operation.id or an explicit entityId',
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

type SourceModels<S extends SchemaRecord, TAuth> = Partial<{
  readonly [K in keyof S & string]: SourceModelHandlers<
    InferCreate<Schema<S>, K> & { readonly id: string } & Record<string, unknown>,
    InferCreate<Schema<S>, K>,
    TAuth
  >;
}>;

export type SourceApiKey =
  | string
  | ((context: SourceAuthorizeContext) => Promise<string> | string);

export interface SourceSignatureOptions {
  readonly apiKey: string;
  readonly body: string;
  /**
   * Unique message id (`webhook-id` per the Standard Webhooks spec).
   * Required: it goes into the HMAC input for replay defense, and
   * receivers may dedupe by it.
   */
  readonly messageId: string;
  /**
   * Unix timestamp in seconds. Defaults to the current time.
   */
  readonly timestamp?: number;
}

export interface SourceSignatureVerificationOptions {
  readonly request: Request;
  readonly body: string;
  readonly apiKey: string;
  readonly toleranceMs?: number;
}

export interface SourceSignatureVerificationResult {
  readonly messageId: string;
  readonly signedAt: number;
}

/**
 * HTTP headers used on signed source requests. Conforms to the
 * Standard Webhooks specification (https://www.standardwebhooks.com/)
 * so customer code can verify our signatures with any of the official
 * libraries (svix, standardwebhooks, hookdeck, etc.) — no Ablo-
 * specific verifier required.
 */
export const ABLO_SOURCE_HEADERS = {
  signature: 'webhook-signature',
  timestamp: 'webhook-timestamp',
  id: 'webhook-id',
  idempotencyKey: 'Idempotency-Key',
} as const;

export class SourceSignatureError extends Error {
  readonly code:
    | 'source_signature_missing'
    | 'source_id_missing'
    | 'source_timestamp_missing'
    | 'source_timestamp_invalid'
    | 'source_timestamp_expired'
    | 'source_signature_invalid'
    | 'source_forbidden';

  constructor(code: SourceSignatureError['code'], message: string) {
    super(message);
    this.name = 'SourceSignatureError';
    this.code = code;
  }
}

export type AbloSourceOptions<S extends SchemaRecord, TAuth = unknown> = {
  readonly schema: Schema<S>;
  /**
   * Customer-visible Ablo credential. In the API-key-only onboarding
   * path, Ablo signs Data Source calls with the same project API key
   * that the customer's server-side SDK uses. This keeps the customer
   * env surface to one Ablo credential while preserving signed request
   * verification before any handler runs.
   */
  readonly apiKey: SourceApiKey;
  /**
   * Clock-skew window for signed source requests. Default: 5 minutes.
   */
  readonly signatureToleranceMs?: number;
  /**
   * Verify the Ablo request and return customer-owned context such as
   * a database handle, account scope, or current actor. Keep database
   * credentials in this function's environment; never send them to Ablo.
   *
   * Signature verification is handled by `apiKey` before this function
   * runs. `authorize` should only attach business context.
   */
  readonly authorize?: (
    context: SourceAuthorizeContext,
  ) => Promise<TAuth> | TAuth;
  /**
   * Optional per-request scope resolver. When set, the helper checks
   * the resolved scope set against the request's operation
   * (`load`/`list`/`commit`/`events`) and returns 403
   * `source_forbidden` if not allowed — before any model handler
   * runs.
   *
   * Customers typically extract a key id from the request (e.g.
   * `webhook-id` prefix, a custom header, or the API key itself) and
   * look up the scopes for that key in their store.
   *
   * When omitted, all operations are allowed. Returning an empty set
   * denies all operations.
   */
  readonly resolveScopes?: (params: {
    readonly auth: TAuth;
    readonly request: Request;
    readonly body: SourceRequest;
  }) => Promise<ReadonlySet<SourceScope> | readonly SourceScope[]> |
    ReadonlySet<SourceScope> | readonly SourceScope[];
  /**
   * Top-level atomic commit handler. Prefer this for real applications:
   * one UI/action commit can span several models and should run inside
   * one customer-owned transaction.
   */
  readonly commit?: SourceCommitHandler<TAuth>;
  /**
   * External-write feed. Ablo polls this to learn about changes that
   * happened outside the SDK (cron jobs, dashboard edits, batch
   * imports). Each returned event becomes a delta and fans out to
   * connected clients.
   *
   * Handlers may return the raw outbox feed. Ablo dedupes stable
   * `event.id` values and filters SDK-origin echoes when rows carry
   * the originating `clientTxId`; customers should persist both fields
   * in their outbox table.
   */
  readonly events?: SourceEventsHandler<TAuth>;
  /**
   * Optional grouped form. The object-key form below is usually terser:
   * `abloSource({ schema, files: { load, list, commit } })`.
   */
  readonly models?: SourceModels<S, TAuth>;
  /**
   * An ORM adapter (`prismaDataSource(prisma, schema)`, …). When set, it serves
   * ALL four operations — read (load/list), commit (idempotent + outbox), and
   * events — so no hand-written `commit`/`events`/model handlers are needed. The
   * adapter is consumed at the generic dispatch layer (rows are JSON on the wire),
   * which is why it carries no per-model types and needs no cast at the call site.
   * Mutually exclusive with hand-written handlers.
   */
  readonly adapter?: DataSourceAdapter;
} & SourceModels<S, TAuth>;

export type SourceLoadRequest = {
  readonly type: 'load';
  readonly model: string;
  readonly id: string;
  readonly scope?: SourceRequestContext;
};

export type SourceListRequest = {
  readonly type: 'list';
  readonly model: string;
  readonly query?: SourceListQuery;
  readonly scope?: SourceRequestContext;
};

export type SourceCommitRequest = {
  readonly type: 'commit';
  /**
   * Optional single-model hint. Omit for cross-model commits; top-level
   * `commit` receives the whole operation array unchanged.
   */
  readonly model?: string;
  readonly operations: readonly SourceOperation[];
  readonly clientTxId?: string;
  readonly scope?: SourceRequestContext;
};

export type SourceEventsRequest = {
  readonly type: 'events';
  readonly cursor?: string;
  readonly limit?: number;
  readonly scope?: SourceRequestContext;
};

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

const DEFAULT_SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Serve a request from an ORM `adapter`. Routes the four operations to the adapter
 * interface (`read`/`commit`/`events`) and shapes the wire response. The adapter is the
 * single point of dispatch — no per-model branching here.
 */
async function handleViaAdapter(
  adapter: DataSourceAdapter,
  body: SourceRequest,
  scope: SourceRequestContext | undefined,
): Promise<Response> {
  if (body.type === 'load') {
    const rows = await adapter.read({
      kind: 'load',
      model: body.model,
      id: body.id,
      ...(scope ? { scope } : {}),
    });
    return json({ row: rows[0] ?? null });
  }

  if (body.type === 'list') {
    const rows = await adapter.read({
      kind: 'list',
      model: body.model,
      ...(body.query ? { query: body.query } : {}),
      ...(scope ? { scope } : {}),
    });
    return json({ rows });
  }

  if (body.type === 'commit') {
    if (!body.clientTxId) {
      return json(
        { error: 'source_commit_requires_client_tx_id', message: 'commit requires a clientTxId for idempotency' },
        400,
      );
    }
    const parsed = changeSetSchema.safeParse({
      operations: body.operations,
      clientTxId: body.clientTxId,
    });
    if (!parsed.success) {
      return json({ error: 'source_commit_invalid', message: parsed.error.message }, 400);
    }
    const result = await adapter.commit(parsed.data);
    return json({ rows: result.rows });
  }

  if (body.type === 'events') {
    const page = await adapter.events(body.cursor ?? null, body.limit ?? 100);
    return json({
      events: page.events.map((event) => ({
        id: event.id,
        model: event.model,
        entityId: event.entityId,
        type: event.type,
        ...(event.data !== undefined && event.data !== null ? { data: event.data } : {}),
        ...(event.organizationId ? { organizationId: event.organizationId } : {}),
        ...(event.clientTxId ? { clientTxId: event.clientTxId } : {}),
        ...(event.occurredAt !== undefined && event.occurredAt !== null
          ? { occurredAt: event.occurredAt }
          : {}),
      })),
      ...(page.nextCursor !== null ? { nextCursor: page.nextCursor } : {}),
    });
  }

  return json({ error: 'unknown_source_request' }, 400);
}

async function readBody(request: Request): Promise<{
  rawBody: string;
  body: SourceRequest;
}> {
  if (typeof request.text === 'function') {
    const rawBody = await request.text();
    return { rawBody, body: JSON.parse(rawBody) as SourceRequest };
  }

  const body = (await request.json()) as SourceRequest;
  return { rawBody: JSON.stringify(body), body };
}

function getHeader(request: Request, name: string): string | null {
  const headers = request.headers as
    | Headers
    | Record<string, string | undefined>
    | undefined;
  if (!headers) return null;
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name);
  }
  const record = headers as Record<string, string | undefined>;
  return record[name] ?? record[name.toLowerCase()] ?? null;
}

/**
 * Parse a `webhook-signature` header per the Standard Webhooks spec.
 * Values are space-delimited `<scheme>,<base64>` pairs (e.g.
 * `v1,abc== v1,def==` during a key rotation window). Returns the set
 * of `v1` signatures so the verifier can accept any of them.
 */
function parseSignatureHeader(raw: string | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(/\s+/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const commaAt = trimmed.indexOf(',');
    if (commaAt === -1) continue;
    const scheme = trimmed.slice(0, commaAt);
    const value = trimmed.slice(commaAt + 1);
    if (scheme === 'v1' && value.length > 0) {
      out.push(value);
    }
  }
  return out;
}

function bufferToBase64(buffer: ArrayBuffer): string {
  // Node + browsers both expose `btoa` on the global; we feed it
  // a binary string built from the byte view.
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function hmacSha256Base64(
  apiKey: string,
  payload: string,
): Promise<string> {
  const crypto = globalThis.crypto?.subtle;
  if (!crypto) {
    throw new SourceSignatureError(
      'source_signature_invalid',
      'WebCrypto HMAC support is unavailable in this runtime',
    );
  }
  const encoder = new TextEncoder();
  const key = await crypto.importKey(
    'raw',
    encoder.encode(apiKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return bufferToBase64(
    await crypto.sign('HMAC', key, encoder.encode(payload)),
  );
}

/**
 * Constant-time string equality. Used over `===` so a malicious
 * signature can't be probed byte-by-byte via timing differences.
 */
function timingSafeEqual(expected: string, actual: string): boolean {
  const max = Math.max(expected.length, actual.length);
  let diff = expected.length ^ actual.length;
  for (let i = 0; i < max; i++) {
    diff |= (expected.charCodeAt(i) || 0) ^ (actual.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export async function signAbloSourceRequest(
  options: SourceSignatureOptions,
): Promise<{
  readonly headers: Record<string, string>;
  readonly signedAt: number;
  readonly signature: string;
}> {
  const signedAt = options.timestamp ?? Math.floor(Date.now() / 1000);
  // Standard Webhooks signing input: `${msg_id}.${timestamp}.${payload}`
  const signature = await hmacSha256Base64(
    options.apiKey,
    `${options.messageId}.${signedAt}.${options.body}`,
  );
  return {
    signedAt,
    signature,
    headers: {
      [ABLO_SOURCE_HEADERS.id]: options.messageId,
      [ABLO_SOURCE_HEADERS.timestamp]: String(signedAt),
      [ABLO_SOURCE_HEADERS.signature]: `v1,${signature}`,
    },
  };
}

export async function verifyAbloSourceRequest(
  options: SourceSignatureVerificationOptions,
): Promise<SourceSignatureVerificationResult> {
  const messageId = getHeader(options.request, ABLO_SOURCE_HEADERS.id);
  if (!messageId) {
    throw new SourceSignatureError(
      'source_id_missing',
      'Missing webhook-id header',
    );
  }

  const rawTimestamp = getHeader(options.request, ABLO_SOURCE_HEADERS.timestamp);
  if (!rawTimestamp) {
    throw new SourceSignatureError(
      'source_timestamp_missing',
      'Missing webhook-timestamp header',
    );
  }

  const signedAt = Number(rawTimestamp);
  if (!Number.isFinite(signedAt)) {
    throw new SourceSignatureError(
      'source_timestamp_invalid',
      'Invalid webhook-timestamp header',
    );
  }

  const toleranceMs = options.toleranceMs ?? DEFAULT_SIGNATURE_TOLERANCE_MS;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const toleranceSeconds = Math.ceil(toleranceMs / 1000);
  if (Math.abs(nowSeconds - signedAt) > toleranceSeconds) {
    throw new SourceSignatureError(
      'source_timestamp_expired',
      'webhook-timestamp is outside the allowed clock-skew window',
    );
  }

  const presented = parseSignatureHeader(
    getHeader(options.request, ABLO_SOURCE_HEADERS.signature),
  );
  if (presented.length === 0) {
    throw new SourceSignatureError(
      'source_signature_missing',
      'Missing webhook-signature header',
    );
  }

  const expected = await hmacSha256Base64(
    options.apiKey,
    `${messageId}.${signedAt}.${options.body}`,
  );
  // Accept any presented signature that matches — supports key
  // rotation per the Standard Webhooks spec.
  const ok = presented.some((sig) => timingSafeEqual(expected, sig));
  if (!ok) {
    throw new SourceSignatureError(
      'source_signature_invalid',
      'Invalid webhook-signature',
    );
  }

  return { messageId, signedAt };
}

async function resolveApiKey(
  apiKey: SourceApiKey | undefined,
  context: SourceAuthorizeContext,
): Promise<string | null> {
  if (!apiKey) return null;
  return typeof apiKey === 'function' ? apiKey(context) : apiKey;
}

/**
 * Map a wire request to its scope tag. Each request type corresponds
 * to one scope, so the function is total and exhaustive — adding a
 * new request type forces a new scope tag, which is the right design
 * pressure for keeping the scope vocabulary in sync with the wire.
 */
function scopeFor(body: SourceRequest): SourceScope {
  switch (body.type) {
    case 'load':
      return 'load';
    case 'list':
      return 'list';
    case 'commit':
      return 'commit';
    case 'events':
      return 'events';
  }
}

function normalizeListResult<Row>(
  result: SourceListResult<Row>,
): { readonly rows: readonly Row[]; readonly nextCursor?: string } {
  if (Array.isArray(result)) {
    return { rows: result };
  }
  const page = result as SourceListPage<Row>;
  return page.nextCursor !== undefined
    ? { rows: page.rows, nextCursor: page.nextCursor }
    : { rows: page.rows };
}

function getModelHandlers<S extends SchemaRecord, TAuth>(
  options: AbloSourceOptions<S, TAuth>,
  model: string,
): SourceModelHandlers<unknown, unknown, TAuth> | undefined {
  const grouped = options.models?.[model as keyof S & string];
  if (grouped) return grouped as SourceModelHandlers<unknown, unknown, TAuth>;
  const direct = options[model as keyof S & string];
  return direct as SourceModelHandlers<unknown, unknown, TAuth> | undefined;
}

function sameModel(operations: readonly SourceOperation[]): string | null {
  const first = operations[0]?.model;
  if (!first) return null;
  return operations.every((op) => op.model === first) ? first : null;
}

/**
 * Create a customer-owned data source endpoint.
 *
 * App code still talks to Ablo with `ablo.files.load/list/update`.
 * This helper is only for customers who keep canonical rows in their own
 * database and want Ablo Cloud to call a narrow, signed endpoint instead
 * of receiving database credentials.
 */
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
export type DataSourceSignatureOptions = SourceSignatureOptions;
export type DataSourceSignatureVerificationOptions =
  SourceSignatureVerificationOptions;
export type DataSourceSignatureVerificationResult =
  SourceSignatureVerificationResult;
export type DataSourceOptions<
  S extends SchemaRecord,
  TAuth = unknown,
> = AbloSourceOptions<S, TAuth>;
export type DataSourceLoadRequest = SourceLoadRequest;
export type DataSourceListRequest = SourceListRequest;
export type DataSourceCommitRequest = SourceCommitRequest;
export type DataSourceEventsRequest = SourceEventsRequest;
export type DataSourceRequest = SourceRequest;
export type DataSourceResponse<Row = Record<string, unknown>> =
  SourceResponse<Row>;

export function abloSource<const S extends SchemaRecord, TAuth = unknown>(
  options: AbloSourceOptions<S, TAuth>,
): (request: Request) => Promise<Response> {
  return async function handleAbloSource(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return json({ error: 'method_not_allowed' }, 405);
    }

    let body: SourceRequest;
    let rawBody: string;
    try {
      const parsed = await readBody(request);
      body = parsed.body;
      rawBody = parsed.rawBody;
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }

    let signature: SourceSignatureVerificationResult | null = null;
    try {
      const apiKey = await resolveApiKey(options.apiKey, {
        request,
        body,
        rawBody,
      });
      if (!apiKey) {
        return json(
          {
            error: 'source_api_key_missing',
            message: 'Data Source apiKey is required',
          },
          401,
        );
      }
      signature = await verifyAbloSourceRequest({
        request,
        body: rawBody,
        apiKey,
        toleranceMs: options.signatureToleranceMs,
      });
    } catch (err) {
      if (err instanceof SourceSignatureError) {
        return json({ error: err.code, message: err.message }, 401);
      }
      throw err;
    }

    const auth = options.authorize
      ? await options.authorize({ request, body, rawBody })
      : (undefined as TAuth);

    // Per-key permission scope check. When `resolveScopes` is set,
    // the customer returns the operation set this key is allowed to
    // invoke; we enforce before any model handler runs.
    if (options.resolveScopes) {
      const required = scopeFor(body);
      const granted = await options.resolveScopes({ auth, request, body });
      const grantedSet =
        granted instanceof Set ? granted : new Set(granted);
      if (!grantedSet.has(required)) {
        return json(
          {
            error: 'source_forbidden',
            required,
            granted: Array.from(grantedSet),
          },
          403,
        );
      }
    }

    const context: SourceHandlerContext<TAuth> = {
      auth,
      request,
      messageId: signature?.messageId,
      signedAt: signature?.signedAt,
      ...(body.scope ? { scope: body.scope } : {}),
    };

    // Adapter path: when an ORM adapter is configured it serves every operation,
    // consumed at this generic layer (rows are JSON on the wire), so no per-model
    // handler lookup and no typed↔generic boundary.
    if (options.adapter) {
      return handleViaAdapter(options.adapter, body, context.scope);
    }

    if (body.type === 'load') {
      const handlers = getModelHandlers(options, body.model);
      if (!handlers?.load) {
        return json({ error: 'source_load_not_configured', model: body.model }, 404);
      }
      const row = await handlers.load({ id: body.id, context });
      return json({ row });
    }

    if (body.type === 'list') {
      const handlers = getModelHandlers(options, body.model);
      if (!handlers?.list) {
        return json({ error: 'source_list_not_configured', model: body.model }, 404);
      }
      const result = await handlers.list({ query: body.query ?? {}, context });
      const normalized = normalizeListResult(result);
      return json(normalized);
    }

    if (body.type === 'commit') {
      if (options.commit) {
        const result = await options.commit({
          operations: body.operations,
          clientTxId: body.clientTxId,
          context,
        });
        return json(result);
      }

      const model = body.model ?? sameModel(body.operations);
      if (!model) {
        return json({ error: 'source_commit_requires_single_model' }, 400);
      }
      const handlers = getModelHandlers(options, model);
      if (!handlers?.commit) {
        return json({ error: 'source_commit_not_configured', model }, 404);
      }
      const result = await handlers.commit({
        operations: body.operations,
        clientTxId: body.clientTxId,
        context,
      });
      return json(result);
    }

    if (body.type === 'events') {
      if (!options.events) {
        return json({ error: 'source_events_not_configured' }, 404);
      }
      const result = await options.events({
        cursor: body.cursor,
        limit: body.limit,
        context,
      });
      return json({
        events: result.events,
        ...(result.nextCursor !== undefined
          ? { nextCursor: result.nextCursor }
          : {}),
      });
    }

    return json({ error: 'unknown_source_request' }, 400);
  };
}

export function dataSource<const S extends SchemaRecord, TAuth = unknown>(
  options: DataSourceOptions<S, TAuth>,
): (request: Request) => Promise<Response> {
  return abloSource(options);
}

export {
  createPushQueue,
  InMemoryPushQueueStorage,
  STANDARD_WEBHOOKS_RETRY_SCHEDULE,
  type PushQueue,
  type PushQueueItem,
  type PushQueueOptions,
  type PushQueueStorage,
} from './pushQueue.js';

// ── Data Source adapter interface (Zod contract + one interface, per-ORM packages) ──
export {
  type DataSourceAdapter,
  type AdapterReadRequest,
  type AdapterCommitResult,
  type Row as AdapterRow,
} from './adapter.js';
export {
  operationSchema,
  operationTypeSchema,
  changeSetSchema,
  outboxEventSchema,
  eventsPageSchema,
  migrationSchema,
  adapterCapabilitiesSchema,
  type Operation,
  type ChangeSet,
  type OutboxEvent,
  type EventsPage,
  type Migration,
  type AdapterCapabilities,
} from './contract.js';
export { prismaDataSource, type PrismaLike, type PrismaDataSourceOptions } from './adapters/prisma.js';
export { adapterTableMigrations } from './migrations.js';
