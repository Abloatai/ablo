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
} from './transport.js';
import type { HttpTransport } from './contract.js';
import type { HttpClientConfig } from './options.js';
import type {
  CommitResource,
  CommitReceipt,
  HttpClaimApi,
  HttpClaimsResource,
  HttpLogsResource,
  HttpTransportModel,
  ModelReadOptions,
  ModelMutationOptions,
  ModelList,
} from '../../client/resources/httpResources.js';
import { collectModelList, modelList } from '../../client/resources/httpResources.js';
import { resolveCreateId } from '../../client/resources/modelCreate.js';
import type {
  ModelCreateParams,
  ModelCreateManyParams,
  ModelDeleteParams,
  ServerReadOptions,
  ListAllOptions,
  ModelReadParams,
  ModelUpdateParams,
} from '../../client/resources/modelOperations.js';
import type { Schema, SchemaRecord, InferModel, InferCreate } from '../../schema/schema.js';
import { omittedModelError } from '../../schema/select.js';
import {
  reconcileFunctionalUpdate,
  type ModelUpdater,
  type FunctionalUpdateOptions,
} from '../../client/resources/functionalUpdate.js';
import type { HeldClaim, HeldLease } from '../../types/streams.js';
import type { JsonValue } from '../../types/streams.js';
import { AbloConnectionError, AbloValidationError } from '../../errors.js';
import type { ReadDependency } from '../../coordination/schema.js';
import {
  capturePointRead,
  createReadSetContext,
  kReadEvidence,
  prepareReadSet,
  type ReadSetContext,
} from '../../commit/readSetContext.js';
import {
  recordHttpCommitReceipt,
  recordWebSocketCommitReceipt,
} from '../../commit/recordRuntime.js';
import type { EffectiveAuthority } from '../../auth/capability.js';
import {
  createWebSocketSession,
} from '../websocket/session.js';
import type {
  AbloWebSocketSession,
  WebSocketObservedDelta,
} from '../websocket/sessionContract.js';
import { subscribeWebSocketReadChanges } from '../websocket/contextSubscription.js';
import type {
  CoreSyncEventMap,
} from '../websocket/transport.js';
import { createPresenceSessionSource } from '../../presence/session.js';

export interface AbloHttpClientOptions<S extends SchemaRecord>
  extends HttpClientConfig<S> {
  /**
   * Per-request deadline. A black-holed HTTP request otherwise has no platform
   * timeout and can stall a headless worker forever. Pass `0` to disable it.
   * @default 30_000
   */
  readonly timeoutMs?: number;
  /** Initial groups observed by a session-backed WebSocket client. */
  readonly groups?: readonly string[];
  /** Application frame names accepted by `subscribe` on the WebSocket transport. */
  readonly collaborationEvents?: readonly string[];
  /** Durable resume position for WebSocket observation. */
  readonly cursorStore?: import('../../client/contract.js').ObserveCursorStore;
  readonly cursorKey?: string;
  readonly reconnectDelay?: number;
  readonly maxReconnectDelay?: number;
  readonly connectTimeoutMs?: number;
}

declare const capturedRowBrand: unique symbol;

/** A point-read row whose exact watermark is privately retained by its client. */
export type CapturedRow<T = unknown> = T & {
  readonly [capturedRowBrand]: true;
};

/** Exact returned rows or low-level canonical dependencies accepted by `reads`. */
export type HttpModelMutationParams<P> = Omit<P, 'reads'> & {
  readonly reads?: readonly (ReadDependency | CapturedRow)[] | null;
};

