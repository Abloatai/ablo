/**
 * `Ablo` — the one-call entry point to the sync engine client. It hides the
 * internal wiring — the object pool, local database, sync client, WebSocket,
 * bootstrap, and offline queue — behind a single function that returns a typed
 * client with one property per model in your schema.
 *
 * Usage:
 *   import { Ablo } from '@abloatai/ablo';
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

import type { Schema, SchemaRecord, InferModel, InferCreate, InferRow } from '../schema/schema.js';
import type {
  SyncEngineConfig,
  MutationExecutor,
} from '../interfaces/index.js';
import {
  durableCommitOperationSchema,
  type DurableCommitOperation,
} from '../transactions/commitEnvelope.js';
import { AbloAuthenticationError, AbloConnectionError, AbloValidationError, toAbloError, claimedError } from '../errors.js';
// `ModelTarget` (the model/id locator) and `ModelClaim` (the resolved claim
// view) are defined once in `../coordination/schema`, derived from a single zod
// schema so the typed client, the HTTP client, and the server share one
// definition rather than redeclaring it. Imported here for local use and
// re-exported so `ablo.ModelTarget` / `ablo.ModelClaim` stay stable.
import type { ModelTarget, ModelClaim } from '../coordination/schema.js';
export type { ModelTarget, ModelClaim };
import { initSyncEngine } from '../context.js';
import {
  noopObservability,
  browserOnlineStatus,
  defaultSessionErrorDetector,
  noopAnalytics,
} from '../SyncEngineContext.js';
import { alwaysOnline } from '../adapters/alwaysOnline.js';
import { validateAbloOptions } from './validateAbloOptions.js';
import { InstanceCache } from '../InstanceCache.js';
import type { SyncStoreContract } from '../react/context.js';
import type { SyncWebSocket } from '../sync/SyncWebSocket.js';
import { type RefreshScheduler } from '../auth/index.js';
import { mintSession } from './sessionMint.js';
import type { MintSessionContext } from './sessionMint.js';
import { createAuthCredentialSource } from '../auth/credentialSource.js';
import { createInternalComponents } from './createInternalComponents.js';
import { resolveParticipantIdentity } from './identity.js';
import { BaseSyncedStore, type SyncStatus } from '../BaseSyncedStore.js';
import type { DefaultCollaborationEvents } from '../sync/SyncWebSocket.js';
import { createPresenceStream } from '../sync/createPresenceStream.js';
import { createClaimStream } from '../sync/createClaimStream.js';
import { awaitClaimGrant } from '../sync/awaitClaimGrant.js';
import { createSnapshot } from '../sync/createSnapshot.js';
import { createParticipantManager } from '../sync/participants.js';
import type {
  ClaimWaitOptions,
  PresenceStream,
  Snapshot,
} from '../types/streams.js';
import type { Claim } from '../types/streams.js';
// Value import is cycle-safe: httpClient.js and httpTransport.js take the client
// types from the `options`/`resourceTypes` leaves, never from this module.
import {
  createAbloHttpClient,
  type AbloHttpClient,
  type AbloHttpClientOptions,
} from './httpClient.js';
import type { ApiKeySetter } from './auth.js';
import {
  assertBrowserSafety,
  readProcessEnv,
  resolveApiKey,
  resolveApiKeyValue,
  resolveAuthToken,
  resolveBaseURL,
  resolveBootstrapBaseUrl,
  rejectRemovedDatabaseUrlOption,
  warnIfCliKeyMismatch,
} from './auth.js';
import { shouldUseInMemoryPersistence } from './persistence.js';

// ── Supporting modules ────────────────────────────────────────────────────
// The option types, the shared resource-type surface, the schema-derived config,
// model registration, the default console logger, and the default WebSocket
// mutation executor each live in their own module. The two type-only modules
// (`options`, `resourceTypes`) carry no runtime imports, which lets the HTTP
// client and session-mint helpers reference the client types without importing
// this factory back and creating an import cycle. Everything is re-exported below
// so importers of `./Ablo.js` stay unchanged.
import type { AbloOptions, InternalAbloOptions } from './options.js';
import type {
  AbloSession,
  ClaimCreateOptions,
  ClaimResource,
  ClaimedOptions,
  CommitCreateOptions,
  CommitOperationInput,
  CommitReceipt,
  CommitResource,
  CreateAgentClientParams,
  CreateAgentSessionParams,
  CreateSessionParams,
} from './resourceTypes.js';
import { deriveConfigFromSchema } from './schemaConfig.js';
import { registerModelsFromSchema } from './modelRegistration.js';
import { createConsoleLogger, resolveLogLevel } from './consoleLogger.js';
import { createDefaultMutationExecutor } from './wsMutationExecutor.js';

export type { ApiKeySetter, AbloOptions, InternalAbloOptions } from './options.js';
export type {
  LocalCountOptions,
  LocalReadOptions,
  ModelListScope,
  ServerReadOptions,
  ModelRetrieveParams,
  ModelCreateParams,
  ModelUpdateParams,
  ModelDeleteParams,
  ClaimOptions,
  ClaimParams,
  ClaimLookupParams,
  ClaimReorderParams,
  Claim,
  ClaimHeartbeat,
  ClaimHeartbeatOptions,
  HeldClaim,
  HeldLease,
  ModelOperations,
  ModelOperationAction,
  CommitWait,
  IfClaimedPolicy,
  ClaimedOptions,
  ClaimWaitOptions,
  ModelReadOptions,
  ClaimCreateOptions,
  CommitOperationInput,
  CommitCreateOptions,
  CommitReceipt,
  CommitResource,
  ClaimResource,
  ModelMutationOptions,
  HttpClaimApi,
  SessionOperation,
  CreateUserSessionParams,
  CreateAgentSessionParams,
  CreateSessionParams,
  CreateAgentClientParams,
  AbloSession,
} from './resourceTypes.js';
export { computeFKDepthPriority } from './schemaConfig.js';

import type { ModelOperations } from './createModelProxy.js';
import { createModelProxy } from './createModelProxy.js';
import { assertWriteOptions } from './writeOptionsSchema.js';

/**
 * The reactive-read client a `useAblo` selector receives. The same surface as
 * {@link Ablo}, except model reads are typed as reactive rows
 * ({@link InferRow}: data fields + computeds, no relation accessors, no model
 * methods) — the shape a reactive read actually delivers after
 * `toReactiveSnapshot()`. Reading `row.layers` off a reactive read is a
 * compile error here instead of a silent runtime `undefined`; compose
 * relations through selectors or hooks that resolve the pool's instance.
 */
export type AbloReads<S extends SchemaRecord> = Omit<Ablo<S>, keyof S & string> & {
  readonly [K in keyof S & string]: ModelOperations<
    InferRow<Schema<S>, K>,
    InferCreate<Schema<S>, K>
  >;
};

