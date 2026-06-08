/**
 * Ablo — The one-liner consumer API.
 *
 * Hides all internal wiring (ObjectPool, Database, SyncClient, WebSocket,
 * bootstrap, offline queue, DI adapters) behind a single function call.
 *
 * Usage:
 *   import { Ablo } from '@abloatai/ablo/client';
 *   import { schema } from './schema';
 *
 *   const sync = Ablo({ schema, apiKey: process.env.ABLO_API_KEY });
 *
 *   const reports = sync.reports.list({ where: { status: 'todo' } });
 *   await sync.reports.create({ data: { title: 'Fix bug' } });
 *   await sync.reports.update({
 *     id: reportId,
 *     data: { status: 'ready' },
 *   });
 *   await sync.reports.delete({ id: reportId });
 */

import { z } from 'zod';
import type { Schema, SchemaRecord, InferModel, InferCreate, InferModelNames } from '../schema/schema.js';
import type { ModelDef } from '../schema/model.js';
import type { RelationDef } from '../schema/relation.js';
import type {
  SyncEngineConfig,
  SyncLogger,
  MutationExecutor,
  MutationDispatcher,
  MutationOptions,
  MutationOperation,
  SyncObservabilityProvider,
  SyncAnalytics,
  SessionErrorDetector,
  OnlineStatusProvider,
} from '../interfaces/index.js';
import { AbloClaimedError, AbloError, AbloAuthenticationError, AbloConnectionError, AbloValidationError, translateHttpError, hasWireCode, toAbloError } from '../errors.js';
import { LoadStrategy, PropertyType } from '../types/index.js';
import { initSyncEngine } from '../context.js';
import {
  noopObservability,
  browserOnlineStatus,
  defaultSessionErrorDetector,
  noopAnalytics,
} from '../SyncEngineContext.js';
import { alwaysOnline } from '../adapters/alwaysOnline.js';
import { validateAbloOptions } from './validateAbloOptions.js';
import { ModelRegistry, setActiveRegistry } from '../ModelRegistry.js';
import { ObjectPool, ModelScope } from '../ObjectPool.js';
import type { SyncStoreContract } from '../react/context.js';
import type { SyncWebSocket } from '../sync/SyncWebSocket.js';
import { Database } from '../Database.js';
import { SyncClient } from '../SyncClient.js';
import { BootstrapHelper } from '../sync/BootstrapHelper.js';
import { HydrationCoordinator } from '../sync/HydrationCoordinator.js';
import { type RefreshScheduler, exchangeApiKey } from '../auth/index.js';
import { createAuthCredentialSource } from '../auth/credentialSource.js';
import { createInternalComponents } from './createInternalComponents.js';
import { resolveParticipantIdentity } from './identity.js';
import { Model, modelAsRow } from '../Model.js';
import { BaseSyncedStore, type SyncStatus } from '../BaseSyncedStore.js';
import type { DefaultCollaborationEvents } from '../sync/SyncWebSocket.js';
import { createPresenceStream } from '../sync/createPresenceStream.js';
import { createIntentStream } from '../sync/createIntentStream.js';
import { awaitIntentGrant } from '../sync/awaitIntentGrant.js';
import { createSnapshot } from '../sync/createSnapshot.js';
import { createParticipantManager } from '../sync/participants.js';
import type {
  IntentStream,
  IntentWaitOptions,
  PresenceStream,
  Snapshot,
} from '../types/streams.js';
import type { ParticipantManager } from '../sync/participants.js';
import type { ActiveIntent, Claim, Duration, Intent, TargetRange } from '../types/streams.js';
import {
  createProtocolClient,
  type AbloApi,
  type AbloApiClientOptions,
  type AbloApiIntents,
} from './ApiClient.js';

/**
 * Handle returned by `engine.beginTurn()`. While alive, every commit
 * automatically carries this turn's id on the wire. Call `close(stats?)`
 * when the turn finishes, or `dispose()` to abandon without recording
 * usage. Idempotent.
 */
export interface Turn {
  readonly turnId: string;
  close(stats?: {
    readonly costInputTokens?: number;
    readonly costOutputTokens?: number;
    readonly costComputeMs?: number;
  }): Promise<void>;
  dispose(): void;
  [Symbol.asyncDispose](): Promise<void>;
}

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
import {
  assertBrowserSafety,
  readProcessEnv,
  resolveApiKey,
  resolveApiKeyValue,
  resolveAuthToken,
  resolveBaseURL,
  resolveBootstrapBaseUrl,
  resolveDatabaseUrl,
} from './auth.js';
import { registerDataSource } from './registerDataSource.js';
import {
  shouldUseInMemoryPersistence,
  type AbloPersistence,
} from './persistence.js';

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
   * API key — **the one auth field most apps set.** Server-side this is your
   * secret `sk_` (and it defaults to `process.env['ABLO_API_KEY']`, so you
   * usually pass nothing). A long-lived key needs no refresh; the client uses
   * it as-is.
   *
   * Accepts a static string or an async `() => Promise<string>` resolver if you
   * rotate keys out-of-band (resolved at bootstrap).
   *
   * Browser apps that mint a SHORT-LIVED per-user key (`ek_`) from a login can't
   * ship a secret — those use {@link getToken} (or {@link authEndpoint}) instead,
   * which the client refreshes for you. That's the only case that isn't "just
   * `apiKey`".
   */
  apiKey?: string | ApiKeySetter | null | undefined;

  /**
   * Opt-in for the SHORT-LIVED per-user browser case: an async resolver for a
   * fresh bearer (`ek_`/`rk_`) your backend minted for the signed-in user. The
   * client calls it once before connect and then keeps the key fresh for you —
   * a refresh timer ahead of expiry plus re-mint on OS-wake / network-online /
   * tab-focus, and a reactive re-mint when a probe finds the key stale. You
   * never call a refresh method (Supabase `autoRefreshToken` model).
   *
   * Contract: resolve a token, resolve `null` when the login itself is gone
   * (terminal → sign out), or THROW on a transient failure (→ back off, never
   * sign out). Leave unset for the static-`apiKey` path.
   */
  getToken?: (() => Promise<string | null>) | undefined;

  /**
   * Convenience over {@link getToken}: a URL on YOUR backend that returns
   * `{ token }`. The client POSTs to it (with cookies, so it's authed by the
   * user's session) to mint + refresh the bearer. Ignored when `getToken` is
   * set. Pure sugar — `getToken: () => fetch(url).then(r => r.json()).then(b => b.token)`.
   */
  authEndpoint?: string | undefined;

  /**
   * Direct-URL convenience connector: a connection string to your own Postgres
   * that Ablo can register for a dedicated tenant.
   *
   * This is NOT the default Data Source path. For the Zero-shaped default, keep
   * `DATABASE_URL` in your app, expose `dataSource(...)`, and let your server
   * write the database while Ablo coordinates the sync stream.
   *
   * SERVER-ONLY: this carries credentials, so it is never sent from the browser
   * — constructing a client with `databaseUrl` and `dangerouslyAllowBrowser`
   * throws. If you opt into this connector, provide a NON-superuser,
   * non-`BYPASSRLS` role; the direct connector rejects privileged roles that
   * cannot enforce RLS.
   */
  databaseUrl?: string | null | undefined;

  /**
   * Local persistence mode. Pass `indexeddb` only when you want offline
   * queueing and a reload-surviving browser cache.
   *
   * @default 'volatile'
   */
  persistence?: AbloPersistence;

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

  /**
   * Short-lived-bearer resolver for the per-user browser path (mirrors the
   * public {@link AbloOptions.getToken}). The client mints the first token
   * before connect and refreshes it (timer + wake/online/focus) — see
   * {@link resolveCredentialResolver}.
   */
  getToken?: (() => Promise<string | null>) | undefined;

  /**
   * Backend URL returning `{ token }`; sugar over {@link getToken}. Mirrors the
   * public {@link AbloOptions.authEndpoint}.
   */
  authEndpoint?: string | undefined;

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

  /** Custom logger (default: console) */
  logger?: SyncLogger;

  /** ObjectPool size limit (default: 10000) */
  maxPoolSize?: number;

  /**
   * Local persistence mode. Defaults to `volatile` so Ablo behaves like a
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
   * production code. `true` maps to `volatile`; `false` maps to
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
   * Replace the built-in `MutationDispatcher` (used by the offline queue
   * to replay mutations on reconnect). If you override `mutationExecutor`
   * you almost always want to override this too so the two paths share
   * the same auth/retry behavior.
   *
   * Default: a thin dispatcher that routes to the built-in executor.
   */
  mutationDispatcher?: MutationDispatcher;

  /**
   * Partial overrides for the auto-derived `SyncEngineConfig`. Merged on
   * top of `deriveConfigFromSchema(schema)`. Use this when you need
   * specific `modelCreatePriority`, `batchableModels`, or
   * `essentialFields` settings that the schema cannot express.
   */
  configOverrides?: Partial<SyncEngineConfig>;

  /**
   * @deprecated Server derives sync groups from the apiKey's scope.
   * Required today as a runtime holdover; removed once Phase 3 ships.
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

// ── Model proxy types ─────────────────────────────────────────────────────

/**
 * Operations available on each model in the sync engine.
 *
 * Naming aligns with Stripe / OpenAI / Anthropic conventions:
 *   `retrieve({ id })` — async single-row server read
 *   `list({ where })` — async collection server read
 *   `get(id)` / `getAll(...)` / `getCount(...)` — local graph snapshots
 *   `create({ data })` / `update({ id, data })` / `delete({ id })` — writes
 *   `claim({ id })` — durable claim handle for coordinated writes
 */
// `ModelOperations` and the model option types live in
// `./createModelProxy` alongside the factory that builds them — re-exported
// here so the existing import path (`@abloatai/ablo`) keeps resolving.
// See `createModelProxy.ts` for full JSDoc on each method.
export type {
  ModelCountOptions,
  ModelListOptions,
  ModelListScope,
  ModelLoadOptions,
  ModelRetrieveParams,
  ModelCreateParams,
  ModelUpdateParams,
  ModelDeleteParams,
  ClaimOptions,
  ClaimParams,
  ClaimLookupParams,
  ClaimReorderParams,
  ClaimHandle,
  ModelOperations,
} from './createModelProxy.js';
import type {
  ModelOperations,
  ClaimOptions,
  ClaimParams,
  ClaimLookupParams,
  ClaimReorderParams,
  ClaimHandle,
  ModelLoadOptions,
} from './createModelProxy.js';
import { createModelProxy } from './createModelProxy.js';

export type ModelOperationAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'archive'
  | 'unarchive';

export type CommitWait = 'queued' | 'confirmed';

export interface ModelTarget {
  /** The model name — matches `ablo.<model>` and the schema's `model()`. */
  readonly model: string;
  readonly id: string;
  readonly path?: string;
  readonly range?: TargetRange;
  readonly field?: string;
  readonly meta?: Record<string, unknown>;
}

export interface ModelClaim {
  readonly id: string;
  readonly actor: string;
  readonly participantKind: ActiveIntent['participantKind'];
  readonly action: string;
  readonly description?: string;
  readonly field?: string;
  readonly status?: 'active' | 'queued';
  readonly position?: number;
  readonly expiresAt: string;
  readonly target: ModelTarget;
}

export interface ModelRead<T = Record<string, unknown>> {
  readonly data: T;
  readonly stamp: number;
  readonly claims: readonly ModelClaim[];
}

export type IfClaimedPolicy = 'return' | 'wait' | 'fail';

export interface ClaimedOptions {
  /**
   * What to do when another participant has claimed the target. `return`
   * includes active claim metadata in the response, `wait` resolves after the
   * claim clears, and `fail` throws `AbloClaimedError`.
   */
  readonly ifClaimed?: IfClaimedPolicy;
  /** Max time to wait for peer claims to clear, in milliseconds. */
  readonly claimedTimeout?: number;
  /** HTTP API polling interval while waiting. WebSocket clients ignore it. */
  readonly claimedPollInterval?: number;
  /**
   * Backpressure for `ifClaimed: 'wait'`: reject instead of waiting if the
   * row's FIFO line is already `>= maxQueueDepth` deep.
   */
  readonly maxQueueDepth?: number;
}

export type { IntentWaitOptions } from '../types/streams.js';

export interface ModelReadOptions extends ClaimedOptions {}

export interface IntentCreateOptions {
  readonly target: ModelTarget;
  readonly action: string;
  readonly ttl?: Duration;
  /**
   * Join the server's fair FIFO queue when the target is already claimed,
   * rather than failing immediately. `create` then resolves only once the
   * lease is actually ours (the server pushes `intent_acquired` if the target
   * was free, or `intent_granted` when we reach the head of the line). Without
   * this, a contended claim throws. Used by `ablo.<model>.claim` so writers
   * serialize instead of racing.
   */
  readonly queue?: boolean;
  /** Cap on how long to wait for a queued grant before rejecting. */
  readonly waitTimeoutMs?: number;
  /**
   * Backpressure: reject with `AbloClaimedError('queue_too_deep')` instead of
   * waiting if the queue is already `>= maxQueueDepth` when we join.
   */
  readonly maxQueueDepth?: number;
}

export interface IntentHandle extends AsyncDisposable {
  readonly id: string;
  release(): Promise<void>;
  revoke(): void;
}

export interface CommitOperationInput {
  readonly action: ModelOperationAction;
  /** The model name — matches `ablo.<model>` and the schema's `model()`. */
  readonly model?: string;
  readonly target?: ModelTarget;
  readonly id?: string | null;
  readonly data?: Record<string, unknown> | null;
  readonly transactionId?: string | null;
  readonly readAt?: number | null;
  readonly onStale?: 'reject' | 'force' | 'flag' | 'merge' | null;
}

export interface CommitCreateOptions {
  readonly intent?: string | { readonly id: string } | null;
  readonly idempotencyKey?: string | null;
  readonly readAt?: number | null;
  readonly onStale?: 'reject' | 'force' | 'flag' | 'merge' | null;
  readonly operation?: CommitOperationInput;
  readonly operations?: readonly CommitOperationInput[];
  readonly wait?: CommitWait;
}

export interface CommitReceipt {
  readonly id: string;
  readonly status: CommitWait;
  readonly lastSyncId?: number;
}

export interface CommitResource {
  create(options: CommitCreateOptions): Promise<CommitReceipt>;
}

