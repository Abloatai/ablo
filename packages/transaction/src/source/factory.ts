/**
 * Builds the request handler returned by `dataSource()`. Given your options —
 * the schema, the API key, and either
 * per-model handlers or an ORM adapter — the handler verifies each signed request,
 * enforces the per-key scopes, and routes the four wire operations (`load`,
 * `list`, `commit`, and `events`) to whichever handlers you configured.
 */

import type {
  Schema,
  SchemaRecord,
  InferCreate,
} from '../schema/schema.js';
import type { DataSourceAdapter } from './adapter.js';
import type { AdapterReadRequest, Row } from './adapter.js';
import { changeSetSchema } from './contract.js';
import { AbloError, AbloPermissionError } from '../errors.js';
import {
  authorizeSourceChange,
  authorizeSourceRead,
  lockSourceSubjectCreates,
  sourceSubjectRule,
  sourceSubjectValues,
} from './subjectAuthorization.js';
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
  SourceSubjectTransactionHandler,
} from './types.js';

type SourceModels<S extends SchemaRecord, TAuth> = Partial<{
  readonly [K in keyof S & string]: SourceModelHandlers<
    InferCreate<Schema<S>, K> & { readonly id: string } & Record<string, unknown>,
    InferCreate<Schema<S>, K>,
    TAuth
  >;
}>;

