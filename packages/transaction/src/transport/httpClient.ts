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
  CommitReceipt,
  HttpClaimApi,
  HttpClaimsResource,
  HttpLogsResource,
  HttpTransportModel,
  ModelReadOptions,
  ModelMutationOptions,
  CreateSessionParams,
  AbloSession,
  SessionResource,
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
import { omittedModelError } from '../schema/select.js';
import {
  reconcileFunctionalUpdate,
  type ModelUpdater,
  type FunctionalUpdateOptions,
} from '../resources/functionalUpdate.js';
import type { HeldClaim } from '../types/streams.js';
import { AbloConnectionError, AbloValidationError } from '../errors.js';
import type { OnStaleMode, ReadDependency } from '../coordination/schema.js';
import {
  abortReadSetCommit,
  capturePointRead,
  createReadSetContext,
  consumeReadSet,
  prepareReadSet,
  type ReadSetContext,
} from '../readSetContext.js';
import { recordHttpCommitReceipt } from '../commitRecordRuntime.js';
import type { EffectiveAuthority } from '../auth/capability.js';

export interface AbloHttpClientOptions<S extends SchemaRecord>
  extends HttpClientConfig<S> {
  /**
   * Per-request deadline. A black-holed HTTP request otherwise has no platform
   * timeout and can stall a headless worker forever. Pass `0` to disable it.
   * @default 30_000
   */
  readonly timeoutMs?: number;
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
 * request/response: reads (`get` and `list`), writes (`create`, `update`,
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
 * The typed model contract is transport-independent: `get` returns one row,
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
   * synchronous `local.get` exists alongside this: same read, restricted
   * to what is already here.
   */
  /** Canonical authoritative point lookup. A miss resolves to `undefined`. */
  get(params: ModelRetrieveParams & ModelReadOptions): Promise<CapturedRow<T> | undefined>;
  /** @deprecated Use `get({ id })` for an authoritative point lookup. */
  retrieve(params: ModelRetrieveParams & ModelReadOptions): Promise<CapturedRow<T> | undefined>;
  /**
   * Reads the rows matching a filter. Same resolution as `get`, in bulk,
   * and deduplicated so concurrent identical calls share one request.
   */
  list(options?: ServerReadOptions<T>): Promise<CapturedRow<T>[]>;
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
  /** Replays every pending durable HTTP write in seal order and waits for confirmation. */
  waitForFlush(): Promise<void>;
  readonly commits: CommitResource;
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
  dispose(): Promise<void>;
  /** Resolves the bearer credential this client authenticates with, or `null` if none is set. */
  getAuthToken(): Promise<string | null>;
  /**
   * Mints a short-lived, scoped session token. Minting is itself a stateless
   * request, so it is available here even though the local-cache reads are not.
   * Pass `{ user }` to mint an end-user key (`ek_`) or `{ agent, can }` to mint a
   * scoped agent key (`rk_`). See {@link CreateSessionParams}.
  */
  readonly sessions: SessionResource<S>;
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
  protocol: HttpTransportModel<T, C>,
  modelName: string,
  clientIdentity: object,
  readSetContext: ReadSetContext | undefined,
): HttpModelClient<T, C> {
  async function readRow(id: string): Promise<T | undefined> {
    const read = await protocol.get({ id });
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
    readonly onStale?: OnStaleMode | null;
    readonly reads?: readonly unknown[] | null;
  }>(
    params: P,
  ) {
    const prepared = prepareReadSet(
      readSetContext,
      clientIdentity,
      params.readAt,
      params.onStale,
      params.idempotencyKey,
      params.reads,
    );
    return {
      options: {
        ...mutationOptions(params),
        ...(prepared.readAt !== undefined ? { readAt: prepared.readAt } : {}),
        ...(prepared.onStale !== undefined ? { onStale: prepared.onStale } : {}),
        ...(prepared.reads !== undefined ? { reads: prepared.reads } : {}),
        ...(prepared.idempotencyKey !== undefined
          ? { idempotencyKey: prepared.idempotencyKey }
          : {}),
      },
      consumed: prepared.consumed,
      automaticCommit: prepared.automaticCommit,
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
            const read = await protocol.get({ id: arg });
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
            const prepared = preparedMutation(
              {
                readAt,
                onStale: 'reject' as const,
                reads: options?.reads,
              },
            );
            try {
              const result = await protocol.update({
                ...prepared.options,
                id: arg,
                data: patch,
              });
              consumeReadSet(
                readSetContext,
                clientIdentity,
                prepared.consumed,
                prepared.automaticCommit,
              );
              return result;
            } catch (error) {
              abortReadSetCommit(readSetContext, prepared.automaticCommit);
              throw error;
            }
          },
        },
      );
      return receipt === undefined ? undefined : requireUpdatedRow(arg);
    }

    const prepared = preparedMutation(arg);
    try {
      await protocol.update({
        ...prepared.options,
        id: arg.id,
        data: arg.data,
      });
    } catch (error) {
      abortReadSetCommit(readSetContext, prepared.automaticCommit);
      throw error;
    }
    consumeReadSet(
      readSetContext,
      clientIdentity,
      prepared.consumed,
      prepared.automaticCommit,
    );
    return requireUpdatedRow(arg.id);
  }

  const get = async (
    params: ModelRetrieveParams & ModelReadOptions,
  ): Promise<CapturedRow<T> | undefined> => {
    const read = await protocol.get(params);
    capturePointRead(
      readSetContext,
      clientIdentity,
      modelName,
      params.id,
      read.data,
      read.stamp,
    );
    return read.data as CapturedRow<T> | undefined;
  };

  const list = async (options?: ServerReadOptions<T>): Promise<CapturedRow<T>[]> => {
    const snapshot = await protocol.list(options);
    const registry = readSetContext?.getStore();
    if (!registry) return [...snapshot.data] as CapturedRow<T>[];
    if (!snapshot.evidence) {
      throw new AbloConnectionError(
        `${modelName}.list did not return row evidence. Upgrade the Ablo server or use get({ id }).`,
        { code: 'commit_no_result' },
      );
    }
    const byId = new Map(snapshot.evidence.map((entry) => [entry.id, entry.stamp]));
    for (const row of snapshot.data) {
      const id = typeof row === 'object' && row !== null
        ? Reflect.get(row as object, 'id')
        : undefined;
      const stamp = typeof id === 'string' ? byId.get(id) : undefined;
      if (typeof id !== 'string' || stamp === undefined) {
        throw new AbloConnectionError(
          `${modelName}.list returned a row without matching evidence.`,
          { code: 'commit_no_result' },
        );
      }
      capturePointRead(readSetContext, clientIdentity, modelName, id, row, stamp);
    }
    return [...snapshot.data] as CapturedRow<T>[];
  };

  // Claim acquisition performs its authoritative read only after the grant.
  // Preserve that exact post-grant watermark while retaining the callable
  // namespace and all of its state/queue/release members through the proxy.
  const claim = new Proxy(protocol.claim, {
    apply(target, thisArg, argArray) {
      const result = Reflect.apply(target, thisArg, argArray) as Promise<HeldClaim<T> | null>;
      return result.then((held) => {
        if (held && held.readAt !== undefined) {
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
    retrieve: get,
    list,
    async create(params): Promise<T> {
      const id = params.id ?? '';
      const prepared = preparedMutation(params);
      let row: T;
      try {
        row = await protocol.create({
          ...prepared.options,
          ...(params.id !== undefined ? { id: params.id } : {}),
          data: params.data as Record<string, unknown>,
        });
      } catch (error) {
        abortReadSetCommit(readSetContext, prepared.automaticCommit);
        throw error;
      }
      consumeReadSet(
        readSetContext,
        clientIdentity,
        prepared.consumed,
        prepared.automaticCommit,
      );
      return row;
    },
    update,
    async delete(params): Promise<void> {
      const prepared = preparedMutation(params);
      try {
        await protocol.delete({ ...prepared.options, id: params.id });
      } catch (error) {
        abortReadSetCommit(readSetContext, prepared.automaticCommit);
        throw error;
      }
      consumeReadSet(
        readSetContext,
        clientIdentity,
        prepared.consumed,
        prepared.automaticCommit,
      );
    },
    claim,
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
  const { schema, onCommitReceipt, ...rest } = options;
  const readSetContext = createReadSetContext();
  const transport: HttpTransport = createHttpTransport({
    ...rest,
    // Derived from the schema this client is bound to, never assembled by hand
    // — see `auth/capability.ts`.
    modelTypenames: modelWireNames(schema.models),
    onCommitReceipt: (observation) => {
      recordHttpCommitReceipt(readSetContext, observation);
      onCommitReceipt?.(observation);
    },
  });
  const schemaModels = new Set(Object.keys(schema.models));
  const clientIdentity = {};
  const omittedModels = new Set(schema.omittedModels ?? []);
  const models = new Map<
    string,
    HttpModelClient<Record<string, unknown>, Record<string, unknown>>
  >();

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

  const facade = new Proxy<Partial<AbloHttpClient<S>>>({}, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
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
  return facade as AbloHttpClient<S>;
}
