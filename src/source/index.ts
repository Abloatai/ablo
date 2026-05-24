import type {
  Schema,
  SchemaRecord,
  InferCreate,
} from '../schema/schema.js';

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
 * The events handler can return everything from the outbox unfiltered;
 * Ablo dedupes against `mutation_log` server-side using `clientTxId`.
 * Events with no `clientTxId` are treated as external (cron jobs,
 * dashboard edits, batch imports) and always fan out.
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
 * four wire request types: a secret/key carries the set of operations
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
   * boundary; it does at the delta-append boundary via `clientTxId`).
   */
  readonly messageId?: string;
  readonly signedAt?: number;
  /**
   * Scope context Ablo attached to this request. Present when the
   * caller (sync-server) opted into scope-aware source mode. Customers
   * can use it in `authorize` (to reject out-of-scope calls) and in
   * `list` / `load` (to filter rows the participant is allowed to see).
   *
   * Absent for calls made without scope context (legacy callers,
   * tests, or single-tenant deployments that haven't enabled it).
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

export type SourceSecret =
  | string
  | ((context: SourceAuthorizeContext) => Promise<string> | string);

export interface SourceSignatureOptions {
  readonly secret: string;
  readonly body: string;
  /**
   * Unique message id (`webhook-id` per the Standard Webhooks spec).
   * Required: it goes into the HMAC input for replay defense, and
   * receivers may dedupe by it.
   */
  readonly messageId: string;
  readonly timestamp?: number;
}

export interface SourceSignatureVerificationOptions {
  readonly request: Request;
  readonly body: string;
  readonly secret: string;
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
   * Shared secret for Ablo Cloud -> customer source calls. When set,
   * abloSource verifies HMAC_SHA256(secret, `${timestamp}.${body}`)
   * before `authorize` or any model handler runs.
   *
   * @deprecated Use `signingSecret`. Kept so existing source routes
   * do not break during the Data Source naming cleanup.
   */
  readonly secret?: SourceSecret;
  /**
   * Signing secret for Ablo -> customer Data Source calls. The value is
   * created for the Data Source endpoint in Ablo and stored in the
   * customer's app environment. Used to verify Standard Webhooks
   * headers before any handler runs.
   */
  readonly signingSecret?: SourceSecret;
  /**
   * Clock-skew window for signed source requests. Default: 5 minutes.
   */
  readonly signatureToleranceMs?: number;
  /**
   * Verify the Ablo request and return customer-owned context such as
   * a database handle, account scope, or current actor. Keep database
   * credentials in this function's environment; never send them to Ablo.
   *
   * Signature verification is handled by `secret` before this function
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
   * `webhook-id` prefix, a custom header, or the secret itself) and
   * look up the scopes for that key in their store. Mirrors Stripe
   * restricted keys: one secret can read, another can read + write.
   *
   * When omitted, all operations are allowed (back-compat). Returning
   * an empty set denies all operations.
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
   * MUST exclude events that originated from Ablo SDK commits — those
   * already produced deltas via the `commit` path. Returning them here
   * would surface as duplicate updates on every connected client.
   * Customers typically tag outbox rows with the originating
   * `clientTxId` and skip rows whose tag is non-null.
   */
  readonly events?: SourceEventsHandler<TAuth>;
  /**
   * Optional grouped form. The object-key form below is usually terser:
   * `abloSource({ schema, files: { load, list, commit } })`.
   */
  readonly models?: SourceModels<S, TAuth>;
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
   * Legacy single-model hint. Omit for cross-model commits; top-level
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
  secret: string,
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
    encoder.encode(secret),
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
  const signedAt = options.timestamp ?? Date.now();
  // Standard Webhooks signing input: `${msg_id}.${timestamp}.${payload}`
  // Timestamps are seconds-since-epoch in the spec; we keep millis on
  // the wire for backwards compatibility with our existing tolerance
  // window — the receiver compares them millis-to-millis.
  const signature = await hmacSha256Base64(
    options.secret,
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
  if (Math.abs(Date.now() - signedAt) > toleranceMs) {
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
    options.secret,
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

async function resolveSecret(
  secret: SourceSecret | undefined,
  context: SourceAuthorizeContext,
): Promise<string | null> {
  if (!secret) return null;
  return typeof secret === 'function' ? secret(context) : secret;
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
export type DataSourceSecret = SourceSecret;
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
      const secret = await resolveSecret(options.signingSecret ?? options.secret, {
        request,
        body,
        rawBody,
      });
      if (secret) {
        signature = await verifyAbloSourceRequest({
          request,
          body: rawBody,
          secret,
          toleranceMs: options.signatureToleranceMs,
        });
      }
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
