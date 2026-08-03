/**
 * The option types for the {@link Ablo} client: the public {@link AbloOptions}
 * bag callers pass, and the fuller monorepo-only {@link InternalAbloOptions}
 * construction surface retained by the deprecated compatibility facade.
 * This module holds only types and has no runtime imports.
 */

import type { Schema, SchemaRecord } from '@abloatai/transaction/schema/schema';
import type {
  RuntimeConfig,
  Logger,
  MutationExecutor,
  ObservabilityProvider,
  Analytics,
  SessionErrorDetector,
  OnlineStatusProvider,
} from '../interfaces/index.js';
import type { AbloPersistence } from '../persistence.js';
import type {
  DurableWriteStore,
  DurableWritesConfig,
} from '@abloatai/transaction/durableWrites';
import type { CommitOutboxScope } from '@abloatai/transaction/transactions/settlement/commitEnvelope';

// ── Options ───────────────────────────────────────────────────────────────

/**
 * An async function that resolves an apiKey at request time. Use it for credential
 * rotation — read from a vault, refresh from session storage, or pull from an
 * existing auth session. The canonical definition lives in `./auth`; it is
 * re-exported here for convenience.
 */
export type { CredentialProvider } from '@abloatai/transaction/auth/apiKey';
import type { CredentialProvider } from '@abloatai/transaction/auth/apiKey';
import type { AbloPlugin } from '../../plugin.js';
import type { ParticipantKind } from '@abloatai/transaction/types/participant';

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
   * The capabilities installed on this client. Each plugin appears once in
   * the list; a duplicate, or a plugin the chosen transport cannot carry,
   * fails while the client is being constructed with an error naming the
   * plugin. Omitted, the client installs the compatibility `humans()` plugin.
   * New code should install `humans()` from `@abloatai/humans` explicitly.
   */
  plugins?: readonly AbloPlugin[];

  /**
   * The API key held by this process. It accepts two shapes:
   *
   *  - **A key string** (server): your secret `sk_` key. Defaults to the
   *    `ABLO_API_KEY` environment variable, so you usually pass nothing. A
   *    long-lived key needs no refresh; the client uses it as-is.
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
   * this for you: only a structured `401 session_expired` means signed out.
   */
  apiKey?: string | CredentialProvider | null | undefined;

  /**
   * Pins this client to one Ablo project. During `ready()` the server resolves
   * the API key's actual project and the client refuses to start when it differs.
   * Defaults to `ABLO_PROJECT_ID`; `ablo dev` writes that value beside the key.
   * This is an assertion, never a routing selector — the key remains authoritative.
   */
  projectId?: string | null | undefined;

  /**
   * Pins this client to one immutable Ablo branch. Defaults to
   * `ABLO_BRANCH_ID`; `ablo dev` writes it beside the branch key. Like
   * `projectId`, this is a startup assertion and never selects a branch.
   */
  branchId?: string | null | undefined;

  /**
   * The session-mint endpoint — the browser-side auth field, and the named
   * endpoint for the route that mints the signed-in user's short-lived token:
   *
   * ```ts
   * const ablo = Ablo({ schema, authEndpoint: '/api/ablo-session' });
   * ```
   *
   * The client owns the whole exchange: it POSTs the route (same-origin, cookies
   * included), validates the canonical auth response contract, keeps it fresh
   * ahead of expiry, and re-mints when the server reports the token stale. Only
   * a structured `401 session_expired` response means signed out. It also
   * accepts an async resolver `() => Promise<string | null>` when the exchange
   * needs custom headers or a body — the same contract as the resolver form of
   * `apiKey`.
   *
   * Mutually exclusive with `apiKey`: a server holds a key, a browser holds a mint
   * route, and passing both is a validation error.
   */
  authEndpoint?: string | CredentialProvider | null | undefined;

  /** Timeout for a session-mint request. @default 10000 */
  authTimeoutMs?: number | undefined;

  /** Explicit opt-in for a cross-origin session-mint endpoint. */
  allowCrossOriginAuthEndpoint?: boolean | undefined;

  /**
   * Local persistence mode. Pass `indexeddb` only when you want offline
   * queueing and a reload-surviving browser cache.
   *
   * @default 'memory'
   */
  persistence?: AbloPersistence;

  /**
   * Makes `create`, `update`, and `delete` survive process restarts and
   * ambiguous network responses. Server-side agents and workers inject a
   * workflow-, SQLite-, or filesystem-backed store; authenticated identity is
   * used to fence replay to the actor that originally made the write.
   *
   * Most clients leave this unset and use Ablo's default in-memory cache.
   * `durableWrites` is independent of that cache: it is the optional outbound
   * write journal for workers that must recover automatically after a crash.
   * Browsers only use IndexedDB when `persistence: 'indexeddb'` is explicitly
   * enabled for offline/reload behavior.
   *
   * @example
   * ```ts
   * Ablo({
   *   schema,
   *   apiKey,
   *   durableWrites: { store, namespace: 'headless-worker' },
   * })
   * ```
   */
  /**
   * Wire message types to surface as collaboration events, e.g.
   * `['document:selection', 'document:cursor']`.
   *
   * These name your application's own concepts, so the SDK ships no default —
   * a schema with no documents should never receive document events. Declare
   * the ones you broadcast.
   */
  collaborationEvents?: readonly string[];
  durableWrites?: DurableWritesConfig;

  /**
   * @deprecated Use `durableWrites: { store, namespace }`.
   * Retained as a compatibility alias through the next major release.
   */
  commitOutbox?: DurableWriteStore;

  /**
   * @deprecated Actor identity is resolved from authentication. Use
   * `durableWrites.namespace` only when shared storage needs separate workflow
   * or deployment lanes.
   *
   * Stable actor/server scope for an injected HTTP `commitOutbox`.
   * Omit it to resolve `organizationId` and `participantId` from the authenticated
   * `/auth/identity` endpoint. Supplying it avoids that one setup request in
   * trusted worker environments; `namespace` distinguishes deployments or
   * workflow lanes that share the same actor identity.
   */
  commitOutboxScope?: CommitOutboxScope;

  /**
   * Turns Ablo's diagnostic logging on or off. `true` surfaces the `[Ablo]`
   * coordination trace — claims requested, queued, granted, and released, agent
   * handovers, and connection state — so you can watch the coordination between
   * agents and people while debugging. Omitting it, or `false`, keeps the quiet
   * default of warnings and errors only. For a middle ground use {@link logLevel}.
   * The `ABLO_LOG_LEVEL` environment variable overrides it, and a custom logger
   * takes precedence.
   */
  debug?: boolean | undefined;

  /**
   * Route Ablo's log lines through your own logger (pino, winston, a test spy)
   * instead of the default console `[Ablo]` logger. Supplying one bypasses
   * {@link debug}/{@link logLevel} — your logger owns the thresholds.
   */
  logger?: Logger;

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
  apiKey?: string | CredentialProvider | null | undefined;

  /** Expected project assertion; see {@link AbloOptions.projectId}. */
  projectId?: string | null | undefined;

  /**
   * Session-mint endpoint (string or async resolver) — see
   * {@link AbloOptions.authEndpoint}. Mutually exclusive with `apiKey`.
   */
  authEndpoint?: string | CredentialProvider | null | undefined;

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
   * Required on every public `Ablo(...)` construction. It produces typed model
   * clients such as `ablo.weatherReports.update(...)`; schema-agnostic routing
   * exists only inside the private HTTP transport.
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
  kind?: ParticipantKind;

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
  logger?: Logger;

  /**
   * Turns Ablo's diagnostic logging on or off. `true` surfaces the `[Ablo]`
   * coordination trace — claims acquired, queued, granted, and released, agent
   * handovers, and connection state — along with internal lifecycle events, so you
   * can watch the coordination between agents and people. Omitting it, or `false`,
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

  /** Internal mirror of {@link AbloOptions.durableWrites}. */
  /** Wire message types to surface as collaboration events. Empty unless declared. */
  collaborationEvents?: readonly string[];
  durableWrites?: DurableWritesConfig;

  /** @deprecated Internal mirror of {@link AbloOptions.commitOutbox}. */
  commitOutbox?: DurableWriteStore;

  /** @deprecated Internal mirror of {@link AbloOptions.commitOutboxScope}. */
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
   *    fetch. Reads round-trip through `get`, and subscriptions fill the local
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
  observability?: ObservabilityProvider;

  /**
   * Custom analytics provider (PostHog, Amplitude, Segment, etc.).
   * Default: a noop implementation that drops all events.
   */
  analytics?: Analytics;

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
   * Partial overrides for the auto-derived `RuntimeConfig`. Merged on
   * top of `deriveConfigFromSchema(schema)`. Use this when you need
   * specific `modelCreatePriority`, `batchableModels`, or
   * `essentialFields` settings that the schema cannot express.
   */
  configOverrides?: Partial<RuntimeConfig>;

  /**
   * The sync groups (entity scopes) this client subscribes to. Normally the server
   * derives these from the apiKey's scope; pass them explicitly when the key does
   * not resolve them, otherwise the client fans out nothing and logs a `degenerate
   * syncGroups` warning. Build values with `syncGroup(kind, id)` from
   * the transaction schema package.
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

  /**
   * Expected immutable branch. Hosted clients compare it with the credential
   * exchange; self-hosted clients use it as their locally selected branch.
   */
  branchId?: string;

  /** Whether the selected self-hosted branch is the project's root branch. */
  branchRoot?: boolean;
}
