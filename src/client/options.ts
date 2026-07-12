/**
 * The option types for the {@link Ablo} client: the public {@link AbloOptions}
 * bag callers pass, and the fuller {@link InternalAbloOptions} construction
 * surface. This module holds only types and has no runtime imports.
 */

import type { Schema, SchemaRecord } from '../schema/schema.js';
import type {
  SyncEngineConfig,
  SyncLogger,
  MutationExecutor,
  SyncObservabilityProvider,
  SyncAnalytics,
  SessionErrorDetector,
  OnlineStatusProvider,
} from '../interfaces/index.js';
import type { AbloPersistence } from './persistence.js';
import type { CommitOutboxStore } from '../transactions/commitOutboxStore.js';
import type { CommitOutboxScope } from '../transactions/commitEnvelope.js';

// ── Options ───────────────────────────────────────────────────────────────

/**
 * An async function that resolves an apiKey at request time. Use it for credential
 * rotation — read from a vault, refresh from session storage, or pull from an
 * existing auth session. The canonical definition lives in `./auth`; it is
 * re-exported here for convenience.
 */
export type { ApiKeySetter } from './auth.js';
import type { ApiKeySetter } from './auth.js';

/**
 * Options for the {@link Ablo} client.
 *
 * The only required field is `schema`. Because `apiKey` defaults to the
 * `ABLO_API_KEY` environment variable, most server setups need nothing more:
 *
 * ```ts
 * const ablo = Ablo({ schema, apiKey: process.env.ABLO_API_KEY });
 * ```
 *
 * Every other field is optional tuning — timeouts, retries, a custom fetch,
 * persistence. If you are unsure whether you need one, you do not.
 *
 * @see https://docs.abloatai.com — full option reference
 */
export interface AbloOptions<S extends SchemaRecord = SchemaRecord> {
  /**
   * TypeScript schema defined with `defineSchema()`. Required — it's what
   * makes `ablo.weatherReports.update(...)` typed. This is the one field you must
   * pass; start here.
   */
  schema: Schema<S>;

  /**
   * The API key — the auth field most apps set. It accepts three shapes:
   *
   *  - **A key string** (server): your secret `sk_` key. Defaults to the
   *    `ABLO_API_KEY` environment variable, so you usually pass nothing. A
   *    long-lived key needs no refresh; the client uses it as-is.
   *
   *  - **An endpoint path or URL** — for example `apiKey: '/api/ablo-session'`.
   *    The client owns the whole exchange: it POSTs the endpoint (same-origin,
   *    cookies included), reads the minted short-lived token, and keeps it fresh
   *    with a refresh timer ahead of expiry, a re-mint after the machine wakes
   *    from sleep, and a re-mint when the server reports the token stale. You
   *    never call a refresh method yourself. The shape is detected by prefix (`/`,
   *    `http://`, or `https://`); key strings start with `sk_`/`ek_`/`rk_`, so the
   *    two cannot be confused. A long-lived server client should pass an absolute
   *    URL, which also enables pre-expiry renewal on hosts that never sleep.
   *
   *  - **An async resolver** `() => Promise<string | null>` — the escape hatch for
   *    when the exchange needs custom headers, a request body, or a non-HTTP mint
   *    (vault rotation, a cloud token service, an existing auth session). It uses
   *    the same renewal machinery as the endpoint form.
   *
   * The endpoint and resolver forms share one contract: return a token; return
   * `null` when the login itself is gone (terminal — the client signs out and
   * fails `ready()` with `session_expired`); or throw on a transient failure, which
   * backs off and retries without signing out. The endpoint form maps HTTP onto
   * this for you: 401 and 403 mean signed out, any other failure is transient.
   */
  apiKey?: string | ApiKeySetter | null | undefined;

  /**
   * The session-mint endpoint — the browser-side auth field, and the named
   * counterpart to the endpoint-string form of {@link AbloOptions.apiKey}. Point it
   * at the route that mints the signed-in user's short-lived token:
   *
   * ```ts
   * const ablo = Ablo({ schema, authEndpoint: '/api/ablo-session' });
   * ```
   *
   * The client owns the whole exchange: it POSTs the route (same-origin, cookies
   * included), reads `{ token }`, keeps it fresh ahead of expiry, and re-mints when
   * the server reports the token stale. A 401 or 403 from the route means signed
   * out; any other failure is retried rather than treated as a sign-out. It also
   * accepts an async resolver `() => Promise<string | null>` when the exchange
   * needs custom headers or a body — the same contract as the resolver form of
   * `apiKey`.
   *
   * Mutually exclusive with `apiKey`: a server holds a key, a browser holds a mint
   * route, and passing both is a validation error.
   */
  authEndpoint?: string | ApiKeySetter | null | undefined;