/**
 * The per-model surface of the stateless HTTP client — everything reachable over
 * request/response: observational reads (`get` and `list`), declared decision
 * reads (`read`), writes (`create`, `update`,
 * and `delete`), and the durable-lease {@link HttpClaimApi | claim} plane for
 * coordinated writes.
 * It deliberately omits the stateful client's local-only
 * reads (the `local` namespace) and live subscriptions (`onChange`), which need
 * a local graph and a persistent socket; those are absent from the type, so
 * reaching for one is a compile error rather than a runtime gap.
 *
 * This is also the base the reactive per-model surface is composed from, rather
 * than a parallel list it happens to agree with — a verb added here arrives
 * there without a second edit.
 *
 * The typed model contract is transport-independent: `get` and `read` return
 * one row, `list` returns rows, `create`/`update` return the resulting row, and `delete`
 * returns nothing. The low-level protocol client keeps its read watermark and
 * commit receipt envelopes internally; callers should not have to change data
 * access syntax when they switch transport.
 */
export interface HttpModelClient<T, C = T> {
  /** Reads one current row without declaring it as input to a later decision. */
  get(params: ModelReadParams & ModelReadOptions): Promise<T | undefined>;
  /**
   * Reads one row by id. Resolves to `undefined` when no such row exists — a
   * miss is data-absence, not an error.
   *
   * Unlike `get`, the exact returned object privately carries model, id, and
   * readAt evidence. Pass it in one mutation's `reads` array when that mutation
   * was decided from this version.
   */
  read(params: ModelReadParams & ModelReadOptions): Promise<CapturedRow<T> | undefined>;
  /**
   * Observes the rows matching a filter, deduplicating concurrent identical
   * calls. List rows are plain values; deliberately `read({ id })` any row a
   * later mutation depends on.
   */
  /**
   * The rows are an array as before; `hasMore` and `nextCursor` on the result
   * say whether the collection continues past this page. Pass `nextCursor`
   * back as `cursor`, with the same `where` and `orderBy`, to walk it.
   */
  list(options?: ServerReadOptions<T>): Promise<ModelList<T>>;
  /** Reads every matching row, following cursors with a bounded traversal. */
  listAll(options?: ListAllOptions<T>): Promise<T[]>;
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
  create(params: HttpModelMutationParams<ModelCreateParams<T, C>>): Promise<T>;
  /**
   * Creates many rows as one atomic commit, and resolves to them in the order
   * they were given. One rejected row declines the batch.
   */
  create(params: HttpModelMutationParams<ModelCreateManyParams<C>>): Promise<T[]>;
  update(params: HttpModelMutationParams<ModelUpdateParams<T, C>>): Promise<T>;
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
    options?: FunctionalUpdateOptions<ReadDependency | CapturedRow>,
  ): Promise<T | undefined>;
  delete(params: HttpModelMutationParams<ModelDeleteParams<T, C>>): Promise<void>;
  claim: HttpClaimApi<T, C>;
}

/**
 * The type of the stateless HTTP client: a typed {@link HttpModelClient} per
 * schema model, plus `commits` and lifecycle operations. It
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
  /** Replays every pending durable HTTP write in seal order and waits for confirmation. */
  waitForFlush(): Promise<void>;
  readonly commits: CommitResource<ReadDependency | CapturedRow>;
  /**
   * Claim-ticket operations keyed by `claimId`: `retrieve` polls a queued
   * ticket to its grant, `heartbeat` keeps one lease (held or queued) alive,
   * `heartbeatAll` beats every lease this identity holds in one round trip.
   * The id comes from `AbloClaimedError('claim_queued')`, which carries it on
   * `error.claims`.
   */
  readonly claims: HttpClaimsResource;
  /** Durable, credential-scoped authoritative event pages. */
  readonly logs: HttpLogsResource;
  /** Server-confirmed authority of the credential, populated by `ready()`. */
  readonly identity: EffectiveAuthority | null;
  /**
   * Waits for requests already using this client and commits already scheduled
   * on its commit lane. Stop accepting application work before calling it.
   */
  dispose(): Promise<void>;
  /** Resolves the bearer credential this client authenticates with, or `null` if none is set. */
  getAuthToken(): Promise<string | null>;
};