/** The typed sync engine client — one property per model in the schema */
export type Ablo<S extends SchemaRecord> = {
  readonly [K in keyof S & string]: ModelOperations<
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- internal alias of the public Model<> type; kept for back-compat, no behavior difference
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
   * Replace the bearer token used for the WebSocket upgrade and HTTP requests,
   * without tearing down the engine. Use it to push a refreshed short-lived
   * access key (an `ek_` or `rk_`) before it expires — the client's `apiKey`
   * resolver refresh loop calls this for you. It reuses the same rotation path as
   * the internal capability-token refresh and is safe to call before `ready()`.
   * It also nudges a parked connection to re-probe with the new token.
   */
  setAuthToken(token: string): void;

  /**
   * Resolve the active bearer credential this engine authenticates with — the
   * live `ek_` or `rk_` the WebSocket and HTTP transports currently carry (kept
   * fresh by the `apiKey` resolver refresh loop), falling back to a configured
   * API key. Returns `null` when no credential is set yet. Use it to authenticate
   * a side-band request to the same server with the token this client already
   * holds, avoiding an extra mint round-trip.
   */
  getAuthToken(): Promise<string | null>;

  /**
   * Register a re-mint hook for the short-lived access key. The connection layer
   * calls it when it finds the key stale (a `credential_stale` probe) or on an
   * external nudge; the hook mints a fresh `ek_` or `rk_` from the still-valid
   * login. It follows the same contract as the `apiKey` resolver: resolve a
   * token, resolve `null` when the login itself is gone (which signs the user
   * out), or throw on a transient failure (which backs off without signing out).
   * The client wires this automatically from a function `apiKey`. Safe to call
   * before `ready()`.
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
   * Mint a short-lived, scoped session token for one end user. Call this on your
   * backend, where the `sk_` secret key lives, then hand the returned `token` to
   * that user's browser — typically through a token route the browser's `apiKey`
   * resolver fetches. The browser presents the token as its bearer, and the
   * server verifies it. The browser must never see the `sk_` key, only the
   * per-user session token.
   *
   * Pass `{ user: { id } }` for a full-authority end-user session, which mints an
   * `ek_` and attributes writes to a user (recorded as `actor_kind` on the delta
   * row). Pass `{ agent: { id }, can: { tasks: ['update'] } }` for a scoped agent
   * session, which mints an `rk_`; `can` is typed against your schema's model
   * names. This always authenticates with the original `sk_`, never the client's
   * exchanged sync credential.
   */
  sessions: {
    create(params: CreateSessionParams<S>): Promise<AbloSession>;
  };

  /**
   * Mint a scoped **agent identity** and return a ready-to-use client bound to
   * it — the `ablo.<resource>.<verb>` shape for the agent use case. One call
   * replaces `sessions.create({ agent })` + constructing a second
   * `Ablo({ apiKey: token })`:
   *
   * ```ts
   * const agent = await ablo.agents.create({
   *   name: 'researcher',                  // readable label (optional)
   *   can: { documents: ['read', 'update'] },
   *   // id omitted → a fresh uuid: a distinct, independent participant
   * });
   * await agent.documents.update({ id, data, claim });
   * await agent.dispose(); // when the agent is done
   * ```
   *
   * Server-side only: it requires the `sk_` secret key (like `sessions.create`)
   * and throws `AbloAuthenticationError` in the browser. The returned client
   * holds its own auto-refreshing `rk_`, so a long run never hits token expiry,
   * and the `sk_` never leaves this process. Each call is a distinct participant
   * by default (omit `id` for a fresh uuid), so even two agents sharing a `name`
   * queue behind one another on a contended row — `name` is display only and
   * never collapses identity. Humans don't get a server-built client; ship them a
   * token via `sessions.create({ user })`. If you need the raw token for
   * revocation, or a stable re-attachable id, use `sessions.create({ agent })`
   * or pass `id`.
   */
  agents: {
    create(params: CreateAgentClientParams<S>): Promise<Ablo<S>>;
  };

  /**
   * The organization this client resolved to — `null` until `ready()`
   * completes. Use it instead of scraping CLI output or hardcoding env vars:
   *
   * ```ts
   * await ablo.ready();
   * const org = ablo.organizationId; // 'org_…'
   * ```
   */
  readonly organizationId: string | null;

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
   * A real-time presence livestream — who else is connected on this engine's
   * sync groups, what they're doing, and a write surface for announcing this
   * user's own activity. It rides the engine's existing WebSocket; opening a
   * participant for presence does not open a second socket. See
   * {@link PresenceStream}.
   *
   * The reference is stable for the engine's lifetime — the underlying connection
   * is rotated on `dispose()`, but this object stays the same.
   */
  readonly presence: PresenceStream;

  /**
   * @internal The supported coordination API is `ablo.<model>.claim`. This
   * accessor is the internal stream that surface is built on and is not part of
   * the public API.
   *
   * A cooperative-mutex layer over presence — announce "I'm about to do X on Y"
   * so peers can yield before colliding. It uses the same socket as entity sync.
   */
  readonly claims: ClaimResource;

  /**
   * Canonical low-level mutation API. Every untyped model write compiles
   * down to `commits.create(...)`.
   */
  readonly commits: CommitResource;

  /**
   * Capture a context-staleness watermark over a set of entities.
   * Returns a flat snapshot with `stamp` (thread into writes as
   * `readAt`), `signal` (aborts on any captured-entity delta), and
   * `onChange` (callback form). Reads from the engine's InstanceCache;
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
    entities: Readonly<Record<ModelName, string | readonly string[]>>,
  ): Snapshot<Schema<S>, ModelName>;

  // ── Internal accessors for framework integration ─────────────────

  /**
   * The internal store. It implements {@link SyncStoreContract} — pass it to
   * `SyncContext.Provider` so the SDK's `useModel` / `useModels` / `useMutations`
   * hooks can reach it.
   */
  readonly _store: SyncStoreContract;

  /** The InstanceCache — for demand loaders and direct pool operations. */
  readonly _pool: InstanceCache;

  /**
   * The SyncWebSocket handle — for collaboration events (slide selection,
   * cursor broadcast). Null until the engine connects.
   */
  readonly _ws: SyncWebSocket | null;
};

// `readProcessEnv` lives in `./auth` alongside the other resolvers
// that read it. Re-exported there for use elsewhere in the file.

// ── Auth normalization ─────────────────────────────────────────────────────