export interface IntentResource extends IntentStream {
  create(options: IntentCreateOptions): Promise<IntentHandle>;
  list(target?: Partial<ModelTarget>): readonly ModelClaim[];
  waitFor(target: Partial<ModelTarget>, options?: IntentWaitOptions): Promise<void>;
}

export interface ModelMutationOptions extends ClaimedOptions {
  readonly intent?: string | { readonly id: string } | null;
  readonly idempotencyKey?: string | null;
  readonly readAt?: number | null;
  readonly onStale?: 'reject' | 'force' | 'flag' | 'merge' | null;
  readonly wait?: CommitWait;
  readonly claim?: ClaimHandle | ClaimOptions | null;
}

/**
 * The HTTP/stateless claim surface. Normal tools usually put `claim` directly
 * on the write (`update({ id, data, claim })`) and let the SDK release it. Use
 * this namespace for multi-step handles and coordination screens.
 */
export interface HttpClaimApi<T> {
  /** Take a manual claim handle for multi-step work. Release it when done. */
  (params: ClaimParams<T>): Promise<ClaimHandle<T>>;
  /** Release a manual claim you hold. */
  release(params: ClaimLookupParams<T> | ClaimHandle<T>): Promise<void>;
  /**
   * Current holder of the lease on a row, or `null` when free. For UI badges,
   * preflight checks, and operators.
   */
  state(params: ClaimLookupParams<T>): Promise<Intent | null>;
  /**
   * FIFO wait line behind the holder. Advanced: useful for operator UIs and
   * schedulers.
   */
  queue(params: ClaimLookupParams<T>): Promise<{ readonly object: 'list'; readonly data: readonly Intent[] }>;
  /**
   * Re-rank the wait line. Advanced and permission-gated.
   */
  reorder(params: ClaimReorderParams<T>): Promise<void>;
}

export interface ModelClient<T = Record<string, unknown>> {
  retrieve(params: ModelReadOptions & { readonly id: string }): Promise<ModelRead<T>>;
  /**
   * Collection read over HTTP (server round-trip). Equality `where`, `orderBy`,
   * `limit`. Present on the stateless protocol client; the store-backed
   * `.model(name)` accessor omits it (use the typed `ablo.<model>.list` there).
   */
  list?(options?: ModelLoadOptions<T>): Promise<T[]>;
  create(params: ModelMutationOptions & { readonly data: Record<string, unknown>; readonly id?: string | null }): Promise<CommitReceipt>;
  update(params: ModelMutationOptions & { readonly id: string; readonly data: Record<string, unknown> }): Promise<CommitReceipt>;
  delete(params: ModelMutationOptions & { readonly id: string }): Promise<CommitReceipt>;
  /**
   * Durable lease + FIFO wait-line over HTTP — coordination without a socket.
   * Present on the stateless protocol client (`Ablo({ schema: null })` /
   * `createAbloHttpClient`); the store-backed `.model(name)` accessor omits it
   * (the typed `ablo.<model>.claim` proxy is the full reactive namespace there).
   */
  claim?: HttpClaimApi<T>;
}

/** A single data operation a scoped **agent** session may perform on a model. */
export type SessionOperation = 'read' | 'create' | 'update' | 'delete';

/** Mint params for an **end-user** session — full data authority within the
 *  org (the Stripe `ephemeralKeys.create` / Supabase session shape). Mints an
 *  `ek_` token. `user.id` is your end user's external IdP id (becomes the
 *  session's `participantId`); Ablo does not model your users, so it's an
 *  honest string at the trust boundary. */
export interface CreateUserSessionParams {
  /** Your end user. `id` becomes the token's `participantId`. */
  user: { id: string };
  /** Sync groups this session may subscribe to. Omit to inherit the key's scope. */
  syncGroups?: readonly string[];
  /** Token lifetime in seconds. Defaults to 900 (15m, the Stripe ephemeral default). */
  ttlSeconds?: number;
  /** Opaque identity blob echoed back to the client as `ablo.user`. */
  userMeta?: Record<string, unknown>;
  agent?: never;
  can?: never;
}

/** Mint params for a scoped **agent** session — mints a restricted `rk_` token
 *  gated to exactly the operations named in `can`. `can` is typed off your
 *  schema (no magic `'task.update'` strings): `{ Task: ['update'], Deck: ['read'] }`
 *  — the SDK serializes each entry to the wire allowlist (`task.update`). */
export interface CreateAgentSessionParams<S extends SchemaRecord> {
  /** Your agent. `id` becomes the token's `participantId`. */
  agent: { id: string };
  /** Per-model operation allowlist, typed against the schema's model names. */
  can: { [M in keyof S & string]?: readonly SessionOperation[] };
  /** Sync groups this session may subscribe to. Omit to inherit the key's scope. */
  syncGroups?: readonly string[];
  /** Token lifetime in seconds. Defaults to 900 (15m, the Stripe ephemeral default). */
  ttlSeconds?: number;
  /** Opaque identity blob echoed back to the client as `ablo.agent`. */
  userMeta?: Record<string, unknown>;
  user?: never;
}

/** Params for {@link Ablo.sessions}.create — a discriminated union: pass
 *  `{ user }` for a full-authority end-user session (`ek_`) or `{ agent, can }`
 *  for a scoped agent session (`rk_`). */
export type CreateSessionParams<S extends SchemaRecord> =
  | CreateUserSessionParams
  | CreateAgentSessionParams<S>;

/** A minted end-user session token — the Stripe ephemeral-key / Supabase
 *  session resource. `token` is the secret the browser presents as its bearer. */
export interface AbloSession {
  object: 'session';
  /** Stable id of the minted credential (for revocation). */
  id: string;
  /** The short-lived `rk_` session token. Hand this to the user's browser. */
  token: string;
  /** ISO-8601 expiry. */
  expiresAt: string;
  organizationId: string;
  scope: {
    organizationId: string;
    syncGroups: readonly string[];
    operations: readonly string[];
    participantKind: 'user' | 'agent' | 'system';
    participantId: string;
  };
  userMeta: Record<string, unknown>;
}

/** The typed sync engine client — one property per model in the schema */
export type Ablo<S extends SchemaRecord> = {
  readonly [K in keyof S & string]: ModelOperations<
    InferModel<Schema<S>, K>,
    InferCreate<Schema<S>, K>
  >;
} & {
  /**
   * Wait for the sync engine to finish its initial bootstrap.
   * Resolves once entity data is loaded and the WebSocket is connected.
   *
   * ```ts
   * const sync = Ablo({ schema, user });
   * await sync.ready();
   * const reports = sync.reports.findMany(); // data is available
   * ```
   *
   * If bootstrap fails, this rejects with the underlying error (unreachable
   * server, invalid API key, 500 from bootstrap endpoint, etc.).
   *
   * Idempotent — calling it multiple times returns the same promise.
   */
  ready(): Promise<void>;

  /**
   * Wait for all pending mutations to be confirmed by the server.
   *
   * Sync engine mutations (`create`/`update`/`delete`) are optimistic and
   * resolve immediately. Use this when you need to know the server has
   * acknowledged everything before continuing — for example, before
   * navigating away, before triggering a server-side workflow, or in tests.
   *
   * Resolves when `syncStatus.pendingChanges` reaches 0. If the engine is
   * offline, this waits until reconnect + flush completes.
   *
   * ```ts
   * await sync.reports.create({ data: { title: 'A' } });
   * await sync.reports.create({ data: { title: 'B' } });
   * await sync.waitForFlush(); // server has both reports
   * ```
   *
   * @param timeoutMs - Optional timeout. Default: no timeout (wait forever).
   *                    Throws `Error('Flush timeout')` if reached with pending changes.
   */
  waitForFlush(timeoutMs?: number): Promise<void>;

  /** Disconnect and clean up */
  dispose(): Promise<void>;

  /**
   * Replace the bearer auth token used for the WebSocket upgrade and HTTP
   * requests, WITHOUT tearing down the engine. Use to push a refreshed
   * short-lived access key (the Stripe-style `ek_`/`rk_`) before it expires —
   * `<AbloProvider>`'s `getToken` refresh loop calls this. Reuses the same
   * rotation path as the internal capability-token refresh; safe to call before
   * `ready()`. Also nudges a parked connection to re-probe with the new token.
   */
  setAuthToken(token: string): void;

  /**
   * Resolve the active bearer credential this engine authenticates with — the
   * live `ek_`/`rk_` the WebSocket and HTTP transports currently carry (kept
   * fresh by the `getToken` refresh loop), falling back to a configured API
   * key. Returns `null` when no credential is set yet. Use it to authenticate
   * a side-band request to the same server with the very token this client
   * already holds — no extra mint round-trip.
   */
  getAuthToken(): Promise<string | null>;

  /**
   * Register a re-mint hook for the short-lived access key. The connection
   * layer calls it WHEN it finds the key stale (a `credential_stale` probe) or
   * on an external nudge; the hook mints a fresh `ek_`/`rk_` from the still-valid
   * login. Mirrors the `getToken` contract: resolve a token, resolve `null` when
   * the login itself is gone (→ sign out), or THROW on a transient failure (→
   * back off, never sign out). `<AbloProvider>` wires this from its
   * `getToken`/`authEndpoint`. Safe to call before `ready()`.
   */
  setCredentialRefresher(refresher: (() => Promise<string | null>) | null): void;

  /**
   * Ask the connection layer to re-probe and reconnect now, using the current
   * credential. Idempotent and safe in any state (a no-op while connected).
   * Call after an OS-wake signal (Electron `powerMonitor` 'resume') so a
   * connection parked since sleep recovers immediately instead of waiting for
   * the watchdog.
   */
  nudgeReconnect(): void;

  /**
   * Mint a short-lived, scoped **session token** for one end user — the
   * Stripe `ephemeralKeys.create` / Supabase session shape. Call this on YOUR
   * BACKEND (where the `sk_` secret key lives), then hand the returned
   * `token` to that user's browser (typically via an authEndpoint the client
   * fetches). The browser presents it as the bearer; the sync-server verifies
   * the scoped `rk_` token via `apiKeyProvider`.
   *
   * The browser must NEVER see the `sk_` key — only the per-user session token.
   *
   * Pass `{ user: { id } }` for a full-authority end-user session (mints `ek_`),
   * or `{ agent: { id }, can: { Task: ['update'] } }` for a scoped agent
   * session (mints `rk_`); `can` is typed against your schema's model names.
   */
  sessions: {
    create(params: CreateSessionParams<S>): Promise<AbloSession>;
  };

  /**
   * Destroy every IndexedDB database owned by this engine. Disconnects
   * the WebSocket, releases timers, and deletes all `ablo_*` / `ablo-*`
   * databases. Use on session expiry or explicit logout. Best-effort.
   */
  purge(): Promise<void>;

  /**
   * Subscribe to session-error events (server rejected the session).
   * Returns an unsubscribe function. Multiple subscribers supported.
   * Typically called by `<AbloProvider>`, which calls `purge()` on fire
   * and forwards to the consumer's `onSessionExpired` callback.
   */
  onSessionError(listener: (error: Error) => void): () => void;

  /**
   * Subscribe to mutation failures with the full payload (transaction,
   * error, permanent flag). Use this for user-visible failure surfaces —
   * toasts keyed by `AbloError.type`, route-level "this entity reverted"
   * boundaries, telemetry. Fires for both permanent rejections and
   * `max_retries_exhausted` rollbacks.
   *
   * Distinct from `onSessionError` (server killed the session, requires
   * re-auth) and from the `tx.isPersisted` per-call promise (call-site
   * await, single transaction). This is the app-wide fan-in.
   */
  onMutationFailure(
    listener: (payload: {
      transaction: import('../transactions/TransactionQueue.js').Transaction;
      error: Error;
      permanent?: boolean;
    }) => void,
  ): () => void;

  /**
   * Wait for the most-recent in-flight transaction for (modelName, modelId)
   * to be confirmed by the server. Rejects with the same error that the
   * queue's `transaction:failed` event would carry if the mutation is
   * permanently rolled back. Resolves immediately when no transaction is
   * in flight (already-confirmed or never-staged).
   *
   * Matches the queue's `'confirmed'` status vocabulary (see also
   * `commits.create({wait:'confirmed'})`). Use this for the routing-
   * grace-window pattern: stage a write, then
   * `Promise.race([ablo.waitForConfirmation(...), gracePromise])` before
   * navigating to a route whose URL depends on the optimistic id.
   */
  waitForConfirmation(modelName: string, modelId: string): Promise<void>;

  /**
   * Reactive sync status — a MobX observable.
   *
   * Single source of truth for "what's the sync engine doing?" Contains:
   * - `state`: `'idle' | 'syncing' | 'error' | 'offline' | 'reconnecting'`
   * - `progress`: 0-100 for bootstrap progress
   * - `error?`: Error object when `state === 'error'`
   * - `pendingChanges`: Number of unconfirmed mutations in the queue
   * - `lastSyncAt?`: Timestamp of the last successful delta processing
   * - `offlineSince?`: When the connection dropped
   * - `isSessionError`: True when the error requires re-authentication
   *
   * React components using `observer()` re-render automatically when
   * any field changes — no manual subscription or polling needed.
   *
   * ```tsx
   * import { observer } from 'mobx-react-lite';
   *
   * const SyncIndicator = observer(() => {
   *   if (sync.syncStatus.state === 'syncing') return <Spinner />;
   *   if (sync.syncStatus.state === 'error') return <Error msg={sync.syncStatus.error} />;
   *   if (sync.syncStatus.state === 'offline') return <OfflineBadge />;
   *   return null;
   * });
   * ```
   */
  readonly syncStatus: SyncStatus;

  /** The underlying schema */
  readonly schema: Schema<S>;

  /**
   * Real-time presence livestream — who else is connected on this
   * engine's sync groups, what they're doing, and a write surface for
   * announcing this user's own activity. Rides the engine's existing
   * WebSocket; opening a participant for presence does NOT open a
   * second socket. See `PresenceStream` in `types/streams.ts`.
   *
   * Stable reference for the engine's lifetime — the underlying
   * connection is rotated on `dispose()` but this object is the same.
   */
  readonly presence: PresenceStream;

  /**
   * Cooperative-mutex layer over presence — announce "I'm about to do
   * X on Y" so peers can yield before colliding. Server enforces the
   * mutex; rejected announcements surface via `intents.onRejected(...)`.
   * Same socket as entity sync, no second connection.
   */
  readonly intents: IntentResource;

  /**
   * Canonical low-level mutation API. Every untyped model write compiles
   * down to `commits.create(...)`.
   */
  readonly commits: CommitResource;

  /**
   * Canonical untyped model API. This is the portable API shape that maps
   * cleanly to HTTP/Python/Ruby/Go clients. Typed `ablo.<model>` properties
   * are schema-powered sugar over the same model write/read path.
   */
  model<T = Record<string, unknown>>(name: string): ModelClient<T>;

  /**
   * Canonical multiplayer participant surface. Joins a structured app
   * target, derives the transport scope internally, opens a scoped
   * claim on the existing WebSocket, and returns target-bound presence
   * + intent helpers.
   *
   * ```ts
   * const participant = await ablo.participants.join({
   *   type: 'File',
   *   id: 'src/foo.ts',
   *   path: 'src/foo.ts',
   *   range: { startLine: 10, endLine: 40 },
   * });
   * participant.presence.editing();
   * const claim = participant.intents.claim('rewrite imports');
   * ```
   */
  readonly participants: ParticipantManager;

  /**
   * Capture a context-staleness watermark over a set of entities.
   * Returns a flat snapshot with `stamp` (thread into writes as
   * `readAt`), `signal` (aborts on any captured-entity delta), and
   * `onChange` (callback form). Reads from the engine's ObjectPool;
   * subscription is on the engine's existing transport.
   *
   * Use before an LLM call to prevent the model from completing
   * against now-stale data:
   * ```ts
   * const snap = engine.snapshot({ slides: deck.slideIds });
   * await streamText({ messages, signal: snap.signal });
   * ```
   */
  snapshot<ModelName extends keyof S & string>(
    entities: { readonly [M in ModelName]: string | readonly string[] },
  ): Snapshot<Schema<S>, ModelName>;

  /**
   * Open a turn — every commit issued while the returned handle is
   * alive carries `caused_by_task_id` on the wire so the server
   * stamps it onto each delta. Powers `agent_tasks` audit trails.
   * Server: `POST /api/agent/turn` with the capability bearer.
   */
  beginTurn(options: {
    readonly prompt: string;
    readonly parentTaskId?: string;
    readonly surface?: string;
    readonly metadata?: Record<string, unknown>;
  }): Promise<Turn>;

  // ── Internal accessors for framework integration ─────────────────

  /**
   * The internal BaseSyncedStore. Implements SyncStoreContract — pass to
   * SyncContext.Provider so the SDK's useModel/useModels/useMutations hooks
   * can access it. Also satisfies useSyncStore() consumers during migration.
   */
  readonly _store: SyncStoreContract;

  /** The ObjectPool — for demand loaders and direct pool operations. */
  readonly _pool: ObjectPool;

  /**
   * The SyncWebSocket handle — for collaboration events (slide selection,
   * cursor broadcast). Null until the engine connects.
   */
  readonly _ws: SyncWebSocket | null;
};

