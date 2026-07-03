/**
 * The `abloSource()` / `dataSource()` endpoint factory — the customer-owned
 * Data Source handler. Takes the options (schema, apiKey, handlers or ORM
 * adapter), verifies the signed request, enforces per-key scopes, and
 * dispatches the four wire operations (`load`/`list`/`commit`/`events`) to
 * the configured handlers.
 *
 * `AbloSourceOptions` lives here (not `types.ts`) because it references the
 * ORM `DataSourceAdapter` — keeping it with the factory keeps `types.ts` a
 * dependency-free leaf for `adapter.ts`/`contract.ts` to import from.
 */

import type {
  Schema,
  SchemaRecord,
  InferCreate,
} from '../schema/schema.js';
import type { DataSourceAdapter } from './adapter.js';
import { changeSetSchema } from './contract.js';
import {
  SourceSignatureError,
  verifyAbloSourceRequest,
  type SourceSignatureVerificationResult,
} from './signing.js';
import type {
  SourceApiKey,
  SourceAuthorizeContext,
  SourceCommitHandler,
  SourceEventsHandler,
  SourceHandlerContext,
  SourceListPage,
  SourceListResult,
  SourceModelHandlers,
  SourceOperation,
  SourceRequest,
  SourceRequestContext,
  SourceScope,
} from './types.js';

type SourceModels<S extends SchemaRecord, TAuth> = Partial<{
  readonly [K in keyof S & string]: SourceModelHandlers<
    InferCreate<Schema<S>, K> & { readonly id: string } & Record<string, unknown>,
    InferCreate<Schema<S>, K>,
    TAuth
  >;
}>;

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
  if (grouped) return grouped;
  const direct = options[model as keyof S & string];
  return direct;
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

// ── DataSource* naming aliases (kept 1:1 with the Source* names above; any
// deprecation of one naming family is a separate decision) ──
export type DataSourceOptions<
  S extends SchemaRecord,
  TAuth = unknown,
> = AbloSourceOptions<S, TAuth>;

export function dataSource<const S extends SchemaRecord, TAuth = unknown>(
  options: DataSourceOptions<S, TAuth>,
): (request: Request) => Promise<Response> {
  return abloSource(options);
}