/**
 * The single resolver the credential lifecycle needs: an async
 * `() => token | null`, or `null` when auth is static — a plain long-lived
 * `apiKey` string with no refresh, which is the common case.
 *
 * The short-lived per-user browser path passes a function `apiKey` (an
 * {@link ApiKeySetter}), and the SDK then drives the whole credential lifecycle
 * from it: mint-before-connect, the proactive refresh timer with its
 * wake/online/focus re-mint, and the reactive `credential_stale` re-mint. The
 * resolver follows the `ApiKeySetter` contract end to end: resolve a token,
 * resolve `null` when the login is gone (terminal — surfaces `session_expired`
 * and signs the user out), or throw on a transient failure (backs off, without
 * signing out).
 */
function resolveCredentialResolver(
  apiKey: string | ApiKeySetter | null,
): (() => Promise<string | null>) | null {
  if (typeof apiKey === 'function') return apiKey;
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
 *
 * In the browser (or any client that shouldn't hold a secret key), point
 * `authEndpoint` at your session-mint route instead — the SDK fetches it, keeps the
 * short-lived token fresh, and re-mints on expiry:
 *
 * ```ts
 * const ablo = Ablo({ schema, authEndpoint: '/api/ablo-session' });
 * ```
 *
 * Pass `transport: 'http'` for the stateless server-side client (agents,
 * workers, serverless) — same `ablo.<model>` surface, no socket:
 *
 * ```ts
 * const ablo = Ablo({ schema, apiKey: process.env.ABLO_API_KEY, transport: 'http' });
 * await ablo.tasks.update({ id, data: { status: 'done' } });
 * ```
 */
export function Ablo<const S extends SchemaRecord>(
  options: AbloHttpClientOptions<S> & { transport: 'http' },
): AbloHttpClient<S>;
export function Ablo<const S extends SchemaRecord>(
  options: AbloOptions<S>,
): Ablo<S>;
export function Ablo<const S extends SchemaRecord>(
  options: AbloOptions<S>,
): Ablo<S> | AbloHttpClient<S> {
  if (options.transport === 'http') {
    return createAbloHttpClient(options as AbloHttpClientOptions<S>);
  }

  const internalOptions = options as InternalAbloOptions<S>;
  const env = readProcessEnv();
  const authInput = { options, env };
  const configuredApiKey = resolveApiKey(authInput);
  const configuredAuthToken = resolveAuthToken(authInput);
  // The client owns its credential lifecycle (not the React layer): this resolver
  // drives both the reactive re-mint (the connection's `credential_stale` state)
  // and the proactive refresh timer with its wake/online/focus triggers. Null for
  // the common static `apiKey` path, which needs no refresh.
  const credentialResolver = resolveCredentialResolver(configuredApiKey);
  const authCredentials = createAuthCredentialSource(
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- load-bearing on the self-hosted path; server-internal cap-mint (Phase 3) not shipped
    internalOptions.capabilityToken ?? configuredAuthToken,
  );
  rejectRemovedDatabaseUrlOption(options);
  assertBrowserSafety({
    apiKey: configuredApiKey,
    dangerouslyAllowBrowser: options.dangerouslyAllowBrowser,
  });

  // Custom logger wins; otherwise build the default `[Ablo]` logger at the level
  // resolved from `debug`/`logLevel`/`ABLO_LOG_LEVEL` (default `warn`).
  const logger =
    internalOptions.logger ??
    createConsoleLogger(resolveLogLevel({ debug: options.debug, logLevel: options.logLevel }));
  void warnIfCliKeyMismatch(authInput, (m) => { logger.warn(m); });
  const schema = options.schema;
  const url = resolveBaseURL(authInput);

  // 1. Derive config from schema
  // 1. Derive config from schema, then layer caller-supplied overrides on top.
  //    `configOverrides` is a shallow merge: caller takes precedence per key.
  const config: SyncEngineConfig = {
    ...deriveConfigFromSchema(schema),
    ...internalOptions.configOverrides,
  };

  // 2. Create the mutation executor and dispatcher.
  //
  //    The default executor sends `{ type: 'commit', ... }` over the engine's
  //    WebSocket. The socket doesn't exist yet at this point (it's created later
  //    when the store initializes), so the default takes a lazy getter that
  //    resolves the live socket at commit time. `storeHolder` is captured by the
  //    closure and assigned below once the store is built — JS closures close
  //    over bindings, not values, so by the time the first commit fires the store
  //    is live.
  //
  //    Caller-supplied executors are still honored for advanced cases (test
  //    mocks, alternative transports), but apps should almost never need to
  //    override the transport.
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
  });

  // 4. Create internal components (user never sees these). See
  //    `./createInternalComponents.ts` for the construction order
  //    and what each component does. Model registration happens
  //    here (via `registerModelsFromSchema`, in `./modelRegistration.ts`)
  //    because the schema-to-Model-class translation is client-construction
  //    wiring that isn't worth pulling into the components module.
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
  // any consumer of `Ablo({ auth })`, not only those who render `<AbloProvider>`.
  // The first mint happens in `ready()` so the first connection carries a token.
  //
  // Long-lived server clients also get the pre-roll timer on windowless hosts
  // (`proactiveInNode`): their socket must renew its `rk_` or `ek_` before the
  // server's keepalive reaper closes it (4001 `credential_expired`). Two signals
  // qualify — an agent or system participant, and an absolute endpoint-string
  // `apiKey` (a relative one can't be fetched in Node, so an absolute URL is
  // unambiguously a deliberate server client). User-kind clients in Node (an
  // SSR/RSC module evaluating scaffolded browser code) stay reactive-only.
  if (credentialResolver) {
    const rawEndpoint = internalOptions.authEndpoint ?? internalOptions.apiKey;
    const absoluteEndpoint =
      typeof rawEndpoint === 'string' && /^https?:\/\//i.test(rawEndpoint);
    store.startCredentialLifecycle(credentialResolver, {
      /* eslint-disable @typescript-eslint/no-deprecated -- `kind` gates the self-hosted proactive pre-roll; hosted path derives it from the apiKey scope */
      proactiveInNode:
        internalOptions.kind === 'agent' ||
        internalOptions.kind === 'system' ||
        absoluteEndpoint,
      /* eslint-enable @typescript-eslint/no-deprecated */
    });
  }

  // Put the lazy-query lane on the same auth-recovery path as the WebSocket probe
  // and the proactive pre-roll: a 401 on `/sync/query` re-mints via the store's
  // single-flight lifecycle and replays once, instead of silently returning empty
  // rows against an expired `ek_` until the next proactive tick. Late-bound
  // because the coordinator is constructed before the store exists.
  hydration.setCredentialRecovery((recovery) => store.recoverFromAuthRejection(recovery));

  // Wire the store back into the default executor's lazy getter (see
  // `storeHolder` above). The executor was constructed before the store
  // existed; this late binding closes the loop so commits dispatch over
  // the engine's WebSocket once it opens.
  storeHolder.store = store;

  // Bind this executor to this client's TransactionQueue. Without it, the queue
  // resolves `mutationExecutor` from the module-level `getContext()`, which
  // `initSyncEngine()` overwrites on every client construction. In multi-client
  // flows (for example a worker plus a per-job peer) the second `initSyncEngine()`
  // call would silently redirect the first client's queue through the second
  // client's executor closure — and when the second client disposes, its
  // `storeHolder.store` becomes null, so the first client's commits start throwing
  // `ws_not_ready` forever.
  syncClient.getTransactionQueue().setMutationExecutor(executor);

  // Presence + claim streams — built eagerly so `engine.presence`
  // and `engine.claims` return the same reference for the engine's
  // lifetime. The transport doesn't exist yet (BaseSyncedStore.initialize
  // creates it during ready()), so both streams are constructed in
  // deferred-attach mode and wired after initialize() resolves below.
  // Calls before attach mutate local state but skip the wire send.
  // Identity routing: agents identify by agentId, users by user.id.
  // The server stamps `isAgent` on outbound presence frames from the
  // connection's authenticated identity prefix, but the local `self`
  // entry uses the kind we know at construction.
  const participantId =
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- self-hosted identity fallback; hosted path derives identity from the apiKey scope
    (internalOptions.kind === 'agent' ? internalOptions.agentId : internalOptions.user?.id) ?? '';
  const presenceStream = createPresenceStream({
    participantId,
    syncGroups: internalOptions.syncGroups ?? [],
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- local self-entry kind; server re-stamps isAgent from the authenticated identity
    isAgent: internalOptions.kind === 'agent',
  });
  const claimStream = createClaimStream({ participantId });
  const participantManager = createParticipantManager({
    ready,
    getTransport: () => store.getSyncWebSocket() ?? null,
    presence: presenceStream,
    claims: claimStream,
    schema,
  });

  // 6. Validate options up front — fail loudly on obviously wrong inputs so
  //    strangers don't get silent empty results. Validation errors are written
  //    into `store.syncStatus` (the single source of truth).
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- self-hosted default; hosted path ignores it (server derives kind from the apiKey scope)
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

  // Deprecated identity overrides are a silent no-op under hosted cloud: when an
  // `apiKey` is configured the SERVER derives participant kind + id from the
  // key's scope, so `kind` / `agentId` passed here are ignored. Setting them and
  // trusting them is the trap (you think you're an agent; the key says user).
  // Warn loudly rather than removing the fields — `agentId` is still load-bearing
  // on the self-hosted path (no apiKey; paired with `capabilityToken`).
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- reads the deprecated fields precisely to warn callers off them under a configured apiKey
  if (configuredApiKey && (internalOptions.kind || internalOptions.agentId)) {
    logger.warn(
      'Ablo: `kind` / `agentId` are ignored when an `apiKey` is configured — ' +
        'the server derives participant identity from the key’s scope. Remove ' +
        'them (or mint a scoped session via `ablo.sessions.create({ agent })` ' +
        'for a distinct agent identity). They apply only to the self-hosted ' +
        '`capabilityToken` path.',
    );
  }

  // 7. The ready() promise drives the BaseSyncedStore.initialize() generator
  //    to completion. First call kicks off the initialization; subsequent
  //    calls return the same promise (idempotent).
  //
  //    Status is tracked in store.syncStatus (MobX observable) — the single
  //    source of truth. No duplicate closure variables.
	  let _readyPromise: Promise<void> | null = null;
	  let _refreshScheduler: RefreshScheduler | null = null;
	  /** Resolved account scope — set once identity resolution completes in
	   *  `ready()`; exposed as the readonly `ablo.organizationId` accessor. */
	  let _resolvedOrganizationId: string | null = null;

  async function ready(): Promise<void> {
    if (_readyPromise) return _readyPromise;

    if (_validationError) {
      _readyPromise = Promise.reject(_validationError);
      return _readyPromise;
    }

    _readyPromise = (async () => {
      try {
        // Mint the first access credential before we connect, so the initial
        // WebSocket upgrade and bootstrap carry a valid bearer (no tokenless first
        // connect that has to self-heal). Only when a refreshing resolver is wired
        // and no static credential is already present. Follows the `apiKey`
        // resolver contract: `null` means the login is gone (terminal — fail ready
        // so the app shows sign-in); a throw means transient (rethrown; autoStart
        // swallows it and the lifecycle's online/wake triggers retry).
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

        // Resolve participant identity + scope. Three branches —
        // hosted-cloud apiKey exchange, self-derived from capability
        // token, or legacy explicit options. See `./identity.ts`.
        const resolved = await resolveParticipantIdentity({
          options: internalOptions,
          internalOptions,
          url,
          kind,
          configuredApiKey,
          // Resolve identity against the live token, not the construction-time
          // `configuredAuthToken`. Consumers using a function `apiKey` never pass
          // `authToken` at construction — the lifecycle mints the first `ek_` or
          // `rk_` and calls `setAuthToken()` before `ready()`, which updates the
          // shared credential source. Reading the frozen `configuredAuthToken`
          // here made `/auth/identity` fire with no bearer (returning
          // `no_matching_provider` / `session_expired`) even though the token was
          // present. This reads the shared credential source, like every other
          // transport.
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
	        // resolved" state before opening the socket. It is the same class of bug as
	        // a
	        // sensible-looking default that's functionally broken: the
	        // SDK ends up subscribing only to the server-side
	        // `['default']` fallback, no
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
	          // Actionable and not self-healing (no live updates until fixed):
	          // kept at warn level for consumers; the low-level diagnostic
	          // fields ride the debug log below.
	          logger.warn(
	            'This client was started without sync groups, so it will not receive ' +
	              'live updates. Pass `syncGroups` (for example ' +
	              '`["org:<id>", "user:<id>"]`) or check that your auth provider supplies them.',
	          );
	          logger.debug('degenerate syncGroups — details', { participantKind, resolvedSyncGroups });
	        }

        _resolvedOrganizationId = accountScope;

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

        // Wire presence + claims to the now-open transport.
        // `getSyncWebSocket()` returns non-null after a successful
        // initialize() — the WS is created during the generator's
        // connect step.
        const ws = store.getSyncWebSocket();
        if (ws) {
          presenceStream.attach(ws);
          claimStream.attach(ws);
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
        // Clear the memo so a future `ready()` re-attempts bootstrap instead of
        // replaying this rejection forever. Bootstrap failures here are transient
        // by nature — offline, an IndexedDB open timeout, a bootstrap fetch
        // hiccup — and the early `if (_readyPromise) return _readyPromise` guard
        // would otherwise hand every later caller this same dead promise, bricking
        // the engine until a full page reload. Nulling it lets the provider's
        // online/wake/retry triggers drive a clean re-bootstrap. (The terminal
        // `_validationError` branch above intentionally stays cached — config
        // can't change without recreating the engine.)
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

	  function createClientTxId(idempotencyKey?: string | null): string {
	    if (idempotencyKey && idempotencyKey.length > 0) return idempotencyKey;
	    return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
	      ? crypto.randomUUID()
	      : `tx_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
	  }

	  function normalizeCommitOperation(
	    op: CommitOperationInput,
	    defaults: Pick<CommitCreateOptions, 'readAt' | 'onStale'>,
	    fenceToken?: number | null,
	  ): DurableCommitOperation {
	    const type = op.action.toUpperCase();
	    const id = op.id ?? '';
	    return durableCommitOperationSchema.parse({
	      type,
	      model: op.model.toLowerCase(),
	      id,
	      input: op.data ?? undefined,
	      transactionId: op.transactionId ?? undefined,
	      readAt: op.readAt ?? defaults.readAt ?? undefined,
	      onStale: op.onStale ?? defaults.onStale ?? undefined,
	      // The batch's claim (if any) supplies one token for every op, mirroring
	      // how it supplies the batch `readAt`.
	      fenceToken: op.fenceToken ?? fenceToken ?? undefined,
	    });
	  }

	  function normalizeCommitOperations(
	    commitOptions: CommitCreateOptions,
	    fenceToken?: number | null,
	  ): DurableCommitOperation[] {
	    if (commitOptions.operations.length === 0) {
	      throw new AbloValidationError(
	        'Commit requires a non-empty `operations` array.',
	        { code: 'commit_operation_required' },
	      );
	    }
	    return commitOptions.operations.map((op) =>
	      normalizeCommitOperation(op, commitOptions, fenceToken),
	    );
	  }

	  function modelClaimFromActive(claim: Claim): ModelClaim {
	    return {
	      id: claim.id,
	      actor: claim.heldBy ?? "",
	      participantKind: claim.participantKind ?? "user",
	      description: claim.description,
	      field: claim.target.field,
	      status: 'active',
	      expiresAt: claim.expiresAt ?? 0,
	      target: {
	        model: claim.target.type,
	        id: claim.target.id,
	        path: claim.target.path,
	        range: claim.target.range,
	        field: claim.target.field,
	        meta: claim.target.meta,
	      },
	    };
	  }

	  function targetMatchesModel(
	    target: { readonly model?: string; readonly id?: string; readonly field?: string },
	    claim: Claim,
	  ): boolean {
	    if (
	      target.model &&
	      claim.target.type.toLowerCase() !== target.model.toLowerCase()
	    ) {
	      return false;
	    }
	    if (target.id && claim.target.id !== target.id) return false;
	    if (target.field && claim.target.field !== target.field) return false;
	    return true;
	  }

	  function listModelClaims(target?: Partial<ModelTarget>): readonly ModelClaim[] {
	    return claimStream.others
	      .filter((claim) => (target ? targetMatchesModel(target, claim) : true))
	      .map(modelClaimFromActive);
	  }

	  function waitForModelUnclaimed(
	    target: Partial<ModelTarget>,
	    options?: ClaimWaitOptions,
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
	          { reject(
	            new AbloConnectionError('Claim wait aborted.', {
	              code: 'claim_wait_aborted',
	              cause: options?.signal?.reason,
	            }),
	          ); },
	        );
	      };

	      if (options?.signal?.aborted) {
	        onAbort();
	        return;
	      }

	      unsubscribe = claimStream.onChange(check);
	      options?.signal?.addEventListener('abort', onAbort, { once: true });

	      if (options?.timeout != null) {
	        timeoutId = setTimeout(() => {
	          finish(() =>
	            { reject(
	              claimedError(
	                target,
	                listModelClaims(target),
	                'model_claimed_timeout',
	              ),
	            ); },
	          );
	        }, options.timeout);
	      }
	    });
	  }

	  function wrapClaimHandle(
	    claim: Claim,
	    waited = false,
	    fenceToken?: number,
	  ): Claim {
	    const release = async (): Promise<void> => {
	      claim.revoke?.();
	    };
	    // The token is server-stamped and arrives on the grant frame, so prefer
	    // the one `awaitClaimGrant` read there; fall back to any the local handle
	    // already carried (immediate, non-queued grants).
	    const resolvedFenceToken = fenceToken ?? claim.fenceToken;
	    return {
	      object: 'claim',
	      id: claim.id,
	      description: claim.description,
	      target: claim.target,
	      waited,
	      ...(resolvedFenceToken !== undefined ? { fenceToken: resolvedFenceToken } : {}),
	      release,
	      revoke: claim.revoke,
	      // The lease-control members are forwarded explicitly — this wrapper
	      // rebuilds the handle field by field, so anything not named here is
	      // silently dropped from the public claim.
	      heartbeat: claim.heartbeat,
	      [Symbol.asyncDispose]: release,
	    };
	  }

	  const publicClaims: ClaimResource = Object.assign(claimStream, {
	    async create(claimOptions: ClaimCreateOptions): Promise<Claim> {
	      await ready();
	      const claim = claimStream.claim(
	        {
	          type: claimOptions.target.model,
	          id: claimOptions.target.id,
	          path: claimOptions.target.path,
	          range: claimOptions.target.range,
	          field: claimOptions.target.field,
	          meta: claimOptions.target.meta,
	        },
	        {
	          description: claimOptions.description,
	          ttl: claimOptions.ttl,
	          queue: claimOptions.queue,
	        },
	      );
	      // With `queue`, the claim is only really *ours* once the server says
	      // so (`claim_acquired` if the target was free, `claim_granted` once
	      // we reach the head of the FIFO line). Block here on that grant so
	      // callers — chiefly `ablo.<model>.claim` — get a handle that already
	      // holds the lease, never a half-claimed one racing the queue.
	      let waited = false;
	      let fenceToken: number | undefined;
	      if (claimOptions.queue) {
	        const ws = store.getSyncWebSocket();
	        if (ws) {
	          try {
	            ({ waited, fenceToken } = await awaitClaimGrant(ws, claim.id, {
	              timeoutMs: claimOptions.waitTimeoutMs,
	              maxQueueDepth: claimOptions.maxQueueDepth,
	            }));
	          } catch (err) {
	            // Gave up waiting (queue too deep, timed out, or lost) — abandon
	            // the queued claim so we don't leave a phantom entry in the
	            // line that would block or mislead other claimers.
	            claim.revoke?.();
	            throw err;
	          }
	        }
	      }
	      return wrapClaimHandle(claim, waited, fenceToken);
	    },
	    list(target?: Partial<ModelTarget>): readonly ModelClaim[] {
	      return listModelClaims(target);
	    },
	    waitFor(target: Partial<ModelTarget>, options?: ClaimWaitOptions): Promise<void> {
	      return waitForModelUnclaimed(target, options);
	    },
	  });

  // Build the typed proxy — one property per model. Done after publicClaims
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
        createClaim: (claimOptions) => publicClaims.create(claimOptions),
        createSnapshot: (modelKey, id) =>
          createSnapshot({
            pool: objectPool,
            transport: store.getSyncWebSocket(),
            // `position.readFloor` is the value claims and snapshots stamp as
            // `readAt` (max of the pool-applied cursor and the acked
            // watermark for our own writes — see sync/syncPosition.ts).
            // Stamping a bare stream cursor made a claim taken right after
            // an ack-confirmed write stale against that write's own delta.
            // The socket/store cursors are persistence-gated and therefore
            // never ahead of `applied` — no extra max() needed here.
            getLastSyncId: () => syncClient.position.readFloor,
            entities: { [modelKey]: id },
          }),
        queue: (target) =>
          publicClaims.queueFor({ type: target.model, id: target.id }),
        reorder: (target, order) =>
          { publicClaims.reorder({ type: target.model, id: target.id }, order); },
        state: (target) => {
          // The live claim stream only tracks *open* (active) claims;
          // terminal states (committed / expired / canceled) drop out of
          // the list entirely — exactly the ephemeral coordination model.
          // So a present entry is, by definition, `status: 'active'`.
          const held = publicClaims.list({
            model: target.model,
            id: target.id,
          })[0];
          if (!held) return null;
          return {
            object: 'claim',
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
            description: held.description ?? 'editing',
            heldBy: held.actor,
            participantKind: held.participantKind,
            expiresAt: held.expiresAt,
          };
        },
        waitFor: (target, waitOptions) =>
          publicClaims.waitFor(
            { model: target.model, id: target.id },
            waitOptions,
          ),
        selfParticipantId: participantId,
        selfParticipantKind: kind,
        // Read-interest / write-intent enrolment for the typed surface.
        // `enterScope`/`pinScope` resolve the `{ [schemaKey]: id }` scope
        // through the same resolver the claim path uses, landing this client in
        // the entity-scoped group the holder's claim presence fans out on.
        // Returns the store promise so the claim write path can await pinScope
        // before acquiring the lease (closing the subscribe-vs-broadcast race);
        // read-interest callers (`retrieve`/`claim.state`) still `void` it and
        // stay fire-and-forget. It's soft either way — the store swallows
        // reconcile errors so read interest never makes a read reject or stall.
        enterScope: (scope) => store.enterScope(scope),
        pinScope: (scope) => store.pinScope(scope),
        // `ablo.<model>.join(ids, { ttl })` performs a scoped participant join
        // on this model's sync group(s). WebSocket only — `join` throws
        // `AbloConnectionError` if the socket isn't ready.
        createJoin: (modelKey, ids, options) =>
          participantManager.join({
            scope: { [modelKey]: ids },
            ...(options?.ttl !== undefined ? { ttlSeconds: options.ttl } : {}),
          }),
      },
    );
  }

	  const commits: CommitResource = {
	    async create(commitOptions: CommitCreateOptions): Promise<CommitReceipt> {
	      await ready();
	      // Same runtime contract as the per-model writes — one schema.
	      assertWriteOptions(
	        {
	          idempotencyKey: commitOptions.idempotencyKey,
	          readAt: commitOptions.readAt,
	          onStale: commitOptions.onStale,
	          wait: commitOptions.wait,
	          claim: commitOptions.claim,
	        },
	        'commits.create',
	      );
	      const clientTxId = createClientTxId(commitOptions.idempotencyKey);
	      // A claim handle supplies the batch stale-guard defaults — same
	      // semantics as `ablo.<model>.update({ id, data, claim })`, so the
	      // two write doors speak one claim vocabulary. Explicit options win.
	      const claim = commitOptions.claim ?? null;
	      const operations = normalizeCommitOperations(
	        {
	          ...commitOptions,
	          readAt: commitOptions.readAt ?? claim?.readAt ?? null,
	          onStale:
	            commitOptions.onStale ?? (claim?.readAt !== undefined ? 'reject' : null),
	        },
	        claim?.fenceToken ?? null,
	      );
	      const wait = commitOptions.wait ?? 'confirmed';
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
	      await queue.enqueueCommit(clientTxId, operations, {
	        ...(commitOptions.reads ? { reads: [...commitOptions.reads] } : {}),
	        ...(commitOptions.track ? { track: [...commitOptions.track] } : {}),
	      });

	      if (wait === 'queued') {
	        return { id: clientTxId, status: 'queued' };
	      }

	      const { lastSyncId, notifications, missingIds } =
	        await queue.waitForCommitReceipt(clientTxId);
	      return {
	        id: clientTxId,
	        status: 'confirmed',
	        lastSyncId,
	        ...(notifications && notifications.length > 0 ? { notifications } : {}),
	        ...(missingIds && missingIds.length > 0 ? { missingIds } : {}),
	      };
	    },
	  };

	  /**
	   * The control-plane credential: always the original configured secret key.
	   * Never reads `authCredentials` — that holds the exchanged sync credential
	   * (a wide-scope `rk_` on the hosted path), which control-plane routes
	   * rightly refuse (e.g. the user-session mint is sk_-gated). Counterpart to
	   * `getAuthToken()`, which resolves the sync-plane token.
	   *
	   * The secret-key-only rule is enforced on the server; the credential-kind taxonomy
	   * (secret/restricted/ephemeral/publishable) lives in `auth/credentialPolicy`.
	   */
	  async function controlPlaneApiKey(): Promise<string | null> {
	    return resolveApiKeyValue(configuredApiKey);
	  }

	  /**
	   * Resolve the control-plane context a session/agent mint needs (sk_ +
	   * bootstrap base URL + the schema-key→typename map the server gates on).
	   * Shared by `sessions.create` and `agents.create` so the two mint doors
	   * can never drift on how a token is minted. Throws if no `sk_` is present —
	   * minting is a backend-only operation.
	   */
	  async function buildMintContext(resource: string): Promise<MintSessionContext> {
	    const apiKey = await controlPlaneApiKey();
	    if (!apiKey) {
	      throw new AbloAuthenticationError(
	        `${resource} requires a secret (sk_) API key — call it from your backend, not the browser.`,
	        { code: 'apikey_missing' },
	      );
	    }
	    return {
	      apiKey,
	      baseUrl: resolveBootstrapBaseUrl({
	        url,
	        bootstrapBaseUrl: internalOptions.bootstrapBaseUrl,
	      }),
	      ...(internalOptions.fetch ? { fetch: internalOptions.fetch } : {}),
	      // Map every `can` schema-key to the wire typename the server gates on, so a
	      // typename override (`documents` → `Document`) doesn't mint a capability
	      // the server then denies. See `MintSessionContext`.
	      modelTypenames: Object.fromEntries(
	        Object.entries(schema.models).map(([key, def]) => [
	          key,
	          (def).typename ?? key,
	        ]),
	      ),
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
      // The live short-lived bearer (set via `setAuthToken` / `apiKey`-resolver refresh)
      // is the canonical credential; fall back to a configured API key.
      //
      // This is the sync-plane token (bootstrap, WebSocket, query HTTP). Control-plane
      // calls (sessions.create, datasource registration) never use it — they
      // present the original secret key via `controlPlaneApiKey()` below. The
      // split matters: after the startup exchange this resolver returns the
      // derived wide-scope `rk_`, a credential the control-plane routes
      // correctly refuse (an agent token must never mint humans).
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

    // The org this client resolved to — null until `ready()` completes. Exposed
    // as a property so integrators can read it programmatically.
    get organizationId(): string | null {
      return _resolvedOrganizationId;
    },

    nudgeReconnect() {
      store.nudgeReconnect();
    },

    sessions: {
      // A backend (holding `sk_`) mints a short-lived scoped token for one end
      // user or one agent.
      //
      // Both arms authenticate with the original secret key
      // (`controlPlaneApiKey()`), never the wide-scope `rk_` the startup exchange
      // installed as the sync credential. A derived agent credential silently
      // replacing the secret key on control-plane calls is how humans would get
      // minted as agents — and correct attribution is the point.
      async create(params: CreateSessionParams<S>): Promise<AbloSession> {
        // Both mint paths (`{ user }` → /auth/ephemeral-keys → `ek_`,
        // `{ agent, can }` → /auth/capability → scoped `rk_`) resolve their
        // control-plane context through the shared `buildMintContext`, so this
        // client, `agents.create`, and the stateless HTTP client can't drift on
        // how a token is minted.
        return mintSession(params, await buildMintContext('sessions.create'));
      },
    },

    // Mint a scoped agent identity and hand back a connected client bound to it —
    // `sessions.create({ agent })` plus a typed `Ablo({ schema, apiKey })` client,
    // for agents that run in this (secret-key-holding) process. Omitting `id`
    // yields a fresh uuid per call, so concurrent agents are distinct participants
    // that queue behind each other (even when they share a `name`). Humans don't
    // get a server-built client — ship them a token via `sessions.create({ user })`.
    agents: {
      async create(params: CreateAgentClientParams<S>): Promise<Ablo<S>> {
        // Distinct participant by default: omit `id` → a fresh uuid, so even two
        // agents that share a `name` are independent participants and queue
        // behind one another. `name` is display only (→ userMeta.name); it never
        // derives the id. Pass an explicit `id` only to re-attach an agent to
        // its own held claims.
        const id = params.id ?? globalThis.crypto.randomUUID();
        const userMeta =
          params.name !== undefined ? { ...params.userMeta, name: params.name } : params.userMeta;
        const sessionParams = {
          agent: { id },
          can: params.can,
          ...(params.syncGroups ? { syncGroups: params.syncGroups } : {}),
          ...(params.ttlSeconds !== undefined ? { ttlSeconds: params.ttlSeconds } : {}),
          ...(userMeta ? { userMeta } : {}),
        } satisfies CreateAgentSessionParams<S>;
        // Re-mint the `rk_` on every resolver call so a long-lived agent client
        // never hits token expiry; the `sk_` stays in this process — the child
        // only ever sees its own short-lived `rk_`.
        const mintToken = async (): Promise<string> =>
          (await mintSession(sessionParams, await buildMintContext('agents.create')))
            .token;
        // Mint once up front so a bad key / denied scope throws HERE, not later
        // inside the child's bootstrap; reuse that first token, re-mint on refresh.
        let pending: string | null = await mintToken();
        const apiKey: ApiKeySetter = async () => {
          if (pending !== null) {
            const token = pending;
            pending = null;
            return token;
          }
          return mintToken();
        };
        return Ablo<S>({ ...(internalOptions as AbloOptions<S>), apiKey });
      },
    },

    async dispose() {
      _refreshScheduler?.dispose();
      _refreshScheduler = null;
      try {
        await store.disconnect();
      } catch (err) {
        // Best-effort teardown — a disposal hiccup isn't consumer-actionable → debug.
        logger.debug('Error during sync engine disposal', { error: (err as Error).message });
      }
      presenceStream.dispose();
      claimStream.dispose();
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
     * flows (e.g., redirect to sign-in). Does not automatically purge the
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

    /** The InstanceCache — for demand loaders that need pool.createFromData(). */
    get _pool() { return objectPool; },

    /** The SyncWebSocket — for collaboration events (slide selection, cursors). */
    get _ws() { return store.getSyncWebSocket() ?? null; },

    /** Presence livestream — same socket as entity sync, no second
     *  connection. Stable reference across the engine's lifetime. */
    presence: presenceStream,

	    /** Claim livestream — same socket. Stable reference. */
	    claims: publicClaims,

	    commits,

    /** Context-staleness snapshot — see `engine.snapshot(...)` JSDoc. */
    snapshot<ModelName extends keyof S & string>(
      entities: Readonly<Record<ModelName, string | readonly string[]>>,
    ): Snapshot<Schema<S>, ModelName> {
      return createSnapshot<Schema<S>, ModelName>({
        pool: objectPool,
        transport: store.getSyncWebSocket(),
        getLastSyncId: () =>
          store.getSyncWebSocket()?.getLastSyncId() ?? store.lastSyncId ?? 0,
        entities,
      });
    },
  } as Ablo<S>;

  return engine;
}

// ─────────────────────────────────────────────────────────────────────
//  Ablo namespace — type access via `Ablo.X` for the modern SDK shape
// ─────────────────────────────────────────────────────────────────────
//
// One default import, with types hung underneath via namespace dots:
// `import Ablo from "@abloatai/ablo"` gets the factory, its return type, and
// every type a typical consumer references (`Ablo.Peer`, `Ablo.Snapshot<S, K>`,
// and so on) — all purely type-level, with zero runtime cost.
//
// The types still live in their canonical homes (`types/streams`, `principal`,
// this file); the namespace re-exports them as a convenience path. Named imports
// continue to work for callers who prefer them.

import type * as _Streams from '../types/streams.js';
import type * as _Participants from '../sync/participants.js';
import type * as _Policy from '../policy/types.js';
import type * as _Mutators from '../mutators/defineMutators.js';
import type * as _Tx from '../mutators/Transaction.js';
import type * as _Undo from '../mutators/UndoManager.js';
import type * as _SchemaTypes from '../schema/schema.js';
import type * as _Global from '../types/global.js';

/**
 * The canonical type namespace.
 *
 * Rules applied uniformly to every addition:
 *
 *   1. Flat by default. `Ablo.X`. Fewest dots wins.
 *   2. Sub-namespace only when (a) four or more types share a single conceptual
 *      prefix and (b) the names read better with it (`Conflict.Kind` over
 *      `ConflictKind`). If the cluster is heterogeneous (streams, data, handles),
 *      keep it flat.
 *   3. Only types a consumer would write `: Ablo.X` for. Inferred-only types stay
 *      unexported.
 *   4. Wire shapes never appear on `Ablo.*` — engine vocabulary only.
 *   5. Advanced or framework-integration types stay internal unless they graduate
 *      into one of the public subpaths.
 */
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Ablo {
  // ── Factory options ────────────────────────────────────────────────
  export type Options<S extends SchemaRecord = SchemaRecord> = AbloOptions<S>;
  /**
   * The read view of the client that `useAblo` selectors receive: model reads
   * typed as reactive rows (data fields + computeds, no relation accessors).
   */
  export type Reads<S extends SchemaRecord = SchemaRecord> = AbloReads<S>;
  // Claimed-state options stay flat — same concept reused by claims and models.
  export type IfClaimedPolicy = import('./resourceTypes.js').IfClaimedPolicy;
  export type ClaimedOptions = import('./resourceTypes.js').ClaimedOptions;

  // ── Entity pointers (flat — input shapes used everywhere) ─────────
  export type ClaimTarget = _Streams.ClaimTarget;
  export type PresenceTarget = _Streams.PresenceTarget;
  export type TargetRange = _Streams.TargetRange;
  export type Duration = _Streams.Duration;

  // ── Real-time multiplayer (flat — heterogeneous cluster) ──────────
  export type PresenceStream = _Streams.PresenceStream;
  export type ClaimStream = _Streams.ClaimStream;
  export type Peer = _Streams.Peer;
  export type Activity = _Streams.Activity;
  export type Claim = _Streams.Claim;
  export type ClaimRejection = _Streams.ClaimRejection;
  export type ClaimLost = _Streams.ClaimLost;

  // ── Long-running work (flat — the async surface of a claim) ───────
  // Work that outlives a claim's crash-cleanup TTL holds its lease by
  // BEATING (`held.heartbeat()` / `claim({ heartbeat: true })`). The beat's
  // answer carries the extended expiry and the queue pressure behind the
  // lease; a beat on a lapsed lease rejects with `AbloClaimedError` — for a
  // socketless worker, the failed beat IS the loss notification.
  export type ClaimHeartbeat = _Streams.ClaimHeartbeat;
  export type ClaimHeartbeatOptions = _Streams.ClaimHeartbeatOptions;

  // ── Singletons (flat — no cohort) ─────────────────────────────────
  export type Snapshot<
    TSchema extends _SchemaTypes.Schema = _SchemaTypes.Schema,
    K extends keyof TSchema['models'] = keyof TSchema['models'],
  > = _Streams.Snapshot<TSchema, K>;

  // ── Auth (sub-namespace — actor attribution) ──────────────────────
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Auth {
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
  /**
   * The schema this program has registered via `interface Register { Schema }`
   * (falls back to a loose shape when unregistered). Use it where shared code
   * needs "this app's schema" without importing a specific one —
   * `Ablo<Ablo.ResolveSchema['models']>` resolves to whatever the consuming
   * app registered, so one component types correctly across apps that bind
   * different schemas.
   */
  export type ResolveSchema = _Global.ResolveSchema;
  /**
   * `ResolveSchema` guaranteed to satisfy the `Schema` bound. `ResolveSchema`
   * falls back to a loose `{ models }` shape when nothing is registered, which
   * doesn't extend the branded `Schema` type — so generics bounded by `Schema`
   * (mutator anchors, `Transaction<S>`) can't take `ResolveSchema` directly.
   * `RegisteredSchema` collapses that fallback to `Schema`, so shared mutator
   * code can anchor "this app's schema" and stay assignable at the consumer,
   * which reads the same `Register`. Both resolve in lockstep per app.
   */
  export type RegisteredSchema = _Global.ResolveSchema extends _SchemaTypes.Schema
    ? _Global.ResolveSchema
    : _SchemaTypes.Schema;
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Schema {
    export type InferModel<
      S extends _SchemaTypes.Schema,
      K extends keyof S['models'],
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- re-exports the deprecated alias under its historical name for back-compat
    > = _SchemaTypes.InferModel<S, K>;
    export type InferCreate<
      S extends _SchemaTypes.Schema,
      K extends keyof S['models'],
    > = _SchemaTypes.InferCreate<S, K>;
    /**
     * The reactive-row companion to {@link InferModel}: data fields + computed
     * getters, no relation accessors, no model methods — the shape `useAblo`
     * reads return.
     */
    export type InferRow<
      S extends _SchemaTypes.Schema,
      K extends keyof S['models'],
    > = _SchemaTypes.InferRow<S, K>;
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
    export type Axis = _Policy.ConflictAxis;
  }

  // ── Commit (sub-namespace — write-side cohort) ────────────────────
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Commit {
    export type Wait = import('./resourceTypes.js').CommitWait;
    export type OperationAction = import('./resourceTypes.js').ModelOperationAction;
    export type OperationInput = import('./resourceTypes.js').CommitOperationInput;
    export type CreateOptions = import('./resourceTypes.js').CommitCreateOptions;
    export type Receipt = import('./resourceTypes.js').CommitReceipt;
    export type Client = import('./resourceTypes.js').CommitResource;
  }

  // ── Claim (sub-namespace — peer-claim cohort) ────────────────────
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Claim {
    export type Handle = import('./resourceTypes.js').Claim;
    export type Held<T = Record<string, unknown>> = import('../types/streams.js').HeldClaim<T>;
    export type CreateOptions = import('./resourceTypes.js').ClaimCreateOptions;
    export type WaitOptions = import('./resourceTypes.js').ClaimWaitOptions;
    export type Client = import('./resourceTypes.js').ClaimResource;
  }

  // ── Model (sub-namespace — typed-row read/write cohort) ───────────
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Model {
    export type Target = import('./resourceTypes.js').ModelTarget;
    export type Claim = import('./resourceTypes.js').ModelClaim;
    export type Operations<T, CreateInput = T> = import('./createModelProxy.js').ModelOperations<
      T,
      CreateInput
    >;
    export type ClaimOptions<T = Record<string, unknown>> =
      import('./createModelProxy.js').ClaimOptions<T>;
    export type ClaimParams<T = Record<string, unknown>> =
      import('./createModelProxy.js').ClaimParams<T>;
    export type ClaimLookupParams<T = Record<string, unknown>> =
      import('./createModelProxy.js').ClaimLookupParams<T>;
    export type ClaimReorderParams<T = Record<string, unknown>> =
      import('./createModelProxy.js').ClaimReorderParams<T>;
    export type MutationOptions = import('./resourceTypes.js').ModelMutationOptions;
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
    > = import('../source/index.js').DataSourceOptions<S, TAuth>;
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
