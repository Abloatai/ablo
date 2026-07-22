/**
 * Creates a stateless, typed HTTP client for server-side actors — agents,
 * workers, and serverless handlers. It talks to Ablo over plain request/response
 * HTTP, uses the bearer credential as its identity, and holds no WebSocket and no
 * connection state.
 *
 * This is the counterpart to the stateful {@link Ablo} client. The stateful
 * client is for interactive participants: it opens a WebSocket, learns its
 * identity (user id and organization id) during the connect-and-bootstrap step,
 * and routes writes through a queue that waits for that identity. A server-side
 * actor has no socket, so instead of reusing that machinery it uses this client,
 * where the credential itself carries identity and the server resolves it on
 * every request.
 *
 * Under the hood this wraps one schema-agnostic protocol client in a typed
 * proxy. That protocol layer keeps transport envelopes and string-keyed model
 * routing private; application code gets the same `client.<model>` surface the
 * stateful client offers.
 */
import {
  createHttpTransport,
  type HttpTransport,
} from './httpTransport.js';
import { modelWireNames } from '../auth/capability.js';
import type { HttpClientConfig } from './httpOptions.js';
import type {
  CommitResource,
  HttpClaimApi,
  HttpTransportModel,
  ModelReadOptions,
  ModelMutationOptions,
  CreateSessionParams,
  AbloSession,
} from '../resources/httpResources.js';
import type {
  ModelCreateParams,
  ModelDeleteParams,
  ServerReadOptions,
  ModelRetrieveParams,
  ModelTrackParams,
  ModelTrackResult,
  ModelUpdateParams,
} from '../resources/modelOperations.js';
import type { Schema, SchemaRecord, InferModel, InferCreate } from '../schema/schema.js';
import type { ModelUpdater, ContentionOptions } from '../resources/functionalUpdate.js';
import { AbloConnectionError, AbloValidationError } from '../errors.js';

export interface AbloHttpClientOptions<S extends SchemaRecord>
  extends HttpClientConfig<S> {
  /**
   * Per-request deadline. A black-holed HTTP request otherwise has no platform
   * timeout and can stall a headless worker forever. Pass `0` to disable it.
   * @default 30_000
   */
  readonly timeoutMs?: number;
}

/**
 * The per-model surface of the stateless HTTP client — everything reachable over
 * request/response: reads (`retrieve` and `list`), writes (`create`, `update`,
 * and `delete`), the durable-lease {@link HttpClaimApi | claim} plane for
 * coordinated writes, and `track`, which registers a durable premise on a row.
 * It deliberately omits the stateful client's local-only
 * reads (the `local` namespace) and live subscriptions (`onChange`), which need
 * a resident graph and a persistent socket; those are absent from the type, so
 * reaching for one is a compile error rather than a runtime gap.
 *
 * This is also the base the reactive per-model surface is composed from, rather
 * than a parallel list it happens to agree with — a verb added here arrives
 * there without a second edit.
 *
 * The typed model contract is transport-independent: `retrieve` returns one row,
 * `list` returns rows, `create`/`update` return the resulting row, and `delete`
 * returns nothing. The low-level protocol client keeps its read watermark and
 * commit receipt envelopes internally; callers should not have to change data
 * access syntax when they switch transport.
 */
