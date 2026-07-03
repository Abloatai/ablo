/**
 * Option types for the `Ablo({...})` factory — the public `AbloOptions` bag
 * and the full internal construction surface (`InternalAbloOptions`).
 *
 * Extracted from `Ablo.ts` so the option types can be referenced without
 * pulling in the factory's runtime graph. This module is type-only — ZERO
 * runtime imports — so importing it can never create a cycle. `Ablo.ts`
 * re-exports everything here, so existing import paths keep resolving.
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

// ── Options ───────────────────────────────────────────────────────────────

/**
 * Async function that resolves an apiKey at request time. Use for
 * credential rotation — rotate from a vault, refresh from session
 * storage, or pull from a Better Auth session. Mirrors Anthropic's
 * `ApiKeySetter` exactly so any rotation pattern that works with
 * `@anthropic-ai/sdk` works here.
 *
 * Re-exported from `./auth` so existing import paths (`@abloatai/ablo`)
 * keep resolving; the canonical definition lives there alongside the
 * resolvers that consume it.
 */
export type { ApiKeySetter } from './auth.js';
import type { ApiKeySetter } from './auth.js';

/**
 * Options for `Ablo({...})`.
 *
 * The only required field is `schema`. The default path is one line:
 *
 * ```ts
 * const ablo = Ablo({ schema, apiKey: process.env.ABLO_API_KEY });
 * ```
 *
 * `apiKey` itself defaults to `process.env.ABLO_API_KEY`, so in most
 * server setups `Ablo({ schema })` is enough. Every other field is
 * optional tuning (timeouts, retries, custom fetch, persistence) —
 * if you're not sure whether you need one, you don't. Reach for them
 * the way you'd reach for the equivalent option on the Stripe / OpenAI
 * / Anthropic clients: rarely, and deliberately.
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
   * API key — **the one auth field most apps set.** Three shapes, one option:
   *
   *  - **A key string** (server): your secret `sk_` — defaults to
   *    `process.env['ABLO_API_KEY']`, so you usually pass nothing. A
   *    long-lived key needs no refresh; the client uses it as-is.
   *
   *  - **An endpoint path/URL** — `apiKey: '/api/ablo-session'` (the route
   *    `ablo init` scaffolds). The SDK owns the whole exchange: it POSTs the
   *    endpoint (same-origin, cookies included), reads the minted short-lived
   *    token, and keeps it fresh — a refresh timer ahead of expiry plus
   *    re-mint on OS-wake and a reactive re-mint when the server reports the
   *    key stale. You never call a refresh method (the Ably `authUrl` /
   *    Liveblocks `authEndpoint` model). Detection is by prefix (`/`,
   *    `http://`, `https://`) — key strings are `sk_`/`ek_`/`rk_`-prefixed so
   *    the shapes can't collide. Long-lived server clients should pass the
   *    ABSOLUTE URL: it enables pre-expiry renewal on windowless hosts too.
   *
   *  - **An async resolver** `() => Promise<string | null>` — the escape
   *    hatch when the exchange needs custom headers, a body, or a non-HTTP
   *    mint (vault rotation, AWS STS, a Better Auth session). Same renewal
   *    machinery as the endpoint form.
   *
   * Endpoint/resolver contract: produce a token; produce `null` when the login
   * itself is gone (terminal → the client signs out / fails `ready()` with
   * `session_expired`); or THROW on a transient failure (→ back off and retry,
   * never sign out). The endpoint form maps HTTP onto this for you: 401/403 →
   * signed out, any other failure → transient.
   */
  apiKey?: string | ApiKeySetter | null | undefined;

  /**
   * Session-mint endpoint — **the browser auth field**, and the named twin of
   * `apiKey`'s endpoint-string shape (Liveblocks `authEndpoint` / Ably
   * `authUrl`). Point it at the route that mints the signed-in user's
   * short-lived token (`ablo init` scaffolds `/api/ablo-session`):
   *
   * ```ts
   * const ablo = Ablo({ schema, authEndpoint: '/api/ablo-session' });
   * ```
   *
   * The SDK owns the whole exchange — POSTs the route (same-origin, cookies
   * included), reads `{ token }`, keeps it fresh ahead of expiry, re-mints
   * when the server reports it stale. 401/403 from the route = signed out;
   * any other failure is retried, never a sign-out. Also accepts an async
   * resolver `() => Promise<string | null>` when the exchange needs custom
   * headers or a body (same contract as the `apiKey` resolver form).
   *
   * Mutually exclusive with `apiKey` — servers hold a key, browsers hold a
   * mint route; passing both is a validation error.
   */
  authEndpoint?: string | ApiKeySetter | null | undefined;

  /**
   * @deprecated The direct connector lets Ablo dial INTO your Postgres and write to
   * it — the operate-their-database posture we are moving off. Ablo is Stripe-shaped:
   * it hosts only the transaction log (the ordered sync_deltas) + coordination, never
   * your data; your rows always live in your own database. Use the signed Data Source
   * endpoint instead — keep `DATABASE_URL` in your app, expose `dataSource(...)`, and
   * let your server own the write while Ablo coordinates the sync stream. To keep the
   * log in your infra too, self-host the engine. See
   * docs/plans/stripe-shaped-storage-posture.md.
   *
   * Still honored at runtime for back-compat. SERVER-ONLY: it carries credentials, so
   * it is never sent from the browser — constructing a client with `databaseUrl` and
   * `dangerouslyAllowBrowser` throws. If you use it, provide a NON-superuser,
   * non-`BYPASSRLS` role; the connector rejects privileged roles that cannot enforce RLS.
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
   * Transport selector. `'websocket'` (default) is the live client —
   * persistent socket, local synced pool, `onChange` subscriptions. `'http'`
   * returns the STATELESS client for server-side actors (agents, workers,
   * serverless): same `ablo.<model>` surface and coordination plane, but each
   * call is one HTTP round-trip, identity rides the Bearer credential, and no
   * socket is ever opened. With `'http'` the return type narrows to
   * `AbloHttpClient<S>`, so stateful-only capabilities (`get`/`getAll`,
   * `onChange`) are compile errors rather than latent runtime gaps.
   *
   * Note: session/credential minting (`sessions.create`) currently runs on the
   * stateful (default) client, not the http client.
   *
   * @default 'websocket'
   */
  transport?: 'websocket' | 'http' | undefined;

  /**
   * Turn Ablo's diagnostic logging on/off. `true` surfaces the `[Ablo]`
   * coordination trace — claims requested / queued / granted / released, agent
   * handovers, connection state — so you can SEE the human+agent coordination
   * you built while debugging. Omitted/`false` keeps the quiet default (only
   * warnings + errors). For a middle ground use {@link logLevel}. Env override:
   * `ABLO_LOG_LEVEL`. Ignored if a custom logger is supplied.
   */
  debug?: boolean | undefined;

  /**
   * Log threshold for the default `[Ablo]` logger (takes precedence over
   * {@link debug}). `'info'` = coordination + connection events without the
   * per-model registration firehose; `'debug'` = everything; `'warn'` (default)
   * = warnings + errors only; `'silent'` = nothing. Env override: `ABLO_LOG_LEVEL`.
   */
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent' | undefined;

  // ── Advanced (you usually don't need these) ─────────────────────────
  // Connection/transport tuning, mirroring the Stripe/OpenAI/Anthropic
  // client option bags. The defaults are tuned for hosted production;
  // override only for self-hosting, tests, proxies, or odd runtimes.

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
   * API key used for authentication.
   *
   * Accepts a static string (`sk_live_...`) or an async function that
   * resolves to one. Defaults to `process.env['ABLO_API_KEY']`.
   *
   * When a function is provided, it's invoked before each request so
   * you can rotate or refresh credentials at runtime. The function
   * must return a non-empty string; otherwise an `AbloAuthenticationError`
   * is thrown. If the function throws, the error is wrapped with the
   * original available as `cause`.
   *
   * Mirrors Anthropic / OpenAI / Stripe SDK shape exactly.
   */
  apiKey?: string | ApiKeySetter | null | undefined;

  /**
   * Session-mint endpoint (string or async resolver) — see
   * {@link AbloOptions.authEndpoint}. Mutually exclusive with `apiKey`.
   */
  authEndpoint?: string | ApiKeySetter | null | undefined;

  /**
   * Bearer auth token. Sent as `Authorization: Bearer <token>` on
   * every request.
   *
   * Use this for self-hosted deployments where your auth layer mints
   * cap tokens directly. Hosted-cloud consumers pass `apiKey` instead;
   * the server handles cap-mint internally.
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
  // Legacy options retained for backwards compat during the Anthropic-
  // shape migration. New consumers should pass only `{schema, apiKey}`
  // and let Ablo resolve account scope, participant identity, and
  // realtime permissions from the key.

  /**
   * @deprecated Server derives participant kind from the apiKey's
   * scope. Pass apiKey only; this option will be removed once the
   * server-internal cap-mint flow lands.
   */
  kind?: 'user' | 'agent' | 'system';

  /**
   * @deprecated Server derives user identity from the apiKey's
   * scope (or from `Ablo-Acting-User` request header for B2B2C).
   * Removed once Phase 3 ships.
   */
  user?: {
    id: string;
    teamIds?: string[];
  };

  /**
   * @deprecated Server derives agent identity from the apiKey's
   * scope. Removed once Phase 3 ships.
   */
  agentId?: string;

  /**
   * @deprecated Cap-mint moves server-internal in Phase 3. Pass
   * `apiKey` only; the server handles capability issuance.
   */
  capabilityToken?: string;

  /** Custom logger (default: console). Supplying one bypasses {@link debug}/{@link logLevel}. */
  logger?: SyncLogger;

  /**
   * Turn Ablo's diagnostic logging on/off. `true` surfaces the `[Ablo]`
   * coordination trace — claims acquired / queued / granted / released, agent
   * handovers, connection state — plus internal lifecycle, so you can SEE the
   * human+agent coordination you built. Omitted/`false` keeps the quiet default
   * (only warnings + errors). For a middle ground use {@link logLevel}.
   * Env override: `ABLO_LOG_LEVEL`. Ignored if a custom {@link logger} is passed.
   */
  debug?: boolean;

  /**
   * Log threshold for the default `[Ablo]` logger (takes precedence over
   * {@link debug}). `'info'` = coordination + connection events without the
   * per-model registration firehose; `'debug'` = everything; `'warn'` (default)
   * = warnings + errors only; `'silent'` = nothing. Env override: `ABLO_LOG_LEVEL`.
   */
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent';

  /** ObjectPool size limit (default: 10000) */
  maxPoolSize?: number;

  /**
   * Local persistence mode. Defaults to `memory` so Ablo behaves like a
   * point solution for shared state instead of silently bolting IndexedDB
   * durability onto every browser consumer.
   *
   * Pass `persistence: 'indexeddb'` only when you want offline queueing
   * and a reload-surviving local cache in a browser.
   */
  persistence?: AbloPersistence;

  /** @deprecated Use `persistence: 'indexeddb'` for durable browser storage. */
  offline?: boolean;

  /**
   * @deprecated Internal/testing escape hatch. Use `persistence` in
   * production code. `true` maps to `memory`; `false` maps to
   * `indexeddb` in browsers.
   */
  inMemory?: boolean;

  /**
   * If true, initialization starts immediately in the background so
   * `sync.reports.findMany()` works after `await sync.ready()`.
   *
   * If false (default), the consumer MUST call `await sync.ready()` before
   * using the engine — any query before that returns empty results.
   *
   * Default: false (explicit is better — prevents silent init failures).
   */
  autoStart?: boolean;

  /**
   * How aggressively this client should pull baseline state at
   * startup.
   *
   *  - `'full'`: pull every delta in the configured sync groups before
   *    `ready()` resolves. Default for `kind: 'user'`.
   *  - `'none'`: open the WS and process live deltas only — no baseline
   *    fetch. Reads round-trip via `model.retrieve()`; subscriptions
   *    populate the pool lazily via covering deltas. Default for
   *    `kind: 'agent'` because agent-worker / routine runners don't
   *    need (or want) a local replica of the org's tenant plane.
   */
  bootstrapMode?: 'full' | 'none';

  // ── Advanced DI overrides ────────────────────────────────────────────────
  //
  // The fields below let an integrator replace the SDK's noop defaults with
  // their own implementations. They exist so first-party apps (like Ablo's
  // web client) can dogfood `Ablo` without losing the structured
  // observability, analytics, and auth-aware mutation executor they already
  // wired up by hand. External consumers can ignore all of these — the
  // built-in defaults work for the documented zero-config call shape.

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
   * Sync groups (entity scopes) this client subscribes to. **Provisional, not
   * deprecated** — pick the right lane: normally the server derives these from
   * the apiKey's scope, but passing them is still REQUIRED today in any config
   * where the key doesn't resolve them (omitting yields a `degenerate
   * syncGroups` warning and a zero-fan-out client). Keep passing it explicitly
   * until the server-derived path ships in Phase 3, at which point it becomes a
   * true no-op and is removed. Build values with `syncGroup(kind, id)` from
   * `@abloatai/ablo/schema`.
   */
  syncGroups?: string[];

  /**
   * Override the bootstrap endpoint base URL. Use this when your sync
   * server's HTTP API lives on a different host than the WebSocket URL.
   *
   * Must include the `/api` prefix — `BootstrapHelper` appends
   * `/sync/bootstrap` directly. Example:
   * `'http://api.example.com/api'` → `http://api.example.com/api/sync/bootstrap`.
   *
   * Default: `${url.replace(/^ws/, 'http')}/api`.
   */
  bootstrapBaseUrl?: string;

  /**
   * Ablo-owned account scope. Required for Branch 3 identity resolution
   * in `identity.ts` — without it the SDK falls through to the
   * `/api/identity` HTTP-derived path (Branch 2).
   */
  organizationId?: string;
}