export type DataSourceOptions<S extends SchemaRecord, TAuth = unknown> = {
  readonly schema: Schema<S>;
  /**
   * Your Ablo project credential. Ablo signs each Data Source call with the same
   * project API key your server-side SDK already uses, so your environment holds a
   * single Ablo credential and every request is signature-verified before any
   * handler runs.
   */
  readonly apiKey: SourceApiKey;
  /**
   * How much clock skew to tolerate when verifying a request's signed timestamp.
   * Defaults to five minutes.
   */
  readonly signatureToleranceMs?: number;
  /**
   * Attaches your own context to a verified request and returns it — for example a
   * database handle, an account scope, or the current actor. Keep database
   * credentials inside this function's environment and never send them to Ablo. The
   * signature has already been checked against `apiKey` by the time this runs, so
   * `authorize` only needs to supply business context, not re-verify the caller.
   */
  readonly authorize?: (
    context: SourceAuthorizeContext,
  ) => Promise<TAuth> | TAuth;
  /**
   * Resolves the set of operations a request's key may perform. When you provide
   * it, the handler checks the operation the request is asking for (`load`, `list`,
   * `commit`, or `events`) against the returned set and responds 403
   * `source_forbidden` if it is not allowed, before any model handler runs. A
   * typical implementation reads a key id from the request — a `webhook-id` prefix,
   * a custom header, or the API key itself — and looks that key's scopes up in your
   * store. Omit it to allow every operation; return an empty set to deny them all.
   */
  readonly resolveScopes?: (params: {
    readonly auth: TAuth;
    readonly request: Request;
    readonly body: SourceRequest;
  }) => Promise<ReadonlySet<SourceScope> | readonly SourceScope[]> |
    ReadonlySet<SourceScope> | readonly SourceScope[];
  /**
   * Handles a commit atomically across every model it touches. Prefer this in real
   * applications: a single user action can change several models at once and should
   * run inside one transaction you control.
   */
  readonly commit?: SourceCommitHandler<TAuth>;
  /**
   * Required for a hand-written commit touching any subject-scoped model.
   * The hook owns one customer-database transaction and calls `run` with a
   * locking row loader and the batch commit bound to that same transaction.
   */
  readonly subjectTransaction?: SourceSubjectTransactionHandler<TAuth>;
  /**
   * Reports changes that happened outside the SDK — cron jobs, dashboard edits,
   * batch imports — which Ablo polls for. Each event you return becomes a delta and
   * fans out to connected clients. You can return your outbox rows directly: Ablo
   * dedupes on stable `event.id`, appends the authoritative event, and uses a
   * server-authored `correlationId` plus per-operation `transactionId` to settle
   * the matching queued write. Store both fields for mediated endpoint commits.
   */
  readonly events?: SourceEventsHandler<TAuth>;
  /**
   * Groups per-model handlers under a `models` key. The spread form below is
   * usually shorter — `dataSource({ schema, files: { load, list, commit } })` —
   * but this explicit form is available when you prefer it.
   */
  readonly models?: SourceModels<S, TAuth>;
  /**
   * An ORM adapter, such as `prismaDataSource(prisma, schema)`. When set, it serves
   * all four operations on its own — reads for `load` and `list`, an idempotent
   * `commit` backed by the outbox, and `events` — so you write no handlers by hand.
   * Because rows travel as JSON, the adapter is applied at a single generic
   * dispatch point and needs no per-model types. Use either an adapter or
   * hand-written handlers, not both.
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
 * Serves one request from an ORM `adapter`, mapping each of the four operations to
 * the adapter's `read`, `commit`, or `events` method and shaping the wire response.
 * The adapter is the only dispatch point, so there is no per-model branching here.
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
    const correlationId = body.correlationId ?? body.clientTxId;
    if (!correlationId) {
      return json(
        {
          error: 'source_commit_requires_correlation_id',
          message: 'commit requires a scoped correlationId for idempotency',
        },
        400,
      );
    }
    const parsed = changeSetSchema.safeParse({
      operations: body.operations,
      correlationId,
      intentHash: body.intentHash,
      echo: body.echo,
      scope,
    });
    if (!parsed.success) {
      return json({ error: 'source_commit_invalid', message: parsed.error.message }, 400);
    }
    if (
      parsed.data.echo?.kind === 'postgres-wal' &&
      adapter.capabilities.postgresWalEcho !== true
    ) {
      return json(
        {
          error: 'source_commit_echo_not_supported',
          message:
            'This adapter cannot emit the required Postgres WAL commit echo',
        },
        409,
      );
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
        syncGroups: event.syncGroups,
        ...(event.organizationId ? { organizationId: event.organizationId } : {}),
        ...(event.clientTxId ? { clientTxId: event.clientTxId } : {}),
        ...(event.correlationId ? { correlationId: event.correlationId } : {}),
        ...(event.transactionId ? { transactionId: event.transactionId } : {}),
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
 * Maps a wire request to the single scope it requires. The mapping is exhaustive,
 * so a new request type must be given its own scope, keeping the scope vocabulary
 * in step with the set of operations.
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
  options: DataSourceOptions<S, TAuth>,
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

function subjectDenial(error: unknown): Response | null {
  return error instanceof AbloPermissionError && error.code === 'capability_scope_denied'
    ? json({ error: error.code, message: error.message }, error.httpStatus ?? 403)
    : null;
}

function typedSourceError(error: unknown): Response | null {
  const denial = subjectDenial(error);
  if (denial) return denial;
  return error instanceof AbloError && error.code && error.httpStatus
    ? json({ error: error.code, message: error.message }, error.httpStatus)
    : null;
}

function parseHandWrittenChange<TAuth>(
  body: Extract<SourceRequest, { type: 'commit' }>,
  context: SourceHandlerContext<TAuth>,
) {
  const correlationId = body.correlationId ?? body.clientTxId;
  return changeSetSchema.safeParse({
    operations: body.operations,
    correlationId,
    intentHash: body.intentHash,
    echo: body.echo,
    scope: context.scope,
  });
}

/**
 * Creates a Data Source endpoint you host in front of your own database.
 *
 * Your application code still reads and writes through Ablo, as in
 * `ablo.files.load`, `.list`, and `.update`. This helper is for keeping the
 * canonical rows in your database: Ablo calls a narrow, signed endpoint you
 * control rather than holding your database credentials.
 */
export function dataSource<const S extends SchemaRecord, TAuth = unknown>(
  options: DataSourceOptions<S, TAuth>,
): (request: Request) => Promise<Response> {
  return async function handleDataSource(request: Request): Promise<Response> {
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

    // Enforce the per-key scope. When `resolveScopes` is set, it returns the
    // operations this key may invoke, and we check the request against that set
    // before any model handler runs.
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

    // When an ORM adapter is configured it serves every operation here, at the
    // generic layer where rows are plain JSON, so there is no per-model handler
    // lookup on this path.
    if (options.adapter) {
      try {
        return await handleViaAdapter(options.adapter, body, context.scope);
      } catch (error) {
        const typed = typedSourceError(error);
        if (typed) return typed;
        throw error;
      }
    }

    if (body.type === 'load') {
      const handlers = getModelHandlers(options, body.model);
      if (!handlers?.load) {
        return json({ error: 'source_load_not_configured', model: body.model }, 404);
      }
      const row = await handlers.load({ id: body.id, context });
      try {
        const authorized = authorizeSourceRead(
          options.schema,
          { kind: 'load', model: body.model, id: body.id, ...(context.scope ? { scope: context.scope } : {}) },
          row ? [row as Row] : [],
        );
        return json({ row: authorized[0] ?? null });
      } catch (error) {
        const typed = typedSourceError(error);
        if (typed) return typed;
        throw error;
      }
    }

    if (body.type === 'list') {
      const handlers = getModelHandlers(options, body.model);
      const rule = sourceSubjectRule(options.schema, body.model);
      if (rule && !handlers?.subjectList) {
        return json({
          error: 'source_subject_list_not_configured',
          message: `Subject-scoped model "${body.model}" requires subjectList() so filtering occurs before pagination.`,
        }, 403);
      }
      if (!rule && !handlers?.list) {
        return json({ error: 'source_list_not_configured', model: body.model }, 404);
      }
      const result = rule
        ? await handlers!.subjectList!({
            query: body.query ?? {},
            subject: {
              field: rule.field,
              values: sourceSubjectValues(rule, context.scope?.syncGroups) ?? [],
            },
            context,
          })
        : await handlers!.list!({ query: body.query ?? {}, context });
      const normalized = normalizeListResult(result);
      const request: AdapterReadRequest = {
        kind: 'list',
        model: body.model,
        ...(body.query ? { query: body.query } : {}),
        ...(context.scope ? { scope: context.scope } : {}),
      };
      return json({
        ...normalized,
        rows: authorizeSourceRead(options.schema, request, normalized.rows as readonly Row[]),
      });
    }

    if (body.type === 'commit') {
      const hasSubject = body.operations.some((operation) =>
        sourceSubjectRule(options.schema, operation.model));
      if (hasSubject) {
        if (!options.subjectTransaction) {
          return json({
            error: 'source_subject_transaction_required',
            message: 'Subject-scoped custom commits require subjectTransaction() so authorization and mutation share one transaction.',
          }, 403);
        }
        const parsed = parseHandWrittenChange(body, context);
        if (!parsed.success) {
          return json({ error: 'source_commit_invalid', message: parsed.error.message }, 400);
        }
        try {
          let ranBoundary = false;
          const result = await options.subjectTransaction(
            {
              operations: body.operations,
              correlationId: body.correlationId ?? body.clientTxId,
              clientTxId: body.clientTxId,
              intentHash: body.intentHash,
              echo: body.echo,
              context,
            },
            async ({ lockCreate, load, commit }) => {
              if (ranBoundary) {
                throw new Error('subjectTransaction run() may be called only once');
              }
              ranBoundary = true;
              await lockSourceSubjectCreates(
                options.schema,
                parsed.data,
                (operation) => lockCreate(operation),
              );
              await authorizeSourceChange(options.schema, parsed.data, load);
              return commit();
            },
          );
          if (!ranBoundary) {
            throw new Error('subjectTransaction must call run() inside its database transaction');
          }
          return json(result);
        } catch (error) {
          const typed = typedSourceError(error);
          if (typed) return typed;
          throw error;
        }
      }
      if (options.commit) {
        const result = await options.commit({
          operations: body.operations,
          correlationId: body.correlationId ?? body.clientTxId,
          clientTxId: body.clientTxId,
          intentHash: body.intentHash,
          echo: body.echo,
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
        correlationId: body.correlationId ?? body.clientTxId,
        clientTxId: body.clientTxId,
        intentHash: body.intentHash,
        echo: body.echo,
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