export interface HttpModelClient<T, C = T> {
  /**
   * Reads one row by id. Resolves to `undefined` when no such row exists — a
   * miss is data-absence, not an error.
   *
   * This is the default "get me this row", and the one a stateless client
   * wants, since it holds nothing locally. A client with a resident graph
   * answers from it first and falls back to the network, which is why the
   * synchronous `local.retrieve` exists alongside this: same read, restricted
   * to what is already here.
   */
  retrieve(params: ModelRetrieveParams & ModelReadOptions): Promise<T | undefined>;
  /**
   * Reads the rows matching a filter. Same resolution as `retrieve`, in bulk,
   * and deduplicated so concurrent identical calls share one request.
   */
  list(options?: ServerReadOptions<T>): Promise<T[]>;
  /**
   * Creates a row and returns it, including any framework-applied defaults.
   * Passing an id that already exists is idempotent: the existing row is
   * returned unchanged.
   *
   * When the client keeps a local graph the write is optimistic — it resolves
   * once the mutation is queued locally, and a server rejection rolls it back
   * (watch `sync.syncStatus`). A stateless client has no local graph to roll
   * back, so it resolves on the server's confirmation instead. The same is true
   * of `update` and `delete`.
   */
  create(params: ModelCreateParams<T, C>): Promise<T>;
  update(params: ModelUpdateParams<T>): Promise<T>;
  /**
   * Updates a row with a function of its latest value — `update(id, current =>
   * next)`, the data-layer equivalent of a `setState(prev => next)` reducer. The
   * client reads the freshest row, runs your updater, and writes the result as a
   * compare-and-swap against the row's watermark; if another write landed first it
   * re-reads and re-runs. No claim or conflict handling is needed: the write either
   * lands or throws `AbloContentionError` once its retry budget is spent. Return
   * `null` or `undefined` from the updater to skip the write.
   */
  update(
    id: string,
    updater: ModelUpdater<T>,
    options?: ContentionOptions,
  ): Promise<T | undefined>;
  delete(params: ModelDeleteParams<T>): Promise<void>;
  claim: HttpClaimApi<T>;
  /**
   * Registers a durable premise on a row — "keep telling me about this one".
   * Any change that lands on the tracked row rides back on the `notifications`
   * of this client's next commit, so a long-running agent learns its context
   * went stale without re-reading. A track it already holds is refreshed, not
   * duplicated.
   *
   * ```ts
   * await ablo.tasks.track({ id: 'task_42' });
   * // …minutes of other work later, on the next write…
   * const res = await ablo.commits.create({ operations: [ … ] });
   * res.notifications; // populated if task_42 moved in the meantime
   * ```
   *
   * The returned `notifications` are only the tracks that had ALREADY fired at
   * registration time; the ongoing signal arrives on later receipts.
   */
  track(params: ModelTrackParams): Promise<ModelTrackResult>;
}

/**
 * The type of the stateless HTTP client: a typed {@link HttpModelClient} per
 * schema model, plus `commits`, `dispose`, and the session-mint surface. It
 * exposes only what request/response transport can do, so reaching for a
 * stateful-only capability — the `local` reads, `onChange`, or the synchronous
 * `claim.state`/`queue`/`reorder` reads — is a compile error rather than a value
 * that is `undefined` at runtime.
 */
export type AbloHttpClient<S extends SchemaRecord> = {
  readonly [K in keyof S & string]: HttpModelClient<
    InferModel<Schema<S>, K>,
    InferCreate<Schema<S>, K>
  >;
} & {
  /** Runs one-time setup (durable-outbox scope resolution and replay) before the client is used. It also runs lazily ahead of the first request, so calling it yourself is optional. */
  ready(): Promise<void>;
  /** Replays every pending durable HTTP write in seal order and waits for settlement. */
  waitForFlush(): Promise<void>;
  readonly commits: CommitResource;
  dispose(): Promise<void>;
  /** Resolves the bearer credential this client authenticates with, or `null` if none is set. */
  getAuthToken(): Promise<string | null>;
  /**
   * Mints a short-lived, scoped session token. Minting is itself a stateless
   * request, so it is available here even though the local-cache reads are not.
   * Pass `{ user }` to mint an end-user key (`ek_`) or `{ agent, can }` to mint a
   * scoped agent key (`rk_`). See {@link CreateSessionParams}.
  */
  readonly sessions: { create(params: CreateSessionParams<S>): Promise<AbloSession> };
};

/**
 * Private transport members that pass straight through the facade. Everything
 * else must be a declared schema model; there is no dynamic fallback namespace.
 */
const PROTOCOL_MEMBERS = new Set<string>([
  'ready',
  'waitForFlush',
  'dispose',
  'commits',
  'getAuthToken',
  'sessions',
]);

/** Narrows a bare property name to a transport key so the facade can index it typed. */
function isProtocolMember(prop: string): prop is keyof HttpTransport {
  return PROTOCOL_MEMBERS.has(prop);
}

/**
 * Adapts one low-level protocol model to the public typed model contract. The
 * protocol deliberately retains `{ data, stamp, claims }` reads and commit
 * receipts because functional updates need them. This is the single boundary
 * that unwraps those transport details for application code.
 */
