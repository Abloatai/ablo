/**
 * `createAbloHttpClient` — a STATELESS, typed HTTP client for server-side actors
 * (agents, workers, serverless), modelled on `@liveblocks/node` / the Stripe
 * server SDK / Netflix Conductor workers: it talks to Ablo over plain HTTP with
 * the credential as identity, and holds **no WebSocket and no connection state**.
 *
 * Why this exists (docs/plans/agent-transport-event-driven.md): the stateful
 * `Ablo({ schema })` client is for INTERACTIVE participants — it opens a
 * WebSocket and seeds its identity (userId/orgId) during the connect/bootstrap
 * step, then routes writes through a `TransactionQueue` that drops mutations
 * until that identity exists. A reactive agent has no socket, so that identity is
 * never seeded and writes drop. The proven fix (unanimous across Liveblocks,
 * Stripe, PlanetScale, Conductor, Better Auth) is NOT to de-socket the stateful
 * client — it's a separate stateless client where the credential carries identity
 * and the SERVER resolves it per request.
 *
 * Ablo already has that stateless surface: `Ablo({ schema: null })` returns the
 * protocol client (`createProtocolClient` → `AbloApi`), which commits via
 * `POST /v1/commits` and reads via the HTTP `ApiClient`, authenticating with the
 * Bearer token on every request. Its only ergonomic gap is that model access is
 * string-keyed (`api.model('slides')`) rather than typed (`api.slides`). This
 * wraps it in a typed proxy facade so server code gets the SAME `client.<model>`
 * surface as the browser client — typed proxies, stateless transport.
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
} from './Ablo.js';
import type {
  ClaimHandle,
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

export interface AbloHttpClientOptions<S extends SchemaRecord>
  extends Omit<AbloApiClientOptions, 'schema'> {
  /** The schema — used for TYPING only (typed model proxies); never sent or used at runtime. */
  readonly schema: Schema<S>;
}

/**
 * The per-model HTTP surface — exactly what a stateless client can do over
 * request/response: reads (`retrieve`/`list`), writes (`create`/`update`/`delete`),
 * and the durable-lease claim plane (`claim` — acquire/hold/release). It does NOT
 * include `get`/`getAll`/`getCount` (local synced-pool reads) or `onChange` (live
 * subscription); those need the stateful plane and are absent BY TYPE here.
 *
 * Read-shape asymmetry (by design, not a gap): `retrieve(...)` returns a
 * `ModelRead<T>` envelope `{ data, stamp, claims }` — the stateless client has no
 * local graph, so the watermark/claims the stateful client reads from its pool
 * must ride inline on the read (an agent needs the `stamp` to do a stale-guarded
 * write; there is no `snapshot()` to fetch it from). `list(...)` returns a bare `T[]`.
 */
export interface HttpModelClient<T, C = T> {
  retrieve(params: ModelRetrieveParams & ModelReadOptions): Promise<ModelRead<T>>;
  list(options?: ServerReadOptions<T>): Promise<T[]>;
  create(params: ModelCreateParams<T, C>): Promise<CommitReceipt>;
  update(params: ModelUpdateParams<C>): Promise<CommitReceipt>;
  delete(params: ModelDeleteParams<T>): Promise<CommitReceipt>;
  claim: HttpClaimApi<T>;
}

/**
 * The honest type of the stateless HTTP client: typed model proxies (the
 * request/response subset) + `commits` + `dispose`. Reaching for a
 * stateful-only capability (`get`/`getAll`/`getCount`, `onChange`,
 * `claim.state`/`queue`/`reorder`) is a COMPILE error here, not a latent runtime
 * `undefined` — the type matches what the transport can actually do.
 */
export type AbloHttpClient<S extends SchemaRecord> = {
  readonly [K in keyof S & string]: HttpModelClient<
    InferModel<Schema<S>, K>,
    InferCreate<Schema<S>, K>
  >;
} & {
  /** Register `databaseUrl` when configured. Also runs lazily before the first request. */
  ready(): Promise<void>;
  readonly commits: CommitResource;
  dispose(): Promise<void>;
  /** Resolve the bearer credential this client authenticates with (see `AbloApi.getAuthToken`). */
  getAuthToken(): Promise<string | null>;
  /**
   * Mint a short-lived scoped session (Stripe ephemeral-key shape). Minting is a
   * stateless control-plane call, so — unlike `get`/`getAll`/`onChange` — it IS
   * available on the HTTP client. `{ user }` → `ek_`, `{ agent, can }` → `rk_`.
   */
  readonly sessions: { create(params: CreateSessionParams<S>): Promise<AbloSession> };
  /** String-keyed model accessor (for dynamic model names). */
  model<T = Record<string, unknown>>(name: string): HttpModelClient<T>;
};

/**
 * Members of the underlying `AbloApi` that pass straight through the facade.
 * Deliberately EXCLUDES the resource names that collide with common schema model
 * names — `tasks`, `claims`, `capabilities`, `agent` — so `client.tasks` resolves
 * to the schema model `tasks`, not the protocol `TaskResource`. Only lifecycle +
 * the genuinely-protocol methods an agent uses pass through.
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
 * Stateless, typed HTTP client. Each `client.<model>` resolves to the protocol
 * client's `model(name)`; `commits`, `dispose`, etc. pass through. No socket is
 * ever opened; identity is the Bearer credential.
 */
export function createAbloHttpClient<S extends SchemaRecord>(
  options: AbloHttpClientOptions<S>,
): AbloHttpClient<S> {
  // The schema is type-level only; the protocol client is schema-agnostic.
  const { schema: _schema, ...rest } = options;
  const api: AbloApi = createProtocolClient({ ...rest, schema: null } as AbloApiClientOptions);

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

  // One boundary cast — and now an HONEST one: `AbloHttpClient<S>` declares only
  // what `api.model()` + the passed-through protocol members actually implement,
  // so there is no method on this type that fails at runtime.
  return facade as unknown as AbloHttpClient<S>;
}