export interface AbloLivePresence {
  readonly active: readonly import('../../presence/contract.js').PresenceActivity[];
  readonly others: readonly import('../../presence/contract.js').PresenceSession[];
  command(input: import('../../presence/commands.js').PresenceCommand): Promise<void>;
}

/** The same typed resource client, with server-pushed capabilities carried by WebSocket. */
export type AbloWebSocketClient<S extends SchemaRecord> = AbloHttpClient<S> & {
  observe(options?: { signal?: AbortSignal }): AsyncIterable<WebSocketObservedDelta>;
  subscribe<K extends keyof CoreSyncEventMap>(
    event: K,
    listener: (...args: CoreSyncEventMap[K]) => void,
  ): () => void;
  updateSubscription(
    groups: readonly string[],
    options?: { timeoutMs?: number },
  ): Promise<{ groups: string[] }>;
  readonly presence: AbloLivePresence;
  readonly collaboration: {
    send(event: string, payload: Readonly<Record<string, JsonValue>>): Promise<void>;
  };
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
  'claims',
  'logs',
  'identity',
  'getAuthToken',
]);

const ignoreAlreadySurfacedSessionOpeningFailure = (): undefined => undefined;

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
  protocol: HttpTransportModel<T, C>,
  modelName: string,
  clientIdentity: object,
  readSetContext: ReadSetContext | undefined,
): HttpModelClient<T, C> {
  async function readRow(id: string): Promise<T | undefined> {
    const read = await protocol.read({ id });
    capturePointRead(readSetContext, clientIdentity, modelName, id, read.data, read.stamp);
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

  function preparedMutation<P extends {
    readonly claim?: unknown;
    readonly idempotencyKey?: string | null;
    readonly readAt?: number | null;
    readonly reads?: readonly unknown[] | null;
  }>(
    params: P,
  ) {
    const prepared = prepareReadSet(
      readSetContext,
      clientIdentity,
      params.readAt,
      params.idempotencyKey,
      params.reads,
    );
    return {
      ...mutationOptions(params),
      ...(prepared.readAt !== undefined ? { readAt: prepared.readAt } : {}),
      ...(prepared.reads !== undefined ? { reads: prepared.reads } : {}),
      ...(prepared.idempotencyKey !== undefined
        ? { idempotencyKey: prepared.idempotencyKey }
        : {}),
    };
  }

  function update(params: HttpModelMutationParams<ModelUpdateParams<T, C>>): Promise<T>;
  function update(
    id: string,
    updater: ModelUpdater<T>,
    options?: FunctionalUpdateOptions<ReadDependency | CapturedRow>,
  ): Promise<T | undefined>;
  async function update(
    arg: HttpModelMutationParams<ModelUpdateParams<T, C>> | string,
    updater?: ModelUpdater<T>,
    options?: FunctionalUpdateOptions<ReadDependency | CapturedRow>,
  ): Promise<T | undefined> {
    if (typeof arg === 'string') {
      if (!updater) {
        throw new AbloValidationError(
          'Functional update requires an updater function.',
          { code: 'write_options_invalid' },
        );
      }
      const receipt = await reconcileFunctionalUpdate<
        T,
        CommitReceipt,
        ReadDependency | CapturedRow
      >(
        updater,
        options,
        {
          model: modelName,
          id: arg,
          readFresh: async () => {
            const read = await protocol.read({ id: arg });
            capturePointRead(
              readSetContext,
              clientIdentity,
              modelName,
              arg,
              read.data,
              read.stamp,
            );
            return { data: read.data, stamp: read.stamp };
          },
          writeNext: async (patch, readAt) => {
            const opts = preparedMutation({
              readAt,
              reads: options?.reads,
            });
            return await protocol.update({
              ...opts,
              id: arg,
              data: patch,
            });
          },
        },
      );
      return receipt === undefined ? undefined : requireUpdatedRow(arg);
    }

    await protocol.update({
      ...preparedMutation(arg),
      id: arg.id,
      data: arg.data,
    });
    return requireUpdatedRow(arg.id);
  }

  const get = async (
    params: ModelReadParams & ModelReadOptions,
  ): Promise<T | undefined> => {
    const result = await protocol.read(params);
    return result.data;
  };

  const read = async (
    params: ModelReadParams & ModelReadOptions,
  ): Promise<CapturedRow<T> | undefined> => {
    const result = await protocol.read(params);
    capturePointRead(
      readSetContext,
      clientIdentity,
      modelName,
      params.id,
      result.data,
      result.stamp,
    );
    return result.data as CapturedRow<T> | undefined;
  };

  // `create` is overloaded: one row, or a list of them as one atomic commit.
  // A real overloaded function rather than a property arrow, so both public
  // signatures survive — the same reason `updateModel` is written this way.
  function createModel(
    params: HttpModelMutationParams<ModelCreateParams<T, C>>,
  ): Promise<CapturedRow<T>>;
  function createModel(
    params: HttpModelMutationParams<ModelCreateManyParams<C>>,
  ): Promise<CapturedRow<T>[]>;
  async function createModel(
    params:
      | HttpModelMutationParams<ModelCreateParams<T, C>>
      | HttpModelMutationParams<ModelCreateManyParams<C>>,
  ): Promise<CapturedRow<T> | CapturedRow<T>[]> {
    const opts = preparedMutation(params);
    // The list form is one atomic commit through the protocol's batch door.
    // Same verb because it is the same act; the argument says how many.
    if (Array.isArray(params.data)) {
      const rows = await protocol.createMany({
        data: params.data as readonly Record<string, unknown>[],
        ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
        ...(opts.reads ? { reads: [...opts.reads] } : {}),
      });
      return rows as CapturedRow<T>[];
    }
    const single = params as HttpModelMutationParams<ModelCreateParams<T, C>>;
    const resolvedId = resolveCreateId(single.id, single.data);
    const row = await protocol.create({
      ...opts,
      ...(resolvedId !== undefined ? { id: resolvedId } : {}),
      data: single.data as Record<string, unknown>,
    });
    return row as CapturedRow<T>;
  }

  const list = async (
    options?: ServerReadOptions<T>,
  ): Promise<ModelList<T>> => {
    const snapshot = await protocol.list(options);
    return modelList<T>(
      snapshot.data,
      snapshot,
      (cursor) => list({ ...options, cursor }),
    );
  };

  const listAll = async (
    options: ListAllOptions<T> = {},
  ): Promise<T[]> => {
    const { maxPages, signal, ...readOptions } = options;
    signal?.throwIfAborted();
    const first = await list(readOptions);
    return collectModelList(first, { maxPages, signal });
  };

  // Claim acquisition performs its authoritative read only after the grant.
  // Preserve that exact post-grant watermark while retaining the callable
  // namespace and all of its state/list/queue/release/reorder members through the proxy.
  const claim = new Proxy(protocol.claim, {
    apply(target, thisArg, argArray) {
      const result = Reflect.apply(target, thisArg, argArray) as Promise<
        HeldClaim<T> | HeldLease | null
      >;
      return result.then((held) => {
        // A row-free lease (`claim(id)`) carries no snapshot: nothing to capture.
        if (held && 'data' in held && held.readAt !== undefined) {
          capturePointRead(
            readSetContext,
            clientIdentity,
            modelName,
            held.target.id,
            held.data,
            held.readAt,
          );
        }
        return held;
      });
    },
  });

  return {
    get,
    read,
    list,
    listAll,
    create: createModel,
    update,
    async delete(params): Promise<void> {
      await protocol.delete({ ...preparedMutation(params), id: params.id });
    },
    claim,
  };
}

/**
 * Builds the typed headless client. An API-key identity uses HTTP. A session
 * identity uses one lazily opened WebSocket by default for commits and live
 * coordination until `dispose()`; point reads and administration remain HTTP.
 */
/** @internal Constructed only through the public `Ablo()` factory. */
export function createAbloHttpClient<S extends SchemaRecord>(
  options: AbloHttpClientOptions<S>,
): AbloHttpClient<S> | AbloWebSocketClient<S> {
  const { schema, onCommitReceipt, ...rest } = options;
  const usesWebSocket = options.transport === 'websocket'
    || (options.transport === undefined && options.session != null);
  const readSetContext = createReadSetContext();
  const presenceSession = createPresenceSessionSource();
  const transport: HttpTransport = createHttpTransport({
    ...rest,
    presenceSession,
    onCommitReceipt: (observation) => {
      recordHttpCommitReceipt(readSetContext, observation);
      onCommitReceipt?.(observation);
    },
    ...(usesWebSocket ? {
      dispatchCommit: async (input) => {
        const receipt = await (await webSocketSession()).commit(input);
        recordWebSocketCommitReceipt(readSetContext, {
          receipt,
          operations: input.operations,
          reads: input.reads,
        });
        return receipt;
      },
      dispatchClaim: async (input) => (await webSocketSession()).claim(input),
      releaseDispatchedClaim: async (input) =>
        (await webSocketSession()).release(input),
    } : {}),
  });
  const schemaModels = new Set(Object.keys(schema.models));
  const clientIdentity = {};
  const omittedModels = new Set(schema.omittedModels ?? []);
  const models = new Map<
    string,
    HttpModelClient<Record<string, unknown>, Record<string, unknown>>
  >();
  let webSocket: AbloWebSocketSession | null = null;
  let webSocketPromise: Promise<AbloWebSocketSession> | null = null;
  const webSocketOpen = new AbortController();
  let disposed = false;

  const webSocketSession = (): Promise<AbloWebSocketSession> => {
    if (disposed) {
      return Promise.reject(new AbloConnectionError('This Ablo client is disposed.'));
    }
    if (webSocket) return Promise.resolve(webSocket);
    if (webSocketPromise) return webSocketPromise;
    webSocketPromise = (async () => {
      await transport.ready();
      const session = await createWebSocketSession({
        baseUrl: rest.baseURL ?? undefined,
        access: transport.access,
        syncGroups: options.groups,
        collaborationEvents: options.collaborationEvents,
        cursorStore: options.cursorStore,
        cursorKey: options.cursorKey,
        reconnectDelay: options.reconnectDelay,
        maxReconnectDelay: options.maxReconnectDelay,
        connectTimeoutMs: options.connectTimeoutMs,
        presenceSession,
      }, webSocketOpen.signal);
      if (disposed) {
        await session.close();
        throw new AbloConnectionError('This Ablo client is disposed.');
      }
      webSocket = session;
      return session;
    })().finally(() => {
      webSocketPromise = null;
    });
    return webSocketPromise;
  };

  const ready = async (): Promise<void> => {
    await transport.ready();
    if (usesWebSocket) await webSocketSession();
  };

  const livePresence: AbloLivePresence = {
    get active() { return webSocket?.presence.active ?? []; },
    get others() { return webSocket?.presence.others ?? []; },
    command: async (input) => (await webSocketSession()).presence.command(input),
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    webSocketOpen.abort();
    const opening = webSocketPromise;
    if (webSocket) await webSocket.close();
    else await opening?.then((session) => session.close()).catch(ignoreAlreadySurfacedSessionOpeningFailure);
    await transport.dispose();
  };

  const model = (
    name: string,
  ): HttpModelClient<Record<string, unknown>, Record<string, unknown>> => {
    const cached = models.get(name);
    if (cached) return cached;
    const created = createHttpModelClient(
      transport.model(name),
      name,
      clientIdentity,
      readSetContext,
    );
    models.set(name, created);
    return created;
  };

  const commits: CommitResource<ReadDependency | CapturedRow> = {
    async create(commitOptions) {
      const prepared = prepareReadSet(
        readSetContext,
        clientIdentity,
        commitOptions.readAt,
        commitOptions.idempotencyKey,
        commitOptions.reads,
      );
      return transport.commits.create({
        operations: commitOptions.operations,
        ...(commitOptions.claim !== undefined ? { claim: commitOptions.claim } : {}),
        ...(commitOptions.wait !== undefined ? { wait: commitOptions.wait } : {}),
        ...(prepared.readAt !== undefined ? { readAt: prepared.readAt } : {}),
        ...(prepared.reads !== undefined ? { reads: prepared.reads } : {}),
        ...(prepared.idempotencyKey !== undefined
          ? { idempotencyKey: prepared.idempotencyKey }
          : {}),
      });
    },
    get: (options) => transport.commits.get(options),
    list: (options) => transport.commits.list(options),
  };

  const facade = new Proxy<Partial<AbloHttpClient<S>>>({}, {
    get(_target, prop) {
      if (prop === kReadEvidence) {
        return {
          context: readSetContext,
          client: clientIdentity,
          onChange: (reads: readonly ReadDependency[], listener: Parameters<typeof transport.onChange>[1]) =>
            usesWebSocket
              ? subscribeWhenConnected(webSocketSession, reads, listener)
              : transport.onChange(reads, listener),
        };
      }
      if (typeof prop !== 'string') return undefined;
      if (prop === 'commits') return commits;
      if (prop === 'ready') return ready;
      if (prop === 'dispose') return dispose;
      if (usesWebSocket && prop === 'observe') {
        return async function* (observeOptions?: { signal?: AbortSignal }) {
          yield* (await webSocketSession()).observe(observeOptions);
        };
      }
      if (usesWebSocket && prop === 'subscribe') {
        return <K extends keyof CoreSyncEventMap>(
          event: K,
          listener: (...args: CoreSyncEventMap[K]) => void,
        ) => {
          let stop: (() => void) | undefined;
          let cancelled = false;
          void webSocketSession().then((session) => {
            if (!cancelled) stop = session.subscribe(event, listener);
          });
          return () => { cancelled = true; stop?.(); };
        };
      }
      if (usesWebSocket && prop === 'updateSubscription') {
        return async (groups: readonly string[], subscriptionOptions?: { timeoutMs?: number }) => {
          const result = await (await webSocketSession()).updateSubscription(
            groups,
            subscriptionOptions,
          );
          return { groups: result.syncGroups };
        };
      }
      if (usesWebSocket && prop === 'presence') {
        return livePresence;
      }
      if (usesWebSocket && prop === 'collaboration') {
        return {
          send: async (event: string, payload: Readonly<Record<string, JsonValue>>) =>
            (await webSocketSession()).collaboration.send(event, payload),
        };
      }
      // Real protocol members pass through unchanged.
      if (isProtocolMember(prop)) {
        return transport[prop];
      }
      // Only schema models become model accessors. A typo or retired top-level
      // member resolves to undefined instead of manufacturing a plausible client.
      if (schemaModels.has(prop)) return model(prop);
      // A model the schema projection left out is neither a typo nor a member:
      // the caller compiled against the full source schema, so answer with the
      // error that names the model and the fix rather than `undefined`.
      if (omittedModels.has(prop)) throw omittedModelError(prop);
      return undefined;
    },
  });

  // A single boundary cast. `AbloHttpClient<S>` declares only what the model
  // accessor and the passed-through protocol members actually implement, so no
  // method on this type is missing at runtime.
  return facade as AbloHttpClient<S> | AbloWebSocketClient<S>;
}

function subscribeWhenConnected(
  session: () => Promise<AbloWebSocketSession>,
  reads: readonly ReadDependency[],
  listener: Parameters<typeof subscribeWebSocketReadChanges>[2],
): () => void {
  let stop: (() => void) | undefined;
  let cancelled = false;
  void session().then((connected) => {
    if (!cancelled) stop = subscribeWebSocketReadChanges(connected, reads, listener);
  });
  return () => { cancelled = true; stop?.(); };
}
