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
import type { AbloOptions } from './options.js';
import type {
  CommitResource,
  HttpClaimApi,
  HttpTransportModel,
  ModelReadOptions,
  ModelMutationOptions,
  CreateSessionParams,
  AbloSession,
} from './resourceTypes.js';
import type {
  ModelCreateParams,
  ModelDeleteParams,
  ServerReadOptions,
  ModelRetrieveParams,
  ModelUpdateParams,
} from './createModelProxy.js';
import type { Schema, SchemaRecord, InferModel, InferCreate } from '../schema/schema.js';
import type { ModelUpdater, ContentionOptions } from './functionalUpdate.js';
import { AbloConnectionError, AbloValidationError } from '../errors.js';

export interface AbloHttpClientOptions<S extends SchemaRecord>
  extends AbloOptions<S> {
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
 * and `delete`), and the durable-lease {@link HttpClaimApi | claim} plane for
 * coordinated writes. It deliberately omits the stateful client's local-cache
 * reads (`get`, `getAll`, `getCount`) and live subscriptions (`onChange`), which
 * need a persistent socket; those are absent from the type, so reaching for one
 * is a compile error rather than a runtime gap.
 *
 * The typed model contract is transport-independent: `retrieve` returns one row,
 * `list` returns rows, `create`/`update` return the resulting row, and `delete`
 * returns nothing. The low-level protocol client keeps its read watermark and
 * commit receipt envelopes internally; callers should not have to change data
 * access syntax when they switch transport.
 */
export interface HttpModelClient<T, C = T> {
  retrieve(params: ModelRetrieveParams & ModelReadOptions): Promise<T | undefined>;
  list(options?: ServerReadOptions<T>): Promise<T[]>;
  /**
   * Creates a row and returns the confirmed server row, including any
   * framework-applied defaults. Matches the stateful client's `create`. Passing an
   * id that already exists is idempotent: the existing row is returned unchanged.
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
}

/**
 * The type of the stateless HTTP client: a typed {@link HttpModelClient} per
 * schema model, plus `commits`, `dispose`, and the session-mint surface. It
 * exposes only what request/response transport can do, so reaching for a
 * stateful-only capability — `get`, `getAll`, `getCount`, `onChange`, or the
 * synchronous `claim.state`/`queue`/`reorder` reads — is a compile error rather
 * than a value that is `undefined` at runtime.
 */
export type AbloHttpClient<S extends SchemaRecord> = {
  readonly [K in keyof S & string]: HttpModelClient<
    InferModel<Schema<S>, K>,
    InferCreate<Schema<S>, K>
  >;
} & {
  /** Runs one-time setup, such as registering a configured `databaseUrl` data source, before the client is used. It also runs lazily ahead of the first request, so calling it yourself is optional. */
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
  const modelTypenames = Object.fromEntries(
    Object.entries(schema.models).map(([key, definition]) => [
      key,
      definition.typename ?? key,
    ]),
  );
  const transport: HttpTransport = createHttpTransport({
    ...rest,
    modelTypenames,
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