// ── Config derivation from schema ─────────────────────────────────────────

/**
 * Compute a create-priority map from schema `belongsTo` relations using
 * Tarjan's strongly-connected-components algorithm.
 *
 * The FK graph has an edge `child → parent` for every `belongsTo`. Tarjan
 * runs a single linear DFS that simultaneously (a) detects cycles by
 * grouping mutually-reachable nodes into SCCs and (b) emits those SCCs
 * in reverse topological order of the condensation graph. In this edge
 * convention a "sink" SCC has no outgoing edges — i.e. no parents — so
 * it is an *FK root* (`organizations`, `themes`, etc.). Tarjan emits
 * roots first and leaves last, exactly the order in which rows must be
 * inserted to satisfy FK constraints.
 *
 * Priorities are assigned by emit order: SCC #0 → 10, SCC #1 → 20, …
 * Members of the same SCC share a priority, so insertion order wins the
 * tiebreak inside a cycle (this matters for cyclic schemas like
 * `slideDecks ↔ layouts`, where one direction is the user's chosen
 * "soft" edge — only the consumer's mutator sequence knows which one).
 *
 * This algorithm is iteration-order-independent: starting the DFS from
 * any node yields the same SCC partitioning, and SCCs always come out
 * in valid topological order. The previous DFS-with-memoization
 * heuristic broke under cycles by treating the back-edge as depth 0,
 * which made priorities depend on which node the walk happened to
 * enter the cycle at.
 *
 * Schema authors can mark one side of a cycle with
 * `belongsTo(target, fk, { defer: true })`. Those edges are excluded
 * from the dependency graph entirely, which deterministically breaks
 * the cycle and turns the SCC into a chain — the marked child gets a
 * strictly higher priority than its parent instead of being tied with
 * it. Pair with a Postgres `DEFERRABLE INITIALLY DEFERRED` constraint
 * if you want the database side of the cycle to also relax. See
 * {@link BelongsToOptions.defer}.
 *
 * The returned map is keyed by {@link ModelDef.typename} (falling back
 * to the schema key), because that is what `Model.getModelName()`
 * returns at transaction time — keying by schema key would silently
 * miss the lookup and every model would fall through to
 * `defaultCreatePriority`.
 *
 * Reference: Tarjan, R. (1972), "Depth-first search and linear graph
 * algorithms." Linear in V + E.
 */
export function computeFKDepthPriority(schema: Schema): ReadonlyMap<string, number> {
  // schemaKey → typename (wire name used at transaction time)
  const keyToTypename = new Map<string, string>();
  for (const [key, def] of Object.entries(schema.models)) {
    keyToTypename.set(key, def.typename ?? key);
  }

  // Adjacency: schemaKey → parent schema keys pulled from `belongsTo`.
  // Parents not in the schema (e.g. external types) are dropped so the
  // graph stays closed. Edges marked `{ defer: true }` are also
  // dropped — the schema author has declared this side of a cycle to
  // be the "soft" one (insert with null FK, patch later), so the
  // dependency-graph walker treats it as if the edge weren't there.
  // That breaks the cycle deterministically and lets the other side
  // become a strict topological predecessor.
  const parentsOf = new Map<string, readonly string[]>();
  for (const [key, def] of Object.entries(schema.models)) {
    const out: string[] = [];
    for (const rel of Object.values(def.relations) as Array<RelationDef & { options?: { defer?: boolean } }>) {
      if (rel.type !== 'belongsTo') continue;
      if (!keyToTypename.has(rel.target)) continue;
      if (rel.options?.defer === true) continue;
      out.push(rel.target);
    }
    parentsOf.set(key, out);
  }

  // Tarjan SCC bookkeeping
  const dfsIndex = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let counter = 0;

  function strongconnect(v: string): void {
    dfsIndex.set(v, counter);
    lowlink.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);

    for (const w of parentsOf.get(v) ?? []) {
      if (!dfsIndex.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        // Back-edge into the active DFS path — w is in the same SCC as v.
        lowlink.set(v, Math.min(lowlink.get(v)!, dfsIndex.get(w)!));
      }
    }

    // v is the root of an SCC: pop everything down to v inclusive.
    if (lowlink.get(v) === dfsIndex.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      sccs.push(component);
    }
  }

  for (const key of keyToTypename.keys()) {
    if (!dfsIndex.has(key)) strongconnect(key);
  }

  // Tarjan emits SCCs in reverse topological order of the condensation.
  // In our edge convention (child→parent), reverse-topo of the
  // condensation means root-SCCs (no outgoing edges = no parents)
  // first, leaf-SCCs (deepest descendants) last. We could just use
  // emit-order as the priority — but that gives independent sibling
  // SCCs different priorities, which is semantically wrong: siblings
  // don't depend on each other and shouldn't be ordered relative to
  // each other.
  //
  // Instead, do one more pass to compute *longest-path depth* on the
  // condensation DAG: depth(SCC) = max(depth(parent SCC)) + 1, or 0
  // for SCCs with no in-schema parents. SCCs at the same depth get
  // the same priority — siblings stay tied, insertion order in the
  // queue breaks the tie. Priority = (depth + 1) * 10.
  //
  // We can compute this in a single pass over the SCCs because
  // Tarjan's emit-order *is* a valid topological order of the
  // condensation: when we process sccs[i], every parent SCC has
  // already been assigned a depth.
  const nodeToSccIdx = new Map<string, number>();
  sccs.forEach((scc, i) => {
    for (const node of scc) nodeToSccIdx.set(node, i);
  });

  const sccDepth = new Map<number, number>();
  sccs.forEach((scc, i) => {
    let maxParentDepth = -1;
    for (const node of scc) {
      for (const parent of parentsOf.get(node) ?? []) {
        const parentSccIdx = nodeToSccIdx.get(parent);
        if (parentSccIdx === undefined) continue;
        if (parentSccIdx === i) continue; // intra-SCC edge — not a dep
        const d = sccDepth.get(parentSccIdx);
        if (d !== undefined && d > maxParentDepth) maxParentDepth = d;
      }
    }
    sccDepth.set(i, maxParentDepth + 1);
  });

  const out = new Map<string, number>();
  sccs.forEach((scc, i) => {
    const priority = (sccDepth.get(i)! + 1) * 10;
    for (const key of scc) {
      out.set(keyToTypename.get(key)!, priority);
    }
  });
  return out;
}

function deriveConfigFromSchema(schema: Schema): SyncEngineConfig {
  // Commit payload projection is done directly inside `TransactionQueue`
  // — see `projectCommitPayload` there. Each model's field metadata
  // rides on `ModelRegistry` (populated by `registerModelsFromSchema`),
  // so there's no config-layer shim: the queue asks the registry for
  // the declared fields and serializes accordingly.
  return {
    modelCreatePriority: computeFKDepthPriority(schema),
    defaultCreatePriority: 40,
    defaultNonCreatePriority: 50,
    essentialFields: {},
    classNameFallbackMap: {},
  };
}

// ── Auto model registration from schema ───────────────────────────────────

function registerModelsFromSchema(schema: Schema, registry: ModelRegistry): void {
  registry.startBatch();

  for (const [schemaKey, modelDef] of Object.entries(schema.models)) {
    // Use typename as the model name — this is the wire-format name that
    // the server sends in bootstrap responses and sync deltas. The pool's
    // typeIndex, the ModelRegistry, and getModelName() all use this name.
    // Schema key (camelCase plural) is only for the consumer-facing proxy API.
    const modelName = modelDef.typename ?? schemaKey;

    // Collect JSON sub-property fields to generate ${field}Json getters
    const jsonSubFields: Array<{ fieldName: string; subSchema: z.ZodObject<z.ZodRawShape> }> = [];

    for (const [fieldName, zodType] of Object.entries(modelDef.shape)) {
      const inner = unwrapZodType(zodType as z.ZodType);
      if (isZodObject(inner)) {
        jsonSubFields.push({ fieldName, subSchema: inner });
      }
    }

    // Create a dynamic Model subclass with JSON sub-property getters
    const isLazy = modelDef.lazyObservable === true;
    const fieldNames = Object.keys(modelDef.shape);
    const computed = (modelDef as { computed?: Record<string, (self: Record<string, unknown>) => unknown> }).computed;
    const DynamicModel = createDynamicModelClass(modelName, jsonSubFields, fieldNames, computed, isLazy);

    // Respect the schema's load strategy so lazy models skip IDB hydration + bootstrap
    const loadStrategy = modelDef.load === 'lazy' || modelDef.load === 'manual'
      ? LoadStrategy.lazy
      : LoadStrategy.instant;

    registry.registerModel(modelName, DynamicModel, {
      loadStrategy,
      fields: modelDef.fields,
      autoFill: modelDef.autoFill,
      requiredFields: modelDef.requiredFields,
    });

    // Collect the set of fields that should get an IDB secondary index.
    //
    // Matches Linear's opt-in model (see wzhudev/reverse-linear-sync-engine):
    // `@Reference(..., { indexed: true })`. Only `belongsTo` relations that
    // explicitly set `{ index: true }` in their options get an IDB secondary
    // index. Every other FK (and every scalar) is resolved via in-memory
    // ObjectPool scans, which are fast enough at org-scope sizes (~10k rows)
    // and reactive via MobX.
    //
    // Auto-indexing every belongsTo was wrong: it bloated write amplification
    // for the vast majority of FKs that are never queried by fk. Indexing
    // every scalar (like the legacy Go backend did) is even worse.
    const indexedFields = new Set<string>();
    for (const relDef of Object.values(modelDef.relations)) {
      if (relDef.type === 'belongsTo' && relDef.foreignKey && relDef.options?.index === true) {
        indexedFields.add(relDef.foreignKey);
      }
    }

    // Register fields as properties (from Zod shape).
    for (const [fieldName, rawZodType] of Object.entries(modelDef.shape)) {
      const zodType = rawZodType as z.ZodType;
      const isOptional = zodType.isOptional?.() ?? false;
      // A field is indexed if it's the FK of a `belongsTo({ index: true })`
      // relation. Legacy `description === 'indexed'` still works for
      // consumers using `field.*().indexed()`.
      const isIndexed =
        indexedFields.has(fieldName) || zodType.description === 'indexed';
      // JSON-typed fields (per the schema's wire-type tag) are opaque
      // blobs from MobX's perspective — chart specs, ProseMirror docs,
      // style maps. Deep observability on them recursively walks every
      // nested property and creates an atom for each leaf, producing a
      // microtask storm on every commit/streaming update. `ref` tracks
      // only reassignment, which is how blob consumers actually use them.
      const wireType = modelDef.fields?.[fieldName]?.type;
      const observability: 'deep' | 'shallow' | 'ref' | undefined =
        wireType === 'json' ? 'ref' : undefined;
      registry.registerProperty(modelName, fieldName, {
        type: PropertyType.property,
        indexed: isIndexed,
        optional: isOptional,
        observability,
      });
    }

    // Register relations
    for (const [relName, relDef] of Object.entries(modelDef.relations)) {
      if (relDef.type === 'belongsTo') {
        registry.registerReference(modelName, relName, {
          referencedModel: () => {
            const targetModel = registry.getModelByName(relDef.target);
            return targetModel ?? DynamicModel;
          },
          indexed: true,
        });
      } else if (relDef.type === 'hasMany') {
        // Generate a getter on the parent model that returns all children
        // matching the FK via Model.getStore().getByForeignKey(). The FK
        // index on the target model is registered by deriveSyncPlanFromSchema.
        const targetName = relDef.target;
        const foreignKey = relDef.foreignKey;
        const orderByField = relDef._orderBy;

        // Resolve the target typename from the schema (might differ from the key)
        const targetDef = schema.models[targetName];
        const targetTypename = targetDef?.typename ?? targetName;

        Object.defineProperty(DynamicModel.prototype, relName, {
          get(this: Model) {
            const store = Model.getStore();
            if (!store) return [];
            const results = store.getByForeignKey(targetTypename, foreignKey, this.id);
            if (orderByField && results.length > 1) {
              return [...results].sort((a, b) => {
                // `orderByField` is a runtime string from the schema's
                // hasMany({ orderBy }) — Models have dynamic typed
                // fields produced by createDynamicModelClass, so the
                // static type doesn't carry an index signature for
                // arbitrary field reads. `Reflect.get` is the typed
                // bridge — returns `unknown`, narrowed below.
                const va: unknown = Reflect.get(a, orderByField);
                const vb: unknown = Reflect.get(b, orderByField);
                if (typeof va === 'number' && typeof vb === 'number') return va - vb;
                if (typeof va === 'string' && typeof vb === 'string') return va.localeCompare(vb);
                return 0;
              });
            }
            return results;
          },
          enumerable: true,
          configurable: true,
        });
      }
    }
  }

  registry.endBatch();
}