  /**
   * @deprecated The direct connector lets Ablo dial into your Postgres and write to
   * it directly. Prefer the signed data-source endpoint: keep your `DATABASE_URL`
   * in your own app, expose `dataSource(...)`, and let your server own the write
   * while Ablo coordinates the sync stream. Ablo hosts only the ordered
   * `sync_deltas` log and coordination, never your rows. To keep the log in your own
   * infrastructure as well, self-host the engine.
   *
   * Still honored at runtime for backward compatibility. It is server-only: because
   * it carries credentials it is never sent from the browser, and constructing a
   * client with both `databaseUrl` and `dangerouslyAllowBrowser` throws. If you do
   * use it, supply a role that is neither a superuser nor `BYPASSRLS`; the connector
   * rejects privileged roles that cannot enforce row-level security.
   */
  databaseUrl?: string | null | undefined;

  /**
   * Local persistence mode. Pass `indexeddb` only when you want offline
   * queueing and a reload-surviving browser cache.
   *
   * @default 'memory'
   */
  persistence?: AbloPersistence;

  /**
   * Durable commit-envelope storage for server-side agents and workers.
   * The stateful browser client uses its strict IndexedDB transaction store;
   * the stateless HTTP client has no implicit filesystem and therefore needs a
   * workflow-, SQLite-, or filesystem-backed implementation to survive a
   * process restart. One store may serve several actors because every record
   * is checked against its authenticated scope before replay.
   */
  commitOutbox?: CommitOutboxStore;

  /**
   * Stable actor/server scope for an injected HTTP {@link commitOutbox}.
   * Omit it to resolve `organizationId` and `participantId` from the authenticated
   * `/auth/identity` endpoint. Supplying it avoids that one setup request in
   * trusted worker environments; `namespace` distinguishes deployments or
   * workflow lanes that share the same actor identity.
   */
  commitOutboxScope?: CommitOutboxScope;

  /**
   * Selects the transport. `'websocket'` (the default) is the live client: a
   * persistent socket, a local synced cache, and `onChange` subscriptions. `'http'`
   * returns the stateless client for server-side actors — agents, workers, and
   * serverless handlers. It offers the same `ablo.<model>` surface and coordination
   * plane, but every call is a single HTTP round-trip, identity rides the bearer
   * credential, and no socket is opened. With `'http'` the return type narrows to
   * {@link AbloHttpClient}, so stateful-only capabilities such as `get`, `getAll`,
   * and `onChange` become compile errors instead of runtime gaps.
   *
   * Note: session minting through `sessions.create` runs on the default WebSocket
   * client, not the HTTP client.
   *
   * @default 'websocket'
   */
  transport?: 'websocket' | 'http' | undefined;

  /**
   * Turns Ablo's diagnostic logging on or off. `true` surfaces the `[Ablo]`
   * coordination trace — claims requested, queued, granted, and released, agent
   * handovers, and connection state — so you can watch the coordination between
   * humans and agents while debugging. Omitting it, or `false`, keeps the quiet
   * default of warnings and errors only. For a middle ground use {@link logLevel}.
   * The `ABLO_LOG_LEVEL` environment variable overrides it, and a custom logger
   * takes precedence.
   */
  debug?: boolean | undefined;

  /**
   * The log threshold for the default `[Ablo]` logger; takes precedence over
   * {@link debug}. `'info'` shows coordination and connection events without the
   * per-model registration detail, `'debug'` shows everything, `'warn'` (the
   * default) shows warnings and errors only, and `'silent'` shows nothing. The
   * `ABLO_LOG_LEVEL` environment variable overrides it.
   */
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent' | undefined;

  // ── Advanced (you usually don't need these) ─────────────────────────
  // Connection and transport tuning. The defaults are set for hosted production;
  // override them only for self-hosting, tests, proxies, or unusual runtimes.

  /**
   * Bearer auth token. Hosted-cloud consumers pass `apiKey`; self-hosted
   * deployments may pass a bearer token minted by their own auth layer.
   */
  authToken?: string | null | undefined;

  /**
   * Override the Ablo API base URL. Defaults to hosted production.
   */
  baseURL?: string | null | undefined;

  /** Custom fetch implementation for tests, proxies, or non-standard runtimes. */
  fetch?: typeof fetch | undefined;

  /** Default headers sent with every API request. */
  defaultHeaders?: Record<string, string | null | undefined> | undefined;

  /** Default query parameters sent with every API request. */
  defaultQuery?: Record<string, string | undefined> | undefined;

  /**
   * Client-side use is disabled by default because private API keys should
   * not ship to browsers. Set this only when the browser holds a minted
   * session token (`ek_`/`rk_`) or you route through a controlled server proxy.
   */
  dangerouslyAllowBrowser?: boolean | undefined;
}

