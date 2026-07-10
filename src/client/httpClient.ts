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
 * Under the hood this wraps the schema-agnostic protocol client that
 * {@link createProtocolClient} returns in a typed proxy. The protocol client
 * commits over `POST /v1/commits` and reads over HTTP, authenticating with the
 * bearer token each time; its model access is string-keyed (`api.model('slides')`).
 * The proxy gives server code the same typed `client.<model>` surface the
 * stateful client offers, over stateless transport.
 */
import {
  createProtocolClient,
  type AbloApi,
  type AbloApiClientOptions,
} from './ApiClient.js';
import type {
  CommitReceipt,
  CommitResource,
  HttpClaimApi,
  ModelRead,
  ModelReadOptions,
  ModelMutationOptions,
  CreateSessionParams,
  AbloSession,
} from './resourceTypes.js';
import type {
  Claim,
  ClaimLookupParams,
  ClaimParams,
  ClaimReorderParams,
  ModelCreateParams,
  ModelDeleteParams,
  ServerReadOptions,
  ModelRetrieveParams,
  ModelUpdateParams,
} from './createModelProxy.js';
import type { Schema, SchemaRecord, InferModel, InferCreate } from '../schema/schema.js';
import type { ModelUpdater, ContentionOptions } from './functionalUpdate.js';

export interface AbloHttpClientOptions<S extends SchemaRecord>
  extends Omit<AbloApiClientOptions, 'schema'> {
  /** The schema. Used only to type the model proxies; it is never sent over the wire or read at runtime. */
  readonly schema: Schema<S>;
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
 * The read shapes differ on purpose. `retrieve` returns a {@link ModelRead}
 * envelope of `{ data, stamp, claims }`, because a stateless client keeps no local
 * copy of the data: the watermark (`stamp`) and any active claims must travel
 * inline on the read so a caller can follow it with a stale-guarded write. `list`
 * returns a plain array.
 */
export interface HttpModelClient<T, C = T> {
  retrieve(params: ModelRetrieveParams & ModelReadOptions): Promise<ModelRead<T>>;
  list(options?: ServerReadOptions<T>): Promise<T[]>;
  /**
   * Creates a row and returns the confirmed server row, including any
   * framework-applied defaults. Matches the stateful client's `create`. Passing an
   * id that already exists is idempotent: the existing row is returned unchanged.
   */
  create(params: ModelCreateParams<T, C>): Promise<T>;
  update(params: ModelUpdateParams<C>): Promise<CommitReceipt>;
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
  ): Promise<CommitReceipt | undefined>;
  delete(params: ModelDeleteParams<T>): Promise<CommitReceipt>;
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
  /** Looks up a model client by name, for when the model name is only known at runtime. */
  model<T = Record<string, unknown>>(name: string): HttpModelClient<T>;
};

/**
 * Names on the underlying protocol client that pass straight through the proxy.
 * This set intentionally leaves out names that collide with common schema models —
 * `tasks`, `claims`, `capabilities`, `agent` — so that `client.tasks` resolves to
 * the schema model named `tasks` rather than a protocol resource. Only lifecycle
 * methods and the genuinely protocol-level members belong here.
 */
const PROTOCOL_MEMBERS = new Set<string>([
  'ready',
  'waitForFlush',
  'dispose',
  'purge',
  'commits',
  'model',
  'getAuthToken',
  'sessions',
]);

/**
 * Builds the stateless, typed HTTP client. Each `client.<model>` resolves to the
 * protocol client's model accessor, while `commits`, `dispose`, and the other
 * protocol members pass through unchanged. No socket is ever opened; the bearer
 * credential is the identity.
 */
export function createAbloHttpClient<S extends SchemaRecord>(
  options: AbloHttpClientOptions<S>,
): AbloHttpClient<S> {
  // The schema is type-level only; the protocol client is schema-agnostic.
  const { schema: _schema, ...rest } = options;
  const api: AbloApi = createProtocolClient({ ...rest, schema: null });

  const facade = new Proxy(api as unknown as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (typeof prop !== 'string') return Reflect.get(target, prop);
      // Real protocol members pass through unchanged.
      if (PROTOCOL_MEMBERS.has(prop) && prop in target) return Reflect.get(target, prop);
      // Anything else is a typed model accessor → the string-keyed protocol model
      // (which implements retrieve/list/create/update/delete/claim — every method
      // `HttpModelClient` declares).
      return api.model(prop);
    },
  });

  // A single boundary cast. `AbloHttpClient<S>` declares only what the model
  // accessor and the passed-through protocol members actually implement, so no
  // method on this type is missing at runtime.
  return facade as unknown as AbloHttpClient<S>;
}