// ── JSON sub-property helpers ─────────────────────────────────────────────

/**
 * Unwrap a Zod schema through .optional(), .nullable(), .default(),
 * .readonly() to find the innermost type. Needed to detect whether a
 * field.json() call wraps a ZodObject (has sub-properties) or a plain
 * type (ZodUnknown, ZodArray, etc.).
 *
 * Uses Zod's public `.unwrap()` API per wrapper type — no `_def`
 * digging. Bounded loop guards against pathological self-referential
 * wrappers.
 */
function unwrapZodType(schema: z.ZodType): z.ZodType {
  let current: z.ZodType = schema;
  for (let i = 0; i < 10; i++) {
    if (current instanceof z.ZodOptional) {
      current = current.unwrap() as z.ZodType;
      continue;
    }
    if (current instanceof z.ZodNullable) {
      current = current.unwrap() as z.ZodType;
      continue;
    }
    if (current instanceof z.ZodDefault) {
      // v4 deprecates removeDefault in favor of unwrap, but the
      // installed @types declarations only expose removeDefault on
      // ZodDefault. Use it — it's the same runtime function.
      current = current.unwrap() as z.ZodType;
      continue;
    }
    if (current instanceof z.ZodReadonly) {
      current = current.unwrap() as z.ZodType;
      continue;
    }
    break;
  }
  return current;
}

/** Type guard: is this a ZodObject with a .shape property? */
function isZodObject(schema: z.ZodType): schema is z.ZodObject<z.ZodRawShape> {
  return schema instanceof z.ZodObject;
}

/** Create a Model subclass for a schema-defined model */
function createDynamicModelClass(
  modelName: string,
  jsonSubFields: Array<{ fieldName: string; subSchema: z.ZodObject<z.ZodRawShape> }>,
  fieldNames: string[],
  computed?: Record<string, (self: Record<string, unknown>) => unknown>,
  lazyObservable = false,
) {
  const ModelClass = class extends Model {
    private _modelName = modelName;

    constructor(data?: Record<string, unknown>) {
      super(data);
      // Gate `propertyChanged`-via-`observe` tracking during initial
      // hydration. M1 installs a MobX `observe()` listener per schema
      // property that forwards writes to `propertyChanged()` so direct
      // assignments like `layer.position = newPos` still round-trip
      // through the transaction queue. During construction we're writing
      // wire data, NOT user edits — flagging this as "constructing" lets
      // the listener early-return on those writes so `modifiedProperties`
      // doesn't get polluted with every field of every hydrated model.
      //
      // The listener is installed by `makeObservable()` below (inside
      // M1), so writes that happen BEFORE that line won't fire it; this
      // flag is defensive in case a subclass or call path reorders the
      // steps later.
      (this as { _isConstructing?: boolean })._isConstructing = true;
      // MobX 6 requires fields to exist as own properties BEFORE makeObservable().
      // Model base only sets id/createdAt/updatedAt. Schema fields (title, userId, etc.)
      // must be initialized here so M1's annotations can find them.
      for (const field of fieldNames) {
        if (!(field in this)) {
          (this as Record<string, unknown>)[field] = data?.[field] ?? undefined;
        }
      }
      // Per-field MobX observability opt-in via `lazyObservable: true` on
      // the model definition. Defaults to plain objects — reactivity comes
      // from the QueryView "entry replaced" pattern, which is cheap for
      // read-only list UIs but invisible to in-place field mutations.
      //
      // Multiplayer editors need live field-level reactivity so remote
      // deltas AND local drag/resize/rename mutations surface through
      // `observer()` components without the whole pool entry being
      // replaced. Without observability, `layer.position.x = 500` emits
      // nothing and the UI lags until some unrelated state change triggers
      // a pass (toolbar close, deselect).
      //
      // Delegates to `Model.makeObservable()` (the inherited method) so
      // MobX annotations are derived from the same registry that M1 reads.
      // That means computed getters, reference collections, custom
      // getters/setters, and property-change tracking all integrate
      // correctly — reimplementing `makeObservable` inline here would miss
      // those seams.
      if (lazyObservable) {
        this.makeObservable();
      }
      (this as { _isConstructing?: boolean })._isConstructing = false;
    }

    getModelName(): string {
      return this._modelName;
    }
  };

  // Generate ${field}Json getters for JSON fields with sub-properties.
  //
  // The getter reads the raw JSON string from the instance (set via
  // updateFromData), parses it, applies Zod defaults, and caches by
  // raw value. This replaces the hand-coded metadataObject + sub-property
  // getter pattern that 11+ Ablo models currently repeat.
  //
  // Example: field named 'metadata' with sub-schema { icon: z.string().default('presentation') }
  // → model.metadataJson returns { icon: 'presentation', ... } (typed, cached)
  for (const { fieldName, subSchema } of jsonSubFields) {
    const getterName = `${fieldName}Json`;
    const cacheKey = `__${fieldName}JsonCache`;

    Object.defineProperty(ModelClass.prototype, getterName, {
      get(this: Record<string, unknown>) {
        const raw = this[fieldName];

        // Cache check: same raw value → same parsed result
        const cache = this[cacheKey] as { raw: unknown; parsed: unknown } | undefined;
        if (cache && cache.raw === raw) return cache.parsed;

        // Parse: handle string (from DB/wire), object (already parsed), null/undefined
        let input: unknown;
        try {
          if (typeof raw === 'string') {
            input = JSON.parse(raw);
          } else if (raw && typeof raw === 'object') {
            input = raw;
          } else {
            input = {};
          }
        } catch {
          input = {};
        }

        // Apply Zod parse for type coercion + defaults. safeParse so
        // malformed metadata doesn't crash — falls back to all defaults.
        const result = subSchema.safeParse(input);
        const parsed = result.success ? result.data : subSchema.safeParse({}).data ?? {};

        this[cacheKey] = { raw, parsed };
        return parsed;
      },
      enumerable: true,
      configurable: true,
    });
  }

  // Install schema-declared computed getters on the prototype.
  // Each getter receives `this` (the model instance) and returns the computed value.
  if (computed) {
    for (const [name, fn] of Object.entries(computed)) {
      Object.defineProperty(ModelClass.prototype, name, {
        get(this: Record<string, unknown>) {
          return fn(this);
        },
        enumerable: true,
        configurable: true,
      });
    }
  }

  return ModelClass;
}

// ── Default console logger ────────────────────────────────────────────────

const consoleLogger: SyncLogger = {
  debug: (...args: unknown[]) => { if (typeof console !== 'undefined') console.debug('[sync]', ...args); },
  info: (...args: unknown[]) => { if (typeof console !== 'undefined') console.info('[sync]', ...args); },
  warn: (...args: unknown[]) => { if (typeof console !== 'undefined') console.warn('[sync]', ...args); },
  error: (...args: unknown[]) => { if (typeof console !== 'undefined') console.error('[sync]', ...args); },
};

// `readProcessEnv` lives in `./auth` alongside the other resolvers
// that read it. Re-exported there for use elsewhere in the file.

// ── Default mutation executor (wire: `commit` frame over WebSocket) ──────

/**
 * Derive a stable `Idempotency-Key` from the batch's operation set.
 *
 * Retries of the same batch compute the same key — a reconnecting
 * client that rebuilds the identical mutations from its offline queue
 * sends the identical key, so the server's `mutation_log` replay path
 * returns the cached response instead of re-executing the mutators.
 *
 * Content-addressed: sort operations by (model, id, type) then sha256
 * the serialized form. Separator-safe — adjacent fields are delimited
 * by a character (`\x1e`, the ASCII record separator) that cannot
 * appear in a JSON string literal. Output length is 70 chars — safely
 * under Stripe's documented 255-char cap.
 *
 * Uses the Web Crypto API (cross-runtime: Node 20+ and browsers), same
 * primitive as the offline queue's AES-GCM encryption.
 *
 * @internal — exported as unexported file-local; callers go through
 * the executor's own `Idempotency-Key` plumbing.
 */
async function deriveOperationsIdempotencyKey(
  operations: ReadonlyArray<{
    type: string;
    model: string;
    id: string;
    input?: Record<string, unknown>;
  }>,
): Promise<string> {
  const normalized = [...operations]
    .map((op) => ({
      type: op.type,
      model: op.model,
      id: op.id,
      input: op.input ?? null,
    }))
    .sort((a, b) => {
      if (a.model !== b.model) return a.model < b.model ? -1 : 1;
      if (a.id !== b.id) return a.id < b.id ? -1 : 1;
      return a.type < b.type ? -1 : a.type > b.type ? 1 : 0;
    });
  const encoded = new TextEncoder().encode(JSON.stringify(normalized));
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return `batch-${hex}`;
}