export interface InternalAbloOptions<S extends SchemaRecord = SchemaRecord> {
  /**
   * The API key used for authentication.
   *
   * Accepts a static string (`sk_live_...`) or an async function that resolves to
   * one. Defaults to the `ABLO_API_KEY` environment variable.
   *
   * When a function is provided, it is invoked before each request, so you can
   * rotate or refresh credentials at runtime. It must return a non-empty string, or
   * an `AbloAuthenticationError` is thrown; if it throws, the error is wrapped with
   * the original available as `cause`.
   */
  apiKey?: string | ApiKeySetter | null | undefined;

  /**
   * Session-mint endpoint (string or async resolver) — see
   * {@link AbloOptions.authEndpoint}. Mutually exclusive with `apiKey`.
   */
  authEndpoint?: string | ApiKeySetter | null | undefined;

  /**
   * A bearer auth token, sent as `Authorization: Bearer <token>` on every request.
   *
   * Use it for self-hosted deployments where your own auth layer mints capability
   * tokens directly. Hosted-cloud consumers pass `apiKey` instead and let the
   * server mint the capability token.
   */
  authToken?: string | null | undefined;

  /**
   * Override the default base URL. Defaults to
   * `wss://api.abloatai.com` for hosted production; pass an explicit
   * URL for self-hosted or private deployments.
   */
  baseURL?: string | null | undefined;

  /**
   * Custom `fetch` implementation. Defaults to `globalThis.fetch`.
   * Override for testing, custom transports, or runtime shims.
   */
  fetch?: typeof fetch | undefined;

  /**
   * Default headers to include with every request to the API.
   * Removed per-request by setting the header to `null` in request
   * options.
   */
  defaultHeaders?: Record<string, string | null | undefined> | undefined;

  /**
   * Default query parameters to include with every request.
   * Removed per-request by setting the param to `undefined`.
   */
  defaultQuery?: Record<string, string | undefined> | undefined;

  /**
   * Client-side use of this SDK is disabled by default — your apiKey
   * would ship to every visitor's network tab. Only set this to
   * `true` if you've understood the risk and have appropriate
   * mitigations (a minted session token, a server-side proxy, etc).
   */
  dangerouslyAllowBrowser?: boolean | undefined;

  /**
   * TypeScript schema defined with `defineSchema()`.
   *
   * The root `Ablo(...)` client is schema-first so consumers get typed
   * model clients such as `ablo.weatherReports.update(...)`. Omit `schema`
   * only for the advanced Model / Claim / Commit client.
   */
  schema: Schema<S>;

  // ── Deprecated ──────────────────────────────────────────────────────
  // Options retained for backward compatibility. New consumers should pass only
  // `{ schema, apiKey }` and let Ablo resolve account scope, participant identity,
  // and realtime permissions from the key.

  /**
   * @deprecated The server derives the participant kind from the apiKey's scope.
   * Pass `apiKey` only.
   */
  kind?: 'user' | 'agent' | 'system';

  /**
   * @deprecated The server derives user identity from the apiKey's scope, or from
   * the `Ablo-Acting-User` request header for multi-tenant setups. Pass `apiKey`
   * only.
   */
  user?: {
    id: string;
    teamIds?: string[];
  };

  /**
   * @deprecated The server derives agent identity from the apiKey's scope. Pass
   * `apiKey` only.
   */
  agentId?: string;

  /**
   * @deprecated Pass `apiKey` only; the server issues the capability token.
   */
  capabilityToken?: string;

  /** Custom logger (default: console). Supplying one bypasses {@link debug}/{@link logLevel}. */
  logger?: SyncLogger;

  /**
   * Turns Ablo's diagnostic logging on or off. `true` surfaces the `[Ablo]`
   * coordination trace — claims acquired, queued, granted, and released, agent
   * handovers, and connection state — along with internal lifecycle events, so you
   * can watch the coordination between humans and agents. Omitting it, or `false`,
   * keeps the quiet default of warnings and errors only. For a middle ground use
   * {@link logLevel}. The `ABLO_LOG_LEVEL` environment variable overrides it, and a
   * custom {@link logger} takes precedence.
   */
  debug?: boolean;

  /**
   * The log threshold for the default `[Ablo]` logger; takes precedence over
   * {@link debug}. `'info'` shows coordination and connection events without the
   * per-model registration detail, `'debug'` shows everything, `'warn'` (the
   * default) shows warnings and errors only, and `'silent'` shows nothing. The
   * `ABLO_LOG_LEVEL` environment variable overrides it.
   */
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent';

  /** InstanceCache size limit (default: 10000) */
  maxPoolSize?: number;

