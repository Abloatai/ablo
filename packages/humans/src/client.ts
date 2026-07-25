/**
 * The shape of the reactive client — what `Ablo({ schema, apiKey })` hands back.
 *
 * This module owns the declaration; `./Ablo.ts` aliases it as `Ablo<S>` so the
 * factory, the type, and the `Ablo.*` namespace keep merging under one name.
 * The split is what keeps the composition root readable: the contract a caller
 * writes against lives here, the wiring that satisfies it lives there.
 *
 * Type-only, with no runtime imports — the same property that lets `options.ts`
 * and `resourceTypes.ts` be referenced from the HTTP client without importing
 * the factory back and creating a cycle.
 */

import type {
  Schema,
  SchemaRecord,
  Model,
  InferCreate,
  InferRow,
} from '@ablo/transaction/schema/schema';
import type { PresenceStream, Snapshot } from '@ablo/transaction/types/streams';
import type { InstanceCache } from './local/InstanceCache.js';
import type { SyncStoreContract } from './react/context.js';
import type { SyncWebSocket, CoreSyncEventMap } from './local/sync/SyncWebSocket.js';
import type { SyncStatus } from './local/BaseSyncedStore.js';
import type { ModelOperations } from './local/client/createModelProxy.js';
import type {
  ClaimResource,
  CommitResource,
  CreateAgentClientParams,
  SessionResource,
} from '@ablo/transaction/resources/httpResources';
export type { LocalReadOptions } from './local/client/resourceTypes.js';

/** The typed sync engine client — one property per model in the schema */
export type AbloClient<S extends SchemaRecord> = {
  readonly [K in keyof S & string]: ModelOperations<
    Model<Schema<S>, K>,
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
   * Pass `{ user: { id }, can: { tasks: ['read', 'update'] } }` for an end-user
   * session. It mints an `ek_` and attributes writes to a user (recorded as
   * `actor_kind` on the delta row). Pass `{ agent: { id }, can: {
   * tasks: ['update'] } }` for a scoped agent session, which mints an `rk_`.
   * Both kinds require `can`, typed against your schema's model names. This
   * always authenticates with the original `sk_`, never the client's exchanged
   * sync credential.
   */
  sessions: SessionResource<S>;

  /**
   * Mint a scoped **agent identity** and return a ready-to-use client bound to
   * it — the `ablo.<resource>.<verb>` shape for the agent use case. One call
   * replaces `sessions.create({ agent, can })` + constructing a second
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
   * token via `sessions.create({ user, can })`. If you need the raw token for
   * revocation, or a stable re-attachable id, use `sessions.create({ agent, can })`
   * or pass `id`.
   */
  agents: {
    create(params: CreateAgentClientParams<S>): Promise<AbloClient<S>>;
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
   * Subscribe to terminal session events. The client stops network access and
   * completes local authenticated-state cleanup before listeners run. Returns
   * an unsubscribe function; multiple subscribers are supported.
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
      transaction: import('./local/transactions/mutations/MutationQueue.js').QueuedMutation;
      error: Error;
      permanent?: boolean;
    }) => void,
  ): () => void;

  /**
   * Subscribe to commit round-trip latency — how long each write takes to
   * land, split into the local durable seal (`sealMs`) and the remote
   * acknowledgement (`ackMs`). Fires once per completed commit; returns an
   * unsubscribe function.
   *
   * Use this for latency readouts and performance telemetry. It is the only
   * measurement of the write path: commits travel over the WebSocket, so
   * `fetch`-based instrumentation never observes them.
   */
  onCommitLatency(
    listener: (
      sample: import('./local/transactions/mutations/commitLatency.js').CommitLatencySample,
    ) => void,
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
   * const snap = engine.snapshot({ sections: report.sectionIds });
   * await streamText({ messages, signal: snap.signal });
   * ```
   */
  snapshot<ModelName extends keyof S & string>(
    entities: Readonly<Record<ModelName, string | readonly string[]>>,
  ): Snapshot<Schema<S>, ModelName>;

  /**
   * Subscribe to pushed frames — deltas, presence updates, claim grants and
   * losses, connection changes. Durable: the subscription survives the
   * socket being rebuilt across reconnects, and one made before the first
   * connection starts delivering when it opens. Returns the unsubscribe
   * function. App-specific collaboration events ride the store's own typed
   * map — see `_store`.
   */
  subscribe<K extends keyof CoreSyncEventMap>(
    event: K,
    handler: (...args: CoreSyncEventMap[K]) => void,
  ): () => void;

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
   * The SyncWebSocket handle — for collaboration events (selection, cursor
   * broadcast). Present for the client's whole lifetime: the connection object
   * is built with the store and holds no socket until `connect()`, so there is
   * no window in which this is absent and nothing needs to guard for one.
   */
  readonly _ws: SyncWebSocket;
};

/**
 * The reactive-read client a `useAblo` selector receives. The same surface as
 * {@link AbloClient}, except model reads are typed as reactive rows
 * ({@link InferRow}: data fields + computeds, no relation accessors, no model
 * methods) — the shape a reactive read actually delivers after
 * `toReactiveSnapshot()`. Reading `row.blocks` off a reactive read is a
 * compile error here instead of a silent runtime `undefined`; compose
 * relations through selectors or hooks that resolve the pool's instance.
 */
export type AbloReads<S extends SchemaRecord> = Omit<AbloClient<S>, keyof S & string> & {
  readonly [K in keyof S & string]: ModelOperations<
    InferRow<Schema<S>, K>,
    InferCreate<Schema<S>, K>
  >;
};