/**
 * Default mutation executor: sends `{ type: 'commit', payload: ... }` over
 * the sync engine's own WebSocket.
 *
 * Transport ownership follows the Zero / Liveblocks pattern — the engine
 * owns its socket end-to-end and the executor is internal. Apps pass URLs
 * and auth; they do NOT inject transport callbacks. That's why this
 * factory takes a `getWs` closure instead of a full SyncWebSocket: the WS
 * doesn't exist when the executor is constructed (it's created later in
 * `Ablo` during `BaseSyncedStore` init), so we resolve it
 * lazily at commit time. Same trick Zero uses internally — see
 * `packages/zero-client/src/client/zero.ts` where `Pusher`/`Puller` are
 * constructed before the socket then wired up at connect time.
 *
	 * `options.idempotencyKey` becomes the wire-level `clientTxId` when set,
	 * matching Stripe-style retry semantics. Otherwise the SDK generates one.
	 */
	function createDefaultMutationExecutor(
	  getWs: () => {
	    sendCommit?: (
	      operations: ReadonlyArray<MutationOperation>,
	      clientTxId: string,
	      timeoutMs?: number,
	      causedByTaskId?: string | null,
	    ) => Promise<{ lastSyncId: number }>;
	  } | null,
	): MutationExecutor {
	  async function commit(
	    operations: MutationOperation[],
	    options?: MutationOptions,
	  ) {
    const ws = getWs();
    if (!ws?.sendCommit) {
      throw new AbloConnectionError(
        'SyncWebSocket not ready for commit. The engine must finish bootstrap ' +
          'before mutations can be sent.',
        { code: 'ws_not_ready' },
      );
    }
	    const clientTxId =
	      options?.idempotencyKey ??
	      (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
	        ? crypto.randomUUID()
	        : `tx_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
	    try {
	      return await ws.sendCommit(
	        operations,
	        clientTxId,
	        undefined, // use sendCommit's built-in 15s default; no per-call override
	        options?.causedByTaskId,
	      );
    } catch (err) {
      // Wrap transport-level failures as connection errors so the
      // TransactionQueue's retry classifier treats them as transient
      // (matches the old HTTP path's network-error handling).
      if (err instanceof AbloError) throw err;
      if (err instanceof Error) {
        if (/not connected|timed out|connection|ECONN/i.test(err.message)) {
          const wrapped = new AbloConnectionError(err.message, { cause: err });
          // Preserve any `diagnostics` snapshot the underlying SyncWebSocket
          // attached to the rejection. Without this, the wrapped error
          // bottoms out at "AbloConnectionError: not connected" with no
          // attribution to which close code / heartbeat trip / session
          // error caused it. See SyncWebSocket.notConnectedError().
          if (
            err &&
            typeof err === 'object' &&
            'diagnostics' in err &&
            (err as { diagnostics?: unknown }).diagnostics
          ) {
            (wrapped as unknown as { diagnostics: unknown }).diagnostics = (
              err as { diagnostics: unknown }
            ).diagnostics;
          }
          throw wrapped;
        }
      }
      throw err;
    }
  }

  return {
    commit,
    executeCreate: (model, id, input, _txId, options) =>
      commit([{ type: 'CREATE', model: model.toLowerCase(), id, input }], options).then(() => {}),
    executeUpdate: (model, id, data, _txId, options) =>
      commit([{ type: 'UPDATE', model: model.toLowerCase(), id, input: data }], options),
    executeDelete: (model, id, _txId, options) =>
      commit([{ type: 'DELETE', model: model.toLowerCase(), id }], options).then(() => {}),
    executeArchive: (model, id, _txId, options) =>
      commit([{ type: 'ARCHIVE', model: model.toLowerCase(), id }], options).then(() => {}),
    executeUnarchive: (model, id, _txId, options) =>
      commit([{ type: 'UNARCHIVE', model: model.toLowerCase(), id }], options).then(() => {}),
  };
}

// ── Default mutation dispatcher (for offline flush) ───────────────────────

function createDefaultMutationDispatcher(executor: MutationExecutor): MutationDispatcher {
  return {
    async dispatch(opName: string, variables: Record<string, unknown>) {
      const prefixes = ['Create', 'Update', 'Delete', 'Archive', 'Unarchive'] as const;
      for (const prefix of prefixes) {
        if (opName.startsWith(prefix)) {
          const model = opName.slice(prefix.length);
          const v = variables;
          const input = (prefix === 'Create' || prefix === 'Update')
            ? v.input as Record<string, unknown>
            : undefined;
          await executor.commit([{
            type: prefix.toUpperCase(),
            model: model.toLowerCase(),
            id: (v.id as string) ?? '',
            input,
          }]);
          return;
        }
      }
    },
  };
}

// ── Auth normalization ─────────────────────────────────────────────────────

/**
 * The one resolver the credential lifecycle needs: an async `() => token | null`,
 * or `null` when auth is static (a plain long-lived `apiKey` with no refresh —
 * the common case). Only the short-lived per-user path sets this, via `getToken`
 * (the primitive) or `authEndpoint` (sugar that POSTs for `{ token }`).
 */
function resolveCredentialResolver<S extends SchemaRecord>(
  options: AbloOptions<S>,
): (() => Promise<string | null>) | null {
  if (options.getToken) return options.getToken;
  if (options.authEndpoint) {
    const endpoint = options.authEndpoint;
    const fetchImpl = options.fetch ?? globalThis.fetch;
    return async (): Promise<string | null> => {
      // The endpoint lives on the consumer's OWN backend and is authed by the
      // user's session cookie (hence `credentials: 'include'`); it returns the
      // `ek_` to carry to the sync-server. A non-OK response is terminal
      // (`null` → sign out), matching the `getToken` contract.
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { token?: string | null };
      return body.token ?? null;
    };
  }
  return null;
}

// ── The factory ───────────────────────────────────────────────────────────

/**
 * Create a sync engine client in one call.
 *
 * ```ts
 * const sync = Ablo({ schema, apiKey: process.env.ABLO_API_KEY });
 *
 * const reports = sync.weatherReports.list({ where: { status: 'pending' } });
 * await sync.weatherReports.create({ location: 'Stockholm', status: 'pending' });
 * ```
 */
export function Ablo<const S extends SchemaRecord>(
  options: AbloOptions<S>,
): Ablo<S>;
export function Ablo(
  options: AbloApiClientOptions,
): AbloApi;
export function Ablo<const S extends SchemaRecord>(
  options: AbloOptions<S> | AbloApiClientOptions,
): Ablo<S> | AbloApi {
  if (options.schema == null) {
    return createProtocolClient(options as AbloApiClientOptions);
  }

  const internalOptions = options as InternalAbloOptions<S>;
  const env = readProcessEnv();
  const authInput = { options, env };
  const configuredApiKey = resolveApiKey(authInput);
  const configuredAuthToken = resolveAuthToken(authInput);
  // The client OWNS its credential lifecycle (not the React layer): this resolver
  // drives both the reactive re-mint (FSM `credential_stale`) and the proactive
  // refresh timer + wake/online/focus triggers. Null for the common static
  // `apiKey` path — no refresh needed.
  const credentialResolver = resolveCredentialResolver(options as AbloOptions<S>);
  const authCredentials = createAuthCredentialSource(
    internalOptions.capabilityToken ?? configuredAuthToken,
  );
  const configuredDatabaseUrl = resolveDatabaseUrl(authInput);
  assertBrowserSafety({
    apiKey: configuredApiKey,
    databaseUrl: configuredDatabaseUrl,
    dangerouslyAllowBrowser: options.dangerouslyAllowBrowser,
  });

  const { logger = consoleLogger } = internalOptions;
  const schema = options.schema as Schema<S>;
  const url = resolveBaseURL(authInput);

  // 1. Derive config from schema
  // 1. Derive config from schema, then layer caller-supplied overrides on top.
  //    `configOverrides` is a shallow merge: caller takes precedence per key.
  const config: SyncEngineConfig = {
    ...deriveConfigFromSchema(schema),
    ...internalOptions.configOverrides,
  };

  // 2. Create the mutation executor + dispatcher.
  //
  //    The default executor sends `{ type: 'commit', ... }` over the
  //    engine's WebSocket. The WS doesn't exist yet at this point (it's
  //    created later when `BaseSyncedStore` initializes), so the default
  //    takes a lazy getter that resolves the live WS at commit time.
  //    `storeForTransport` is captured by the closure and assigned below
  //    once the store is built — JS closures close over bindings, not
  //    values, so by the time the first commit fires the store is live.
  //
  //    Caller-supplied executors are still honored for advanced cases
  //    (test mocks, alternative transports) but the public `<AbloProvider>`
  //    surface will mark this option `@internal` — apps should almost
  //    never need to override transport. See Zero's `ClientOptions`
  //    (packages/zero-client/src/client/options.ts) and Liveblocks'
  //    `ClientOptions` (packages/liveblocks-core/src/client.ts) for the
  //    reference shape: URLs + auth + declarative mutators, never a
  //    pluggable commit transport.
  // Captured-by-reference binding — assigned below after BaseSyncedStore
  // is constructed. The default executor's `getWs` closure reads it
  // lazily at commit time.
  // The store is created later with full generics (`Schema<S>`), so type
  // it here as the same generic — narrower default doesn't accept it.
  const storeHolder: { store: BaseSyncedStore<DefaultCollaborationEvents, Schema<S>> | null } = { store: null };
  const executor: MutationExecutor =
    internalOptions.mutationExecutor ??
    createDefaultMutationExecutor(() => {
      const ws = storeHolder.store?.getSyncWebSocket() ?? null;
      return ws;
    });
  const dispatcher: MutationDispatcher =
    internalOptions.mutationDispatcher ?? createDefaultMutationDispatcher(executor);

  // 3. Initialize SDK context (one call — hides all DI wiring).
  //    Each provider can be overridden individually; the noop defaults
  //    are preserved for the zero-config consumer path.
  initSyncEngine({
    logger,
    observability: internalOptions.observability ?? noopObservability,
    analytics: internalOptions.analytics ?? noopAnalytics,
    sessionErrorDetector: internalOptions.sessionErrorDetector ?? defaultSessionErrorDetector,
    onlineStatus:
      internalOptions.onlineStatus ??
      (shouldUseInMemoryPersistence(options)
        ? alwaysOnline()
        : browserOnlineStatus),
    config,
    mutationExecutor: executor,
    mutationDispatcher: dispatcher,
  });

  // 4. Create internal components (user never sees these). See
  //    `./createInternalComponents.ts` for the construction order
  //    and what each component does. Model registration happens
  //    here because `registerModelsFromSchema` lives in this file —
  //    the schema-to-Model-class translation depends on private
  //    helpers (`createDynamicModelClass`, `unwrapZodType`, etc.)
  //    that aren't worth pulling into the components module.
  const {
    modelRegistry,
    objectPool,
    bootstrapHelper,
    database,
    syncClient,
    hydration,
  } = createInternalComponents({
    schema,
    url,
    options: internalOptions,
    auth: authCredentials,
  });
  registerModelsFromSchema(schema, modelRegistry);

  // 5. BaseSyncedStore handles the initialization orchestration
  //    (open DB → hydrate IDB → connect WS → fetch bootstrap → hydrate again →
  //    ready) and exposes the observable `syncStatus` we expose on the engine.
  //
  //    Phase 2: pass the schema into the store so `deriveSyncPlanFromSchema`
  //    can auto-populate version vector keys, FK indexes, and enrichment
  //    rules from the declarative `belongsTo({ index, enrich })` annotations.
  //    Consumers using class-based subclasses with `new SyncedStore(...)`
  //    directly can pass explicit config arrays instead.
  const store = new BaseSyncedStore({
    syncClient,
    database,
    objectPool,
    modelRegistry,
    schema,
    url,
    auth: authCredentials,
  });

  // Hand the credential lifecycle to the client (refresher + proactive refresh
  // timer + wake/online/focus re-mint). Installed once here so refresh works for
  // ANY consumer of `Ablo({ auth })` — not only those who render `<AbloProvider>`.
  // The first mint happens in `ready()` so the first connection carries a token.
  if (credentialResolver) {
    store.startCredentialLifecycle(credentialResolver);
  }

  // Wire the store back into the default executor's lazy getter (see
  // `storeHolder` above). The executor was constructed before the store
  // existed; this late binding closes the loop so commits dispatch over
  // the engine's WebSocket once it opens.
  storeHolder.store = store;

  // Bind THIS executor to THIS Ablo's TransactionQueue. Without this,
  // the queue resolves `mutationExecutor` from the module-level
  // `getContext()`, which `initSyncEngine()` overwrites on every Ablo
  // construction. In multi-Ablo flows (e.g. agent-worker's worker +
  // per-job peer) the second `initSyncEngine()` call would silently
  // redirect the first Ablo's queue through the second Ablo's executor
  // closure — and when the second Ablo disposes, its `storeHolder.store`
  // becomes null, so the first Ablo's commits start throwing
  // `ws_not_ready` forever (terminal AgentJob writes hang on retry).
  syncClient.getTransactionQueue().setMutationExecutor(executor);

  // Active turn id, set by `beginTurn(...)`, cleared on close. While
  // set, every batch commit attaches `causedByTaskId` so server
  // delta rows get stamped with it. Single-turn-at-a-time per Ablo
  // — opening a second turn overwrites the active id without closing
  // the prior. Callers who need parallel turns construct multiple
  // Ablo instances, matching the SyncAgent semantics.
  let activeTurnId: string | null = null;

  // Presence + intent streams — built eagerly so `engine.presence`
  // and `engine.intents` return the same reference for the engine's
  // lifetime. The transport doesn't exist yet (BaseSyncedStore.initialize
  // creates it during ready()), so both streams are constructed in
  // deferred-attach mode and wired after initialize() resolves below.
  // Calls before attach mutate local state but skip the wire send.
  // Identity routing: agents identify by agentId, users by user.id.
  // The server stamps `isAgent` on outbound presence frames from the
  // connection's authenticated identity prefix, but the local `self`
  // entry uses the kind we know at construction.
  const participantId =
    (internalOptions.kind === 'agent' ? internalOptions.agentId : internalOptions.user?.id) ?? '';
  const presenceStream = createPresenceStream({
    participantId,
    syncGroups: internalOptions.syncGroups ?? [],
    isAgent: internalOptions.kind === 'agent',
  });
  const intentStream = createIntentStream({ participantId });
  const participantManager = createParticipantManager({
    ready,
    getTransport: () => store.getSyncWebSocket() ?? null,
    presence: presenceStream,
    intents: intentStream,
    schema,
  });

  // 6. Validate options up front — fail loudly on obviously wrong inputs so
  //    strangers don't get silent empty results. Validation errors are written
  //    into `store.syncStatus` (the single source of truth).
  const kind = internalOptions.kind ?? 'user';
  const _validationError = validateAbloOptions({
    options: internalOptions,
    url,
    configuredApiKey,
    configuredAuthToken,
  });
  if (_validationError) {
    logger.error(_validationError.message);
    store.syncStatus.state = 'error';
    store.syncStatus.error = _validationError;
  }

  // 7. The ready() promise drives the BaseSyncedStore.initialize() generator
  //    to completion. First call kicks off the initialization; subsequent
  //    calls return the same promise (idempotent).
  //
  //    Status is tracked in store.syncStatus (MobX observable) — the single
  //    source of truth. No duplicate closure variables.
	  let _readyPromise: Promise<void> | null = null;
	  let _refreshScheduler: RefreshScheduler | null = null;

  async function ready(): Promise<void> {
    if (_readyPromise) return _readyPromise;

    if (_validationError) {
      _readyPromise = Promise.reject(_validationError);
      return _readyPromise;
    }

    _readyPromise = (async () => {
      try {
        // Mint the FIRST access credential before we connect, so the initial
        // WebSocket upgrade + bootstrap carry a valid bearer (no tokenless first
        // connect that has to self-heal). Only when a refreshing resolver is
        // wired AND no static credential is already present. Contract mirrors
        // `getToken`: `null` ⇒ the login is gone (terminal — fail ready so the
        // app shows sign-in); a THROW ⇒ transient (rethrown; autoStart swallows
        // and the lifecycle's online/wake triggers retry).
        if (credentialResolver && !authCredentials.getAuthToken()) {
          const token = await credentialResolver();
          if (!token) {
            throw new AbloAuthenticationError(
              'Auth resolver returned null before connect — the user is not signed in.',
              { code: 'auth_no_credentials' },
            );
          }
          authCredentials.setAuthToken(token);
        }

        // Register the caller's own database for write-back BEFORE bootstrap, so
        // the server resolves this org's data plane to the customer's DB rather
        // than serving an empty/wrong store. The org is derived server-side from
        // the API key. Idempotent server-side (register-or-update). Skipped when
        // no `databaseUrl` was configured (Ablo-managed storage).
        if (configuredDatabaseUrl) {
          await registerDataSource({
            baseUrl: resolveBootstrapBaseUrl({ url }),
            apiKey: await resolveApiKeyValue(configuredApiKey),
            databaseUrl: configuredDatabaseUrl,
            ...(internalOptions.fetch ? { fetchImpl: internalOptions.fetch } : {}),
          });
        }

        // Resolve participant identity + scope. Three branches —
        // hosted-cloud apiKey exchange, self-derived from capability
        // token, or legacy explicit options. See `./identity.ts`.
        const resolved = await resolveParticipantIdentity({
          options: internalOptions,
          internalOptions,
          url,
          kind,
          configuredApiKey,
          // Resolve identity against the LIVE token, not the construction-time
          // `configuredAuthToken`. Consumers using `getToken` (apps/web) never
          // pass `authToken` at construction — they call `setAuthToken()` before
          // `ready()`, which updates the shared credential source. Reading the frozen
          // `configuredAuthToken` here made `/auth/identity` fire with no Bearer
          // (→ `no_matching_provider` / `session_expired`) even though the JWT
          // was present. Mirrors every other transport by reading the shared
          // credential source.
          configuredAuthToken: authCredentials.getAuthToken() ?? configuredAuthToken,
          bootstrapHelper,
          auth: authCredentials,
	          logger,
	        });
        const {
          userId,
          accountScope,
          teamIds,
          capabilityToken,
	          syncGroups,
	          participantKind,
	        } = resolved;

	        // Fail-loud guard: detect the degenerate "no real sync groups
	        // resolved" state before opening the WS. Same class of bug as
	        // the schema-drift `[commit] dropped stale field` warning —
	        // sensible-looking default that's functionally broken: the
	        // SDK ends up subscribing only to the server-side
	        // `['default']` fallback (bootstrap.ts:45, Hub.ts:480), no
	        // delta has that tag, live fan-out silently never delivers.
	        // For human users (kind:'user') this is almost certainly a
	        // misconfiguration upstream — either the caller didn't pass
	        // `syncGroups`, or auth resolution didn't derive them, or
	        // both. Warn loudly so the next debugging session starts here
	        // instead of with "live updates don't work, hard reload fixes
	        // it."
	        const resolvedSyncGroups = syncGroups ?? [];
	        if (
	          participantKind === 'user' &&
	          (resolvedSyncGroups.length === 0 ||
	            (resolvedSyncGroups.length === 1 && resolvedSyncGroups[0] === 'default'))
	        ) {
	          logger.warn(
	            'Ablo({kind:"user"}) initialized with degenerate syncGroups — ' +
	              'this client will receive zero deltas through the live WS path. ' +
	              'Either pass `syncGroups` explicitly (typically ' +
	              '`["org:${orgId}", "user:${userId}"]`) or verify your auth ' +
	              'provider populates them. See packages/sync-engine/src/client/identity.ts.',
	            { participantKind, resolvedSyncGroups },
	          );
	        }

        if (resolved.refreshScheduler) {
          _refreshScheduler = resolved.refreshScheduler;
        }

        // Drive the generator to completion. Each yielded promise is awaited
        // then fed back — this is standard generator consumption.
        //
        // The store.initialize() generator updates store.syncStatus as it
        // progresses (syncing → idle on success, error on failure), so the
        // consumer's `sync.syncStatus` observable reflects real-time state.
        // Resolve bootstrap mode: explicit option wins; otherwise
        // agents default to 'none' (transactional participant — see
        // option doc) and everyone else defaults to 'full'.
        const resolvedBootstrapMode: 'full' | 'none' =
          internalOptions.bootstrapMode ?? (participantKind === 'agent' ? 'none' : 'full');

        const gen = store.initialize({
          userId,
          organizationId: accountScope,
          teamIds,
          kind: participantKind,
          capabilityToken,
          syncGroups,
          bootstrapMode: resolvedBootstrapMode,
        });
        let current = gen.next();
        while (!current.done) {
          const yielded = current.value;
          const resolved = yielded instanceof Promise ? await yielded : yielded;
          current = gen.next(resolved);
        }

        const result = current.value;
        if (!result.success) {
          throw result.error
            ? toAbloError(result.error)
            : new AbloConnectionError('Sync engine initialization failed', {
                code: 'bootstrap_fetch_timeout',
              });
        }

        // Wire presence + intents to the now-open transport.
        // `getSyncWebSocket()` returns non-null after a successful
        // initialize() — the WS is created during the generator's
        // connect step.
        const ws = store.getSyncWebSocket();
        if (ws) {
          presenceStream.attach(ws);
          intentStream.attach(ws);
        }

        logger.info('Sync engine ready', { models: Object.keys(schema.models).length });
      } catch (err) {
        // Coerce so the rejection a consumer awaiting `ready()` catches is
        // always an AbloError — connection setup is held to the same
        // never-leak-untagged contract as the model operations.
        const error = toAbloError(err);
        // Make sure syncStatus reflects the failure for observer() components
        store.syncStatus.state = 'error';
        store.syncStatus.error = error;
        // Log the typed envelope (type + code + status), not just the bare
        // message — so the console line names it as an Ablo error and carries
        // the code (e.g. AbloAuthenticationError/identity_resolve_failed on a
        // 401) instead of reading like an untagged failure.
        logger.error('Sync engine failed to initialize', {
          type: error.type,
          code: error.code,
          httpStatus: error.httpStatus,
          error: error.message,
        });
        // Clear the memo so a FUTURE `ready()` re-attempts bootstrap instead of
        // replaying this rejection forever. Bootstrap failures here are
        // transient by nature — offline, an IndexedDB open timeout, a bootstrap
        // fetch hiccup — and used to brick the engine until a full page reload
        // because line ~2013 (`if (_readyPromise) return _readyPromise`) handed
        // every later caller this same dead promise. Nulling it lets the
        // provider's online/wake/retry triggers drive a clean re-bootstrap.
        // (The terminal `_validationError` branch above intentionally stays
        // cached — config can't change without recreating the engine.)
        _readyPromise = null;
        throw error;
      }
    })();

    return _readyPromise;
  }

  // 9. Optional auto-start for convenience. Opt-in because silent background
  //    init has historically been the #1 source of "why isn't my data loading"
  //    bug reports. Explicit `await sync.ready()` is the default — errors
  //    surface immediately instead of being swallowed.
  if (!_validationError && internalOptions.autoStart) {
    void ready().catch(() => {
      // Error is captured in store.syncStatus; consumers should check
      // `sync.syncStatus.state === 'error'` to detect failures.
    });
  }

  // 9b. waitForFlush — drains pending mutations using the store's
  //     pendingChanges counter (already maintained by BaseSyncedStore based
  //     on TransactionQueue events). Polls every 50ms; uses the existing
  //     observable rather than introducing a new event channel.
	  async function waitForFlush(timeoutMs?: number): Promise<void> {
	    const start = Date.now();
	    while (store.syncStatus.pendingChanges > 0) {
	      if (timeoutMs !== undefined && Date.now() - start > timeoutMs) {
	        throw new AbloConnectionError(
          `Flush timeout: ${store.syncStatus.pendingChanges} pending mutations after ${timeoutMs}ms`,
          { code: 'flush_timeout' },
        );
      }
	      await new Promise((resolve) => setTimeout(resolve, 50));
	    }
	  }

	  const fetchImpl = options.fetch ?? globalThis.fetch;

	  function authHeaders(): Record<string, string> {
	    return authCredentials.withAuthHeaders({ 'Content-Type': 'application/json' });
	  }

	  function createClientTxId(idempotencyKey?: string | null): string {
	    if (idempotencyKey && idempotencyKey.length > 0) return idempotencyKey;
	    return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
	      ? crypto.randomUUID()
	      : `tx_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
	  }

	  function createModelId(): string {
	    return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
	      ? crypto.randomUUID()
	      : `id_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
	  }

	  function normalizeIntentId(
	    intent: string | { readonly id: string } | null | undefined,
	  ): string | undefined {
	    if (typeof intent === 'string') return intent;
	    return intent?.id;
	  }

	  function normalizeCommitOperation(
	    op: CommitOperationInput,
	    defaults: Pick<CommitCreateOptions, 'readAt' | 'onStale'>,
	  ): MutationOperation {
	    const model = op.model ?? op.target?.model;
	    if (!model) {
	      throw new AbloValidationError(
	        'Commit operation requires `model` or `target.model`.',
	        { code: 'commit_operation_model_required' },
	      );
	    }
	    const type = op.action.toUpperCase();
	    const id = op.id ?? op.target?.id ?? '';
	    return {
	      type,
	      model: model.toLowerCase(),
	      id,
	      input: op.data ?? undefined,
	      transactionId: op.transactionId ?? undefined,
	      readAt: op.readAt ?? defaults.readAt ?? undefined,
	      onStale: op.onStale ?? defaults.onStale ?? undefined,
	    };
	  }

	  function normalizeCommitOperations(
	    commitOptions: CommitCreateOptions,
	  ): MutationOperation[] {
	    if (commitOptions.operation && commitOptions.operations) {
	      throw new AbloValidationError(
	        'Pass either `operation` or `operations`, not both.',
	        { code: 'commit_operations_ambiguous' },
	      );
	    }
	    const inputOperations = commitOptions.operation
	      ? [commitOptions.operation]
	      : commitOptions.operations ?? [];
	    if (inputOperations.length === 0) {
	      throw new AbloValidationError(
	        'Commit requires at least one operation.',
	        { code: 'commit_operation_required' },
	      );
	    }
	    return inputOperations.map((op) =>
	      normalizeCommitOperation(op, commitOptions),
	    );
	  }

	  function modelClaimFromActive(intent: ActiveIntent): ModelClaim {
	    const description =
	      typeof intent.target.meta?.description === 'string'
	        ? intent.target.meta.description
	        : undefined;
	    return {
	      id: intent.id,
	      actor: intent.heldBy,
	      participantKind: intent.participantKind,
	      action: intent.reason,
	      ...(description ? { description } : {}),
	      field: intent.target.field,
	      status: 'active',
	      expiresAt: intent.expiresAt,
	      target: {
	        model: intent.target.type,
	        id: intent.target.id,
	        path: intent.target.path,
	        range: intent.target.range,
	        field: intent.target.field,
	        meta: intent.target.meta,
	      },
	    };
	  }

	  function modelClaimFromQueued(intent: Intent): ModelClaim {
	    return {
	      id: intent.id,
	      actor: intent.heldBy,
	      participantKind: intent.participantKind,
	      action: intent.action,
	      ...(intent.description ? { description: intent.description } : {}),
	      field: intent.target.field,
	      status: 'queued',
	      position: intent.position,
	      expiresAt: intent.expiresAt,
	      target: {
	        model: intent.target.type,
	        id: intent.target.id,
	        path: intent.target.path,
	        range: intent.target.range,
	        field: intent.target.field,
	        meta: intent.target.meta,
	      },
	    };
	  }

	  function targetMatchesModel(
	    target: { readonly model?: string; readonly id?: string; readonly field?: string },
	    intent: ActiveIntent,
	  ): boolean {
	    if (
	      target.model &&
	      intent.target.type.toLowerCase() !== target.model.toLowerCase()
	    ) {
	      return false;
	    }
	    if (target.id && intent.target.id !== target.id) return false;
	    if (target.field && intent.target.field !== target.field) return false;
	    return true;
	  }

	  function listModelClaims(target?: Partial<ModelTarget>): readonly ModelClaim[] {
	    return intentStream.others
	      .filter((intent) => (target ? targetMatchesModel(target, intent) : true))
	      .map(modelClaimFromActive);
	  }

	  function listModelClaimQueue(target?: Partial<ModelTarget>): readonly ModelClaim[] {
	    if (!target?.model || !target.id) return [];
	    return publicIntents
	      .queueFor({ type: target.model, id: target.id })
	      .filter((intent) => (target.field ? intent.target.field === target.field : true))
	      .map(modelClaimFromQueued);
	  }

	  function claimedError(
	    target: Partial<ModelTarget>,
	    claims: readonly ModelClaim[],
	    code: 'model_claimed' | 'model_claimed_timeout' | 'queue_too_deep',
	  ): AbloClaimedError {
	    const label = [target.model, target.id, target.field].filter(Boolean).join('/');
	    const holder = claims[0];
	    const suffix = holder
	      ? ` held by ${holder.actor} (${holder.action})`
	      : ' held by another participant';
	    return new AbloClaimedError(
	      `Model row is claimed: ${label || 'target'}${suffix}.`,
	      { code, claims },
	    );
	  }

	  function waitForModelUnclaimed(
	    target: Partial<ModelTarget>,
	    options?: IntentWaitOptions,
	  ): Promise<void> {
	    if (listModelClaims(target).length === 0) return Promise.resolve();

	    return new Promise((resolve, reject) => {
	      let settled = false;
	      let timeoutId: ReturnType<typeof setTimeout> | undefined;
	      let unsubscribe: (() => void) | undefined;

	      const cleanup = () => {
	        if (timeoutId) clearTimeout(timeoutId);
	        if (unsubscribe) unsubscribe();
	        options?.signal?.removeEventListener('abort', onAbort);
	      };

	      const finish = (fn: () => void) => {
	        if (settled) return;
	        settled = true;
	        cleanup();
	        fn();
	      };

	      const check = () => {
	        if (listModelClaims(target).length === 0) {
	          finish(resolve);
	        }
	      };

	      const onAbort = () => {
	        finish(() =>
	          reject(
	            new AbloConnectionError('Intent wait aborted.', {
	              code: 'intent_wait_aborted',
	              cause: options?.signal?.reason,
	            }),
	          ),
	        );
	      };

	      if (options?.signal?.aborted) {
	        onAbort();
	        return;
	      }

	      unsubscribe = intentStream.onChange(check);
	      options?.signal?.addEventListener('abort', onAbort, { once: true });

	      if (options?.timeout != null) {
	        timeoutId = setTimeout(() => {
	          finish(() =>
	            reject(
	              claimedError(
	                target,
	                listModelClaims(target),
	                'model_claimed_timeout',
	              ),
	            ),
	          );
	        }, options.timeout);
	      }
	    });
	  }

	  async function applyClaimedPolicy(
	    target: Partial<ModelTarget>,
	    options?: ClaimedOptions,
	  ): Promise<void> {
	    const policy = options?.ifClaimed ?? 'return';
	    if (policy === 'return') return;

	    const current = listModelClaims(target);
	    if (current.length === 0) return;
	    if (policy === 'fail') throw claimedError(target, current, 'model_claimed');
	    const queue = listModelClaimQueue(target);
	    if (
	      options?.maxQueueDepth !== undefined &&
	      queue.length >= options.maxQueueDepth
	    ) {
	      throw claimedError(target, current, 'queue_too_deep');
	    }

	    await waitForModelUnclaimed(target, { timeout: options?.claimedTimeout });
	  }

	  function wrapIntentHandle(claim: Claim): IntentHandle {
	    const release = async (): Promise<void> => {
	      claim.revoke();
	    };
	    return {
	      id: claim.id,
	      release,
	      revoke: claim.revoke,
	      [Symbol.asyncDispose]: release,
	    };
	  }

	  const publicIntents: IntentResource = Object.assign(intentStream, {
	    async create(intentOptions: IntentCreateOptions): Promise<IntentHandle> {
	      await ready();
	      const claim = intentStream.claim(
	        {
	          type: intentOptions.target.model,
	          id: intentOptions.target.id,
	          path: intentOptions.target.path,
	          range: intentOptions.target.range,
	          field: intentOptions.target.field,
	          meta: intentOptions.target.meta,
	        },
	        {
	          reason: intentOptions.action,
	          ttl: intentOptions.ttl,
	          queue: intentOptions.queue,
	        },
	      );
	      // With `queue`, the claim is only really *ours* once the server says
	      // so (`intent_acquired` if the target was free, `intent_granted` once
	      // we reach the head of the FIFO line). Block here on that grant so
	      // callers — chiefly `ablo.<model>.claim` — get a handle that already
	      // holds the lease, never a half-claimed one racing the queue.
	      if (intentOptions.queue) {
	        const ws = store.getSyncWebSocket();
	        if (ws) {
	          try {
	            await awaitIntentGrant(ws, claim.id, {
	              timeoutMs: intentOptions.waitTimeoutMs,
	              maxQueueDepth: intentOptions.maxQueueDepth,
	            });
	          } catch (err) {
	            // Gave up waiting (queue too deep, timed out, or lost) — abandon
	            // the queued intent so we don't leave a phantom entry in the
	            // line that would block or mislead other claimers.
	            claim.revoke();
	            throw err;
	          }
	        }
	      }
	      return wrapIntentHandle(claim);
	    },
	    list(target?: Partial<ModelTarget>): readonly ModelClaim[] {
	      return listModelClaims(target);
	    },
	    waitFor(target: Partial<ModelTarget>, options?: IntentWaitOptions): Promise<void> {
	      return waitForModelUnclaimed(target, options);
	    },
	  });

  // Build the typed proxy — one property per model. Done after publicIntents
  // exists so model clients can expose workflow helpers such as
  // `ablo.files.edit(...)` without importing protocol wiring.
  const modelProxies: Record<string, ModelOperations<unknown, unknown>> = {};
  for (const [schemaKey, modelDef] of Object.entries(schema.models)) {
    const registeredModelName = modelDef.typename ?? schemaKey;
    modelProxies[schemaKey] = createModelProxy(
      schemaKey,
      registeredModelName,
      objectPool,
      syncClient,
      modelRegistry,
      hydration,
      {
        createIntent: (intentOptions) => publicIntents.create(intentOptions),
        createSnapshot: (modelKey, id) =>
          createSnapshot({
            pool: objectPool,
            transport: store.getSyncWebSocket(),
            getLastSyncId: () =>
              store.getSyncWebSocket()?.getLastSyncId() ?? store.lastSyncId ?? 0,
            entities: { [modelKey]: id },
          }),
        queue: (target) =>
          publicIntents.queueFor({ type: target.model, id: target.id }),
        reorder: (target, order) =>
          publicIntents.reorder({ type: target.model, id: target.id }, order),
        observe: (target) => {
          // The live intent stream only tracks *open* (active) claims;
          // terminal states (committed / expired / canceled) drop out of
          // the list entirely — exactly the ephemeral coordination model.
          // So a present entry is, by definition, `status: 'active'`.
          const held = publicIntents.list({
            model: target.model,
            id: target.id,
          })[0];
          if (!held) return null;
          return {
            object: 'intent',
            id: held.id,
            status: 'active',
            target: {
              type: held.target.model,
              id: held.target.id,
              ...(held.target.path ? { path: held.target.path } : {}),
              ...(held.target.range ? { range: held.target.range } : {}),
              ...(held.target.field ? { field: held.target.field } : {}),
              ...(held.target.meta ? { meta: held.target.meta } : {}),
            },
            action: held.action,
            heldBy: held.actor,
            participantKind: held.participantKind,
            expiresAt: held.expiresAt,
          };
        },
        waitFor: (target, waitOptions) =>
          publicIntents.waitFor(
            { model: target.model, id: target.id },
            waitOptions,
          ),
        selfParticipantId: participantId,
      },
    );
  }

	  const commits: CommitResource = {
	    async create(commitOptions: CommitCreateOptions): Promise<CommitReceipt> {
	      await ready();
	      const clientTxId = createClientTxId(commitOptions.idempotencyKey);
	      const operations = normalizeCommitOperations(commitOptions);
	      const wait = commitOptions.wait ?? 'confirmed';
	      const intentId = normalizeIntentId(commitOptions.intent);
	      void intentId; // The current wire clears intents by entity after commit.

	      // Route through the TransactionQueue's commit lane so the call
	      // tolerates WS disconnects: the envelope stays in memory until
	      // reconnect, mutationExecutor.commit() owns transport-level
	      // retry, and `mutation_log` server-side dedupes replays by
	      // clientTxId. Replaces the direct ws.sendCommit /
	      // sendCommitQueued path that threw synchronously on
	      // `ws.readyState !== OPEN`. The queue lives on the internal
	      // SyncClient we already hold from createInternalComponents —
	      // no need to leak an accessor through BaseSyncedStore.
	      const queue = syncClient.getTransactionQueue();
	      queue.enqueueCommit(clientTxId, operations, {
	        causedByTaskId: activeTurnId,
	      });

	      if (wait === 'queued') {
	        return { id: clientTxId, status: 'queued' };
	      }

	      const { lastSyncId } = await queue.waitForCommitReceipt(clientTxId);
	      return { id: clientTxId, status: 'confirmed', lastSyncId };
	    },
	  };

	  async function retrieveModel<T>(
	    modelName: string,
	    id: string,
	    options?: ModelReadOptions,
	  ): Promise<ModelRead<T>> {
	    await applyClaimedPolicy({ model: modelName, id }, options);
	    await ready();
	    const res = await fetchImpl(`${bootstrapHelper.baseUrl}/sync/query`, {
	      method: 'POST',
	      headers: authHeaders(),
	      body: JSON.stringify({
	        queries: [
	          {
	            model: modelName,
	            where: [['id', '=', id]],
	            limit: 1,
	          },
	        ],
	      }),
	    });
	    const bodyText = await res.text();
	    let body: unknown = bodyText;
	    if (bodyText.length > 0) {
	      try {
	        body = JSON.parse(bodyText);
	      } catch {
	        // Keep raw body text.
	      }
	    }
	    if (!res.ok) {
	      throw translateHttpError(
	        res.status,
	        body || `Model retrieve failed: ${res.status} ${res.statusText}`,
	        res.headers.get('x-request-id') ?? undefined,
	      );
	    }
	    const parsed = body as { results?: unknown[]; lastSyncId?: number };
	    const slot = parsed.results?.[0];
	    const rows = Array.isArray(slot) ? slot : [];
	    const data = rows[0] as T | undefined;
	    if (!data) {
	      throw new AbloValidationError(
	        `Model row not found: ${modelName}/${id}`,
	        { code: 'model_not_found' },
	      );
	    }
	    const stamp =
	      typeof parsed.lastSyncId === 'number'
	        ? parsed.lastSyncId
	        : store.getSyncWebSocket()?.getLastSyncId() ?? store.lastSyncId ?? 0;
	    return {
	      data,
	      stamp,
	      claims: listModelClaims({ model: modelName, id }),
	    };
	  }

	  function model<T = Record<string, unknown>>(name: string): ModelClient<T> {
	    return {
	      retrieve(params: ModelReadOptions & { readonly id: string }): Promise<ModelRead<T>> {
	        return retrieveModel<T>(name, params.id, params);
	      },
	      async create(
	        params: ModelMutationOptions & { readonly data: Record<string, unknown>; readonly id?: string | null },
	      ): Promise<CommitReceipt> {
	        const id = params.id ?? createModelId();
	        await applyClaimedPolicy({ model: name, id }, params);
	        return commits.create({
	          intent: params.intent,
	          idempotencyKey: params.idempotencyKey,
	          readAt: params.readAt,
	          onStale: params.onStale,
	          wait: params.wait,
	          operations: [
	            {
	              action: 'create',
	              model: name,
	              id,
	              data: params.data,
	            },
	          ],
	        });
	      },
	      async update(
	        params: ModelMutationOptions & { readonly id: string; readonly data: Record<string, unknown> },
	      ): Promise<CommitReceipt> {
	        await applyClaimedPolicy({ model: name, id: params.id }, params);
	        return commits.create({
	          intent: params.intent,
	          idempotencyKey: params.idempotencyKey,
	          readAt: params.readAt,
	          onStale: params.onStale,
	          wait: params.wait,
	          operations: [
	            {
	              action: 'update',
	              model: name,
	              id: params.id,
	              data: params.data,
	            },
	          ],
	        });
	      },
	      async delete(
	        params: ModelMutationOptions & { readonly id: string },
	      ): Promise<CommitReceipt> {
	        await applyClaimedPolicy({ model: name, id: params.id }, params);
	        return commits.create({
	          intent: params.intent,
	          idempotencyKey: params.idempotencyKey,
	          readAt: params.readAt,
	          onStale: params.onStale,
	          wait: params.wait,
	          operations: [
	            {
	              action: 'delete',
	              model: name,
	              id: params.id,
	            },
	          ],
	        });
	      },
	    };
	  }

	  const engine = {
    ...modelProxies,

    ready,
    waitForFlush,

    setAuthToken(token: string) {
      // The single credential source is read lazily by bootstrap HTTP,
      // lazy query HTTP, network probes, and WebSocket reconnect URL auth.
      // Updating it here is enough for the next request/connect to use the
      // refreshed token; no per-transport patching.
      authCredentials.setAuthToken(token);
      // A fresh credential is useless to a connection parked in offline /
      // backoff / auth_blocked until the next probe trigger — so kick one now.
      // Harmless while connected (the FSM ignores the nudge there).
      store.nudgeReconnect();
    },

    async getAuthToken(): Promise<string | null> {
      // The live short-lived bearer (set via `setAuthToken`/`getToken` refresh)
      // is the canonical credential; fall back to a configured API key.
      return (
        authCredentials.getAuthToken() ??
        (await resolveApiKeyValue(configuredApiKey)) ??
        configuredAuthToken ??
        null
      );
    },

    setCredentialRefresher(refresher: (() => Promise<string | null>) | null) {
      store.setCredentialRefresher(refresher);
    },

    nudgeReconnect() {
      store.nudgeReconnect();
    },

    sessions: {
      // Stripe `ephemeralKeys.create` shape: a BACKEND (holding `sk_`) mints a
      // short-lived scoped token for one end user OR one agent. Thin wrapper over
      // the `/auth/capability` exchange, reshaped to a Stripe-style resource.
      async create(params: CreateSessionParams<S>): Promise<AbloSession> {
        const apiKey = await resolveApiKeyValue(configuredApiKey);
        if (!apiKey) {
          throw new AbloAuthenticationError(
            'sessions.create requires a secret (sk_) API key — call it from your backend, not the browser.',
            { code: 'apikey_missing' },
          );
        }
        const baseUrl = resolveBootstrapBaseUrl({
          url,
          bootstrapBaseUrl: internalOptions.bootstrapBaseUrl,
        });
        // Discriminate the union: `{ user }` → full-authority `ek_` (no op
        // allowlist); `{ agent, can }` → scoped `rk_`. `can: { Task: ['update'] }`
        // serializes to the wire allowlist `['task.update']` — the Hub matches
        // `${model.toLowerCase()}.${op}` (Hub.ts handleCommit).
        let participantKind: 'user' | 'agent';
        let participantId: string;
        let operations: string[] | undefined;
        if (params.user) {
          participantKind = 'user';
          participantId = params.user.id;
          operations = undefined;
        } else {
          participantKind = 'agent';
          participantId = params.agent.id;
          operations = Object.entries(params.can).flatMap(([model, ops]) =>
            (ops ?? []).map((op) => `${model.toLowerCase()}.${op}`),
          );
        }
        const res = await exchangeApiKey({
          apiKey,
          baseUrl,
          participantKind,
          participantId,
          ...(params.syncGroups ? { syncGroups: [...params.syncGroups] } : {}),
          ...(operations ? { operations } : {}),
          ttlSeconds: params.ttlSeconds ?? 900,
          ...(params.userMeta ? { userMeta: params.userMeta } : {}),
          ...(internalOptions.fetch ? { fetch: internalOptions.fetch } : {}),
        });
        return {
          object: 'session',
          id: res.capabilityId,
          token: res.token,
          expiresAt: res.expiresAt,
          organizationId: res.organizationId,
          scope: res.scope,
          userMeta: res.userMeta,
        };
      },
    },

    async dispose() {
      _refreshScheduler?.dispose();
      _refreshScheduler = null;
      try {
        await store.disconnect();
      } catch (err) {
        logger.warn('Error during sync engine disposal', { error: (err as Error).message });
      }
      presenceStream.dispose();
      intentStream.dispose();
      syncClient.dispose();
    },

    /**
     * Destroy every IndexedDB database owned by this engine. Disconnects
     * the WebSocket, releases timers, and deletes all `ablo_*` / `ablo-*`
     * databases. Typically called on session expiry or explicit logout.
     * Best-effort — errors from individual deletions are swallowed.
     */
    async purge() {
      await store.purge();
      syncClient.dispose();
    },

    /**
     * Subscribe to session-error events. Fires when the server rejects
     * the session (WebSocket close code 1008/4001/4003 or a session_error
     * frame). Multiple subscribers supported; returns an unsubscribe
     * function. Consumers typically use this to trigger auth-failed UI
     * flows (e.g., redirect to sign-in). Does NOT automatically purge the
     * IndexedDB — call `engine.purge()` from the listener if you need
     * that behavior (the SDK's `<AbloProvider>` does this by default).
     */
    onSessionError(listener: (error: Error) => void) {
      return store.subscribeSessionError(listener);
    },

    onMutationFailure(
      listener: (payload: {
        transaction: import('../transactions/TransactionQueue.js').Transaction;
        error: Error;
        permanent?: boolean;
      }) => void,
    ) {
      return store.subscribeMutationFailure(listener);
    },

    waitForConfirmation(modelName: string, modelId: string) {
      return store.waitForConfirmation(modelName, modelId);
    },

    // Expose the store's MobX observable directly — single source of truth.
    // React components using observer() will re-render automatically on
    // any state change (syncing, error, offline, pendingChanges, progress).
    get syncStatus() {
      return store.syncStatus;
    },

    schema,

    // ── Internal accessors for framework integration ─────────────────
    // These expose internal components for consumers that need direct
    // access (e.g., SyncEngineProvider wiring SyncContext, collaboration
    // events accessing the WebSocket handle, demand loaders accessing
    // the pool). Prefixed with _ to signal "internal but stable."

    /** The BaseSyncedStore — implements SyncStoreContract for SyncContext.Provider. */
    get _store() { return store; },

    /** The ObjectPool — for demand loaders that need pool.createFromData(). */
    get _pool() { return objectPool; },

    /** The SyncWebSocket — for collaboration events (slide selection, cursors). */
    get _ws() { return store.getSyncWebSocket() ?? null; },

    /** Presence livestream — same socket as entity sync, no second
     *  connection. Stable reference across the engine's lifetime. */
    presence: presenceStream,

	    /** Intent livestream — same socket. Stable reference. */
	    intents: publicIntents,

	    commits,

	    model,

	    /** Structured multiplayer participation — target-first, no
     *  sync-group strings in the common path. */
    participants: participantManager,

    /** Context-staleness snapshot — see `engine.snapshot(...)` JSDoc. */
    snapshot<ModelName extends keyof S & string>(
      entities: { readonly [M in ModelName]: string | readonly string[] },
    ): Snapshot<Schema<S>, ModelName> {
      return createSnapshot<Schema<S>, ModelName>({
        pool: objectPool,
        transport: store.getSyncWebSocket(),
        getLastSyncId: () =>
          store.getSyncWebSocket()?.getLastSyncId() ?? store.lastSyncId ?? 0,
        entities,
      });
    },

    // ── Turn handles ────────────────────────────────────────────────
    //
    // Open a turn — every commit issued while the returned handle is
    // alive carries `caused_by_task_id` on the wire so the server
    // stamps it onto each delta. The product surface this powers:
    // `agent_tasks` audit trails ("which AI prompt produced this
    // mutation"), parent/child turn chains, cost accounting per turn.
    //
    // POST /api/agent/turn (capability bearer) → returns turnId.
    // POST /api/agent/turn/:id/close (capability bearer) → records
    //   final cost stats. Idempotent.
    async beginTurn(beginOptions: {
      readonly prompt: string;
      readonly parentTaskId?: string;
      readonly surface?: string;
      readonly metadata?: Record<string, unknown>;
    }): Promise<{
      readonly turnId: string;
      close(stats?: {
        readonly costInputTokens?: number;
        readonly costOutputTokens?: number;
        readonly costComputeMs?: number;
      }): Promise<void>;
      dispose(): void;
      [Symbol.asyncDispose](): Promise<void>;
    }> {
	      const baseUrl = url.replace(/\/+$/, '');
	      const turnUrl = `${baseUrl.replace(/^ws/, 'http')}/api/agent/turn`;
	      const headers = authCredentials.withAuthHeaders({ 'Content-Type': 'application/json' });
      const res = await fetch(turnUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          prompt: beginOptions.prompt,
          parentTaskId: beginOptions.parentTaskId,
          surface: beginOptions.surface,
          metadata: beginOptions.metadata,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let parsed: unknown = text;
        if (text) {
          try {
            parsed = JSON.parse(text);
          } catch {
            /* keep raw text */
          }
        }
        // Preserve the server's structured envelope (code/message/doc_url) when
        // present; fall back to turn_open_failed for a bare/non-Ablo body.
        throw hasWireCode(parsed)
          ? translateHttpError(
              res.status,
              parsed,
              res.headers.get('x-request-id') ?? undefined,
            )
          : new AbloError(`beginTurn failed: ${res.status} ${text}`, {
              code: 'turn_open_failed',
              httpStatus: res.status,
            });
      }
      const json = (await res.json()) as { turnId: string };
      const turnId = json.turnId;
      activeTurnId = turnId;

      let closed = false;
      const close = async (stats?: {
        readonly costInputTokens?: number;
        readonly costOutputTokens?: number;
        readonly costComputeMs?: number;
      }): Promise<void> => {
        if (closed) return;
        closed = true;
        if (activeTurnId === turnId) activeTurnId = null;
        const closeUrl = `${turnUrl}/${encodeURIComponent(turnId)}/close`;
        const closeRes = await fetch(closeUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            costInputTokens: stats?.costInputTokens ?? 0,
            costOutputTokens: stats?.costOutputTokens ?? 0,
            costComputeMs: stats?.costComputeMs ?? 0,
          }),
        });
        if (!closeRes.ok) {
          const text = await closeRes.text().catch(() => '');
          let parsed: unknown = text;
          if (text) {
            try {
              parsed = JSON.parse(text);
            } catch {
              /* keep raw text */
            }
          }
          throw hasWireCode(parsed)
            ? translateHttpError(
                closeRes.status,
                parsed,
                closeRes.headers.get('x-request-id') ?? undefined,
              )
            : new AbloError(`closeTurn failed: ${closeRes.status} ${text}`, {
                code: 'turn_close_failed',
                httpStatus: closeRes.status,
              });
        }
      };
      const dispose = (): void => {
        if (closed) return;
        closed = true;
        if (activeTurnId === turnId) activeTurnId = null;
      };
      return { turnId, close, dispose, [Symbol.asyncDispose]: () => close() };
    },
  } as Ablo<S>;

  return engine;
}

// ─────────────────────────────────────────────────────────────────────
//  Ablo namespace — type access via `Ablo.X` for the modern SDK shape
// ─────────────────────────────────────────────────────────────────────
//
// Stripe, Anthropic, OpenAI, Cursor: one default import, types hung
// underneath via namespace dots. `import Ablo from "@abloatai/ablo"`
// gets the factory, the return type, AND every type a typical consumer
// references (`Ablo.Peer`, `Ablo.Snapshot<S, K>`, etc.) — all
// purely type-level (zero runtime).
//
// Types still live in their canonical homes (`types/streams`,
// `principal`, this file). The namespace re-exports them as a
// convenience path. Named imports continue to work for callers who
// prefer them.

import type * as _Streams from '../types/streams.js';
import type * as _Participants from '../sync/participants.js';
import type * as _Policy from '../policy/types.js';
import type * as _Mutators from '../mutators/defineMutators.js';
import type * as _Tx from '../mutators/Transaction.js';
import type * as _Undo from '../mutators/UndoManager.js';
import type * as _Query from '../query/types.js';
import type * as _SchemaTypes from '../schema/schema.js';
import type * as _Base from '../BaseSyncedStore.js';
import type * as _Lazy from '../LazyReferenceCollection.js';
import type * as _Probe from '../sync/NetworkProbe.js';
import type * as _Conn from '../sync/ConnectionManager.js';
import type * as _Global from '../types/global.js';

/**
 * Canonical type namespace.
 *
 * Locked rules — apply uniformly to every future addition:
 *
 *   1. Flat by default.    `Ablo.X`. Fewest dots wins.
 *   2. Sub-namespace ONLY when (a) 4+ types share a single conceptual
 *      prefix, AND (b) names read better with the prefix (`Conflict.Kind`
 *      over `ConflictKind`). If the cluster is heterogeneous (streams +
 *      data + handles), keep flat.
 *   3. Only types a consumer would write `: Ablo.X` for. Inferred-only
 *      types stay un-exported.
 *   4. Wire shapes never on `Ablo.*`. Engine vocabulary only.
 *   5. Advanced / framework-integration types stay internal unless they
 *      graduate into one of the public subpaths.
 *
 * Anything not on this list stays internal.
 */
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Ablo {
  // ── Factory options ────────────────────────────────────────────────
  export type Options<S extends SchemaRecord = SchemaRecord> = AbloOptions<S>;
  export type Api = AbloApi;
  export type ApiIntents = AbloApiIntents;
  export type Agent = import('./ApiClient.js').Agent;
  export type AgentOptions = import('./ApiClient.js').AgentOptions;
  export type AgentRunOptions = import('./ApiClient.js').AgentRunOptions;
  export type AgentRunStatus = import('./ApiClient.js').AgentRunStatus;
  export type AgentRunResult<T> = import('./ApiClient.js').AgentRunResult<T>;
  export type AgentRunContext = import('./ApiClient.js').AgentRunContext;
  export type AgentModelClient<T = Record<string, unknown>> =
    import('./ApiClient.js').AgentModelClient<T>;
  export type AgentModelReadOptions =
    import('./ApiClient.js').AgentModelReadOptions;
  export type AgentModelMutationOptions =
    import('./ApiClient.js').AgentModelMutationOptions;
  export type AgentIntentOptions = import('./ApiClient.js').AgentIntentOptions;
  export type AgentIntentInput = import('./ApiClient.js').AgentIntentInput;
  export type Capability = import('./ApiClient.js').Capability;
  export type CapabilityCreateOptions = import('./ApiClient.js').CapabilityCreateOptions;
  export type CapabilityRecord = import('./ApiClient.js').CapabilityRecord;
  export type CapabilityResource = import('./ApiClient.js').CapabilityResource;
  export type CapabilityRevocation = import('./ApiClient.js').CapabilityRevocation;
  export type CapabilityRotateOptions = import('./ApiClient.js').CapabilityRotateOptions;
  export type RotatedCapability = import('./ApiClient.js').RotatedCapability;
  export type Task = import('./ApiClient.js').Task;
  export type TaskCreateOptions = import('./ApiClient.js').TaskCreateOptions;
  export type TaskCloseOptions = import('./ApiClient.js').TaskCloseOptions;
  export type TaskCloseResult = import('./ApiClient.js').TaskCloseResult;
  export type TaskResource = import('./ApiClient.js').TaskResource;
  // Claimed-state options stay flat — same concept reused by claims and models.
  export type IfClaimedPolicy = import('./Ablo.js').IfClaimedPolicy;
  export type ClaimedOptions = import('./Ablo.js').ClaimedOptions;

  // ── Entity pointers (flat — input shapes used everywhere) ─────────
  export type EntityRef = _Streams.EntityRef;
  export type PresenceTarget = _Streams.PresenceTarget;
  export type TargetRange = _Streams.TargetRange;
  export type Duration = _Streams.Duration;

  // ── Real-time multiplayer (flat — heterogeneous cluster) ──────────
  export type PresenceStream = _Streams.PresenceStream;
  export type IntentStream = _Streams.IntentStream;
  export type Peer = _Streams.Peer;
  export type Activity = _Streams.Activity;
  export type ActiveIntent = _Streams.ActiveIntent;
  export type Claim = _Streams.Claim;
  export type IntentRejection = _Streams.IntentRejection;
  export type IntentLost = _Streams.IntentLost;

  // ── Singletons (flat — no cohort) ─────────────────────────────────
  export type Snapshot<
    TSchema extends _SchemaTypes.Schema = _SchemaTypes.Schema,
    K extends keyof TSchema['models'] = keyof TSchema['models'],
  > = _Streams.Snapshot<TSchema, K>;
  export type Turn = import('./Ablo.js').Turn;

  // ── Auth (sub-namespace — 4 names, shared concept) ────────────────
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Auth {
    export type Principal = _Streams.Principal;
    export type Session = _Streams.SessionRef;
    export type Agent = _Streams.AgentRef;
    export type Actor = _Streams.ParticipantRef;
  }

  // ── Participant (sub-namespace — 5 names, shared concept) ─────────
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Participant {
    export type Manager = _Participants.ParticipantManager;
    export type Joined = _Participants.JoinedParticipant;
    export type Scope = _Participants.ParticipantScope;
    export type Status = _Participants.ParticipantStatus;
    export type JoinOptions = _Participants.ParticipantJoinOptions;
  }

  // ── Schema (type + sub-namespace via declaration merge) ───────────
  export type Schema<S extends _SchemaTypes.SchemaRecord = _SchemaTypes.SchemaRecord> = _SchemaTypes.Schema<S>;
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Schema {
    export type InferModel<
      S extends _SchemaTypes.Schema,
      K extends keyof S['models'],
    > = _SchemaTypes.InferModel<S, K>;
    export type InferCreate<
      S extends _SchemaTypes.Schema,
      K extends keyof S['models'],
    > = _SchemaTypes.InferCreate<S, K>;
    export type InferModelNames<S extends _SchemaTypes.Schema> = _SchemaTypes.InferModelNames<S>;
  }

  // ── Conflict (type + sub-namespace via declaration merge) ─────────
  export type Conflict = _Policy.Conflict;
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Conflict {
    export type Kind = _Policy.ConflictKind;
    export type Operation = _Policy.ConflictOperation;
    export type Decision = _Policy.ConflictDecision;
    export type Policy = _Policy.ConflictPolicy;
  }

  // ── Commit (sub-namespace — write-side cohort) ────────────────────
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Commit {
    export type Wait = import('./Ablo.js').CommitWait;
    export type OperationAction = import('./Ablo.js').ModelOperationAction;
    export type OperationInput = import('./Ablo.js').CommitOperationInput;
    export type CreateOptions = import('./Ablo.js').CommitCreateOptions;
    export type Receipt = import('./Ablo.js').CommitReceipt;
    export type Client = import('./Ablo.js').CommitResource;
  }

  // ── Intent (sub-namespace — peer-claim cohort) ────────────────────
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Intent {
    export type Handle = import('./Ablo.js').IntentHandle;
    export type CreateOptions = import('./Ablo.js').IntentCreateOptions;
    export type WaitOptions = import('./Ablo.js').IntentWaitOptions;
    export type Client = import('./Ablo.js').IntentResource;
  }

  // ── Model (sub-namespace — typed-row read/write cohort) ───────────
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Model {
    export type Target = import('./Ablo.js').ModelTarget;
    export type Claim = import('./Ablo.js').ModelClaim;
    export type Read<T = Record<string, unknown>> = import('./Ablo.js').ModelRead<T>;
    export type Client<T = Record<string, unknown>> = import('./Ablo.js').ModelClient<T>;
    export type ReadOptions = import('./Ablo.js').ModelReadOptions;
    export type MutationOptions = import('./Ablo.js').ModelMutationOptions;
  }

  // ── Source (sub-namespace — customer-owned storage adapter) ──────
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Source {
    export type Operation = import('../source/index.js').SourceOperation;
    export type Event = import('../source/index.js').SourceEvent;
    export type EventForOperationOptions =
      import('../source/index.js').SourceEventForOperationOptions;
    export type EventsResult = import('../source/index.js').SourceEventsResult;
    export type Scope = import('../source/index.js').SourceScope;
    export type ApiKey = import('../source/index.js').SourceApiKey;
    export type Options<
      S extends _SchemaTypes.SchemaRecord = _SchemaTypes.SchemaRecord,
      TAuth = unknown,
    > = import('../source/index.js').AbloSourceOptions<S, TAuth>;
    export type ModelHandlers<
      Row,
      CreateInput,
      TAuth = unknown,
    > = import('../source/index.js').SourceModelHandlers<Row, CreateInput, TAuth>;
    export type SignatureVerificationResult =
      import('../source/index.js').SourceSignatureVerificationResult;

    // Commit sub-cohort — params/result pair.
    // eslint-disable-next-line @typescript-eslint/no-namespace
    export namespace Commit {
      export type Params<TAuth = unknown> =
        import('../source/index.js').SourceCommitParams<TAuth>;
      export type Result<Row = Record<string, unknown>> =
        import('../source/index.js').SourceCommitResult<Row>;
    }
  }

  // ── Mutator (sub-namespace — 5 names including undo) ──────────────
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Mutator {
    export type Fn<S extends _SchemaTypes.Schema, TArgs, TResult = void> =
      _Mutators.MutatorFn<S, TArgs, TResult>;
    export type Transaction<S extends _SchemaTypes.Schema> = _Tx.Transaction<S>;
    export type UndoEntry = _Undo.UndoEntry;
    export type UndoScope<S extends _SchemaTypes.Schema = _SchemaTypes.Schema> = _Undo.UndoScope<S>;
    export type InverseOp = _Undo.InverseOp;
  }
}