  /**
   * Local persistence mode. Defaults to `memory`, keeping the local cache in
   * process rather than adding IndexedDB durability to every browser consumer.
   *
   * Pass `persistence: 'indexeddb'` only when you want offline queueing and a
   * reload-surviving local cache in a browser.
   */
  persistence?: AbloPersistence;

  /** Internal mirror of {@link AbloOptions.commitOutbox}. */
  commitOutbox?: CommitOutboxStore;

  /** Internal mirror of {@link AbloOptions.commitOutboxScope}. */
  commitOutboxScope?: CommitOutboxScope;

  /** @deprecated Use `persistence: 'indexeddb'` for durable browser storage. */
  offline?: boolean;

  /**
   * @deprecated Internal/testing escape hatch. Use `persistence` in
   * production code. `true` maps to `memory`; `false` maps to
   * `indexeddb` in browsers.
   */
  inMemory?: boolean;

  /**
   * When `true`, initialization starts immediately in the background, so reads work
   * once `await ready()` resolves.
   *
   * When `false` (the default), you must call `await ready()` before using the
   * engine; any query before that returns empty results. The explicit default
   * guards against silent initialization failures.
   */
  autoStart?: boolean;

  /**
   * How much baseline state this client pulls at startup.
   *
   *  - `'full'`: pull every delta in the configured sync groups before `ready()`
   *    resolves. The default for user clients.
   *  - `'none'`: open the socket and process live deltas only, with no baseline
   *    fetch. Reads round-trip through `retrieve`, and subscriptions fill the local
   *    cache lazily. The default for agent clients, which do not need a local
   *    replica of the organization's data.
   */
  bootstrapMode?: 'full' | 'none';

  // ── Advanced dependency-injection overrides ──────────────────────────────
  //
  // The fields below let an integrator replace the client's no-op defaults with
  // their own implementations, so an app that already runs its own observability,
  // analytics, and mutation executor can keep them. Most consumers can ignore
  // these — the built-in defaults work for the documented zero-config setup.

  /**
   * Custom observability provider (Sentry, Honeycomb, OTel, etc.).
   * Default: a noop implementation that drops all breadcrumbs and spans.
   */
  observability?: SyncObservabilityProvider;

  /**
   * Custom analytics provider (PostHog, Amplitude, Segment, etc.).
   * Default: a noop implementation that drops all events.
   */
  analytics?: SyncAnalytics;

  /**
   * Detect whether an error from a mutation/bootstrap response means the
   * user's session has expired. Used to surface re-auth prompts. Default:
   * heuristic that matches `401 Unauthorized` and a few common error shapes.
   */
  sessionErrorDetector?: SessionErrorDetector;

  /**
   * Detect whether the browser is currently online. Default: reads
   * `navigator.onLine` and listens to the `online`/`offline` events.
   */
  onlineStatus?: OnlineStatusProvider;

  /**
   * Replace the built-in `MutationExecutor` (which posts a hardcoded
   * `commit` method against `${url}/graphql`) with one that uses your own
   * GraphQL client, auth headers, retry policy, and observability hooks.
   *
   * Default: a fetch-based executor that targets `${url}/graphql` and sends
   * the configured bearer (`apiKey` / backend-minted token) as `Authorization`.
   */
  mutationExecutor?: MutationExecutor;

  /**
   * Partial overrides for the auto-derived `SyncEngineConfig`. Merged on
   * top of `deriveConfigFromSchema(schema)`. Use this when you need
   * specific `modelCreatePriority`, `batchableModels`, or
   * `essentialFields` settings that the schema cannot express.
   */
  configOverrides?: Partial<SyncEngineConfig>;

  /**
   * The sync groups (entity scopes) this client subscribes to. Normally the server
   * derives these from the apiKey's scope; pass them explicitly when the key does
   * not resolve them, otherwise the client fans out nothing and logs a `degenerate
   * syncGroups` warning. Build values with `syncGroup(kind, id)` from
   * `@abloatai/ablo/schema`.
   */
  syncGroups?: string[];

  /**
   * Override the bootstrap endpoint base URL. Use this when your sync
   * server's HTTP API lives on a different host than the WebSocket URL.
   *
   * Must include the `/api` prefix — `BootstrapFetcher` appends
   * `/sync/bootstrap` directly. Example:
   * `'http://api.example.com/api'` → `http://api.example.com/api/sync/bootstrap`.
   *
   * Default: `${url.replace(/^ws/, 'http')}/api`.
   */
  bootstrapBaseUrl?: string;

  /**
   * The account scope. Supply it together with a user or agent id to resolve
   * identity locally without a server round-trip; without it, the client resolves
   * identity from the token through the identity endpoint instead.
   */
  organizationId?: string;
}