function createHttpModelClient<T, C = T>(
  protocol: HttpTransportModel<T>,
): HttpModelClient<T, C> {
  async function readRow(id: string): Promise<T | undefined> {
    const read = await protocol.retrieve({ id });
    return read.data;
  }

  async function requireUpdatedRow(id: string): Promise<T> {
    const row = await readRow(id);
    if (row === undefined) {
      throw new AbloConnectionError(
        `update settled but ${id} could not be read back from the server.`,
        { code: 'commit_no_result' },
      );
    }
    return row;
  }

  // The protocol resource is schema-agnostic and types claim handles as records.
  // The typed facade carries the same handle with its row type attached; runtime
  // mutation code only reads the handle identity. Normalize that one generic
  // boundary here instead of leaking casts into every model method.
  function mutationOptions<P extends { readonly claim?: unknown }>(
    params: P,
  ): Omit<P, 'claim'> & Pick<ModelMutationOptions, 'claim'> {
    const { claim, ...rest } = params;
    return {
      ...rest,
      ...(claim !== undefined ? { claim } : {}),
    };
  }

  function update(params: ModelUpdateParams<T>): Promise<T>;
  function update(
    id: string,
    updater: ModelUpdater<T>,
    options?: ContentionOptions,
  ): Promise<T | undefined>;
  async function update(
    arg: ModelUpdateParams<T> | string,
    updater?: ModelUpdater<T>,
    options?: ContentionOptions,
  ): Promise<T | undefined> {
    if (typeof arg === 'string') {
      if (!updater) {
        throw new AbloValidationError(
          'Functional update requires an updater function.',
          { code: 'write_options_invalid' },
        );
      }
      const receipt = await protocol.update(arg, updater, options);
      return receipt === undefined ? undefined : requireUpdatedRow(arg);
    }

    await protocol.update({
      ...mutationOptions(arg),
      data: arg.data,
    });
    return requireUpdatedRow(arg.id);
  }

  return {
    async retrieve(params): Promise<T | undefined> {
      const read = await protocol.retrieve(params);
      return read.data;
    },
    list: (options) => protocol.list(options),
    async create(params): Promise<T> {
      const row = await protocol.create({
        ...mutationOptions(params),
        data: params.data as Record<string, unknown>,
      });
      return row;
    },
    update,
    async delete(params): Promise<void> {
      await protocol.delete(mutationOptions(params));
    },
    claim: protocol.claim,
    track: (params) => protocol.track(params),
  };
}

/**
 * Builds the stateless, typed HTTP client. Each `client.<model>` resolves to the
 * protocol client's model accessor, while `commits`, `dispose`, and the other
 * protocol members pass through unchanged. No socket is ever opened; the bearer
 * credential is the identity.
 */
/** @internal Constructed only through the public `Ablo({ transport: 'http' })` factory. */
export function createAbloHttpClient<S extends SchemaRecord>(
  options: AbloHttpClientOptions<S>,
): AbloHttpClient<S> {
  const { schema, ...rest } = options;
  const transport: HttpTransport = createHttpTransport({
    ...rest,
    // Derived from the schema this client is bound to, never assembled by hand
    // — see `auth/capability.ts`.
    modelTypenames: modelWireNames(schema.models),
  });
  const schemaModels = new Set(Object.keys(schema.models));
  const models = new Map<
    string,
    HttpModelClient<Record<string, unknown>, Record<string, unknown>>
  >();

  const model = (
    name: string,
  ): HttpModelClient<Record<string, unknown>, Record<string, unknown>> => {
    const cached = models.get(name);
    if (cached) return cached;
    const created = createHttpModelClient(transport.model(name));
    models.set(name, created);
    return created;
  };

  const facade = new Proxy<Partial<AbloHttpClient<S>>>({}, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      // Real protocol members pass through unchanged.
      if (isProtocolMember(prop)) {
        return transport[prop];
      }
      // Only schema models become model accessors. A typo or retired top-level
      // member resolves to undefined instead of manufacturing a plausible client.
      return schemaModels.has(prop) ? model(prop) : undefined;
    },
  });

  // A single boundary cast. `AbloHttpClient<S>` declares only what the model
  // accessor and the passed-through protocol members actually implement, so no
  // method on this type is missing at runtime.
  return facade as AbloHttpClient<S>;
}
