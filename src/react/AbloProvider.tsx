'use client';

import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  createContext,
  type ReactNode,
} from 'react';
import type { Schema, SchemaRecord } from '../schema/schema';
import { createSyncEngine, type SyncEngine } from '../client/createSyncEngine';
import type {
  SyncEngineConfig,
  MutationExecutor,
  MutationDispatcher,
  SessionErrorDetector,
  OnlineStatusProvider,
  SyncLogger,
  SyncObservabilityProvider,
} from '../config';
import type { UseMutatorsOptions } from './useMutators';
import type { MutatorDefs } from '../mutators/defineMutators';
import { createMesh } from '../mesh/createMesh';
import type {
  AbloClient,
  ActiveIntent,
  AgentLike,
  JoinOptions,
  MeshParticipant,
  PresenceEntry,
} from '../mesh';
import type { PostBootstrapHook } from '../PostBootstrapRegistry';
import { postBootstrapRegistry } from '../PostBootstrapRegistry';
import { SyncContext, type SyncStoreContract } from './context';
import { AbloInternalContext, type AbloInternalContextValue } from './internalContext';
import { AbloValidationError } from '../errors';
import { useSyncStatus } from './useSyncStatus';
import { DefaultFallback } from './DefaultFallback';

/**
 * Ablo umbrella provider — owns the sync engine, the mesh client, and
 * the full lifecycle (Strict-Mode-safe singleton, `beforeunload`,
 * session-expiry handling, post-bootstrap hooks).
 *
 * Design goals (borrowed from Liveblocks' `LiveblocksProvider` and
 * Zero's `ZeroProvider`):
 *
 *   - **One component, one import.** Consumers write the provider
 *     once at the root; nothing else needs to plumb the engine.
 *   - **Mesh is default.** React consumers are always browsers doing
 *     multiplayer UI, so `useParticipant()` / `useAblo()` are always
 *     available. No opt-in prop.
 *   - **Declarative props for app glue.** `preventUnsavedChanges`,
 *     `onSessionExpired`, `postBootstrap`, `resolveUsers` — each
 *     absorbs a class of integration code that previously lived in
 *     userland.
 *   - **Singleton safety.** The engine lives in a ref and rotates
 *     only when `userId` / `organizationId` / `url` change. React
 *     Strict Mode double-mount does not leak a second WebSocket.
 */

// ── Mesh context ─────────────────────────────────────────────────────
//
// Loosely typed for v0.3.0 — consumers who want schema-typed
// joins cast on read (`useAblo() as AbloClient<typeof schema>`).
// A schema-typed factory can be added in a follow-up release.

const MeshContext = createContext<AbloClient<Schema> | null>(null);

// ── Props ────────────────────────────────────────────────────────────

export interface AbloProviderProps<R extends SchemaRecord = SchemaRecord> {
  /** Schema from `defineSchema()`. Determines the typed hook surface. */
  schema: Schema<R>;

  /** WebSocket URL of the sync server (`wss://...` or `ws://...`). */
  url: string;

  /** User ID. Scopes IndexedDB and mutation attribution. */
  userId: string;

  /** Organization ID. Scopes the default sync group and mesh session. */
  organizationId: string;

  /** Team IDs the user belongs to. Expanded into sync groups. */
  teamIds?: string[];

  /**
   * Mesh auth. Three paths, pick one:
   *
   *   1. `capabilityToken` — server-minted scoped token, Stripe-shape.
   *      The standard browser flow. Your server calls
   *      `ablo.admin.capabilities.create({...})`, ships the token to
   *      the client, and the SDK holds it. No API key in the bundle.
   *   2. `apiKey` — for server-side bindings (Node agents, webhooks,
   *      CLI tools). Loaded from `ABLO_API_KEY` env if unset.
   *   3. Neither — SDK falls back to `credentials: 'include'`, which
   *      rides your existing same-origin session cookie. Use this when
   *      auth is already handled by your framework (Better Auth,
   *      NextAuth, etc.) on the same origin as the mesh service.
   */
  capabilityToken?: string;
  apiKey?: string;
  /**
   * Override for the hosted Ablo service URL (mesh.ablo.finance).
   * Defaults to `ABLO_BASE_URL` env, or `https://mesh.ablo.finance`
   * if unset. Separate from the `url` prop, which points at your
   * sync server — mesh and sync are different endpoints.
   */
  meshBaseURL?: string;

  /** Optional Zero-style custom mutators. */
  mutators?: MutatorDefs<Schema<R>>;
  /** Options forwarded to the internal `useMutators` call (e.g., `undoScope`). */
  mutatorOptions?: UseMutatorsOptions<Schema<R>>;

  // ── Declarative behavior ──────────────────────────────────────────

  /**
   * Block browser tab close when there are unsynced local writes.
   * Triggers the standard `beforeunload` "Leave site?" prompt.
   * Browsers ignore custom messages — do not pass one. Consumers
   * who want telemetry should read
   * `useSyncStatus().hasUnsyncedChanges` directly.
   */
  preventUnsavedChanges?: boolean;

  /**
   * Milliseconds to tolerate connection loss before `useSyncStatus()`
   * flips to `disconnected`. Defaults to 5000. Set to 0 to
   * disable the grace period (immediate transition).
   *
   * v0.3.0 scope: reserved for future wiring. Current transition is
   * driven by the engine's built-in state machine.
   */
  lostConnectionTimeout?: number;

  /**
   * Hooks to run after the engine bootstraps (hydrate + post-bootstrap).
   * Order is preserved. Failures log but don't block the skeleton.
   */
  postBootstrap?: ReadonlyArray<PostBootstrapHook>;

  // ── Lifecycle callbacks ──────────────────────────────────────────

  /**
   * Fired when the server rejects the session. The provider has
   * ALREADY called `engine.purge()` (disposed + wiped IndexedDB) by
   * the time this runs — the callback is for app-level side effects
   * (e.g., redirect to sign-in, clear analytics identity).
   */
  onSessionExpired?: () => void | Promise<void>;

  /**
   * Fired on any error the provider surfaces: engine errors,
   * WebSocket errors, uncaught `postBootstrap` exceptions. Use for
   * Sentry / Datadog. Consumers who only want errors inside React
   * can use the `useErrorListener()` hook instead.
   */
  onError?: (error: Error) => void;

  // ── Optional DI (advanced) ───────────────────────────────────────

  observability?: SyncObservabilityProvider;
  logger?: SyncLogger;
  mutationExecutor?: MutationExecutor;
  mutationDispatcher?: MutationDispatcher;
  sessionErrorDetector?: SessionErrorDetector;
  onlineStatus?: OnlineStatusProvider;
  configOverrides?: SyncEngineConfig;
  syncGroups?: string[];
  bootstrapBaseUrl?: string;
  maxPoolSize?: number;

  /**
   * Rendered in place of `children` during the *first* bootstrap pass —
   * while the engine is actively transitioning from `initial` →
   * `connected` and has never successfully connected before. Once the
   * engine reaches `connected` the gate latches open for the lifetime
   * of this provider instance; transient `reconnecting` / `needs-auth`
   * states do NOT re-show the fallback (the app's own UI handles those
   * by then).
   *
   * Defaults to `<DefaultFallback />` — a neutral theme-adaptive
   * spinner that uses `currentColor`, ships with zero design-system
   * dependencies, and self-centers in a full-parent container. Pass
   * your own `<Skeleton />` for a branded loading UX. Pass `null` to
   * render nothing during bootstrap. Pass the string literal
   * `"passthrough"` to opt out of the gate entirely — children render
   * immediately and consumers are responsible for their own gating
   * (`<ClientSideSuspense>` or manual `useSyncStatus()` checks).
   * Useful for pages that mount debug helpers, error boundaries, or
   * analytics that must run pre-ready.
   */
  fallback?: ReactNode | 'passthrough';

  children: ReactNode;
}

// ── Implementation ───────────────────────────────────────────────────

/**
 * Lightweight event emitter for provider-level errors. Lives on the
 * provider instance (ref-based) so `useErrorListener` subscriptions
 * survive re-renders without thrashing.
 */
function createErrorEmitter() {
  const listeners = new Set<(err: Error) => void>();
  return {
    subscribe(fn: (err: Error) => void): () => void {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    emit(err: Error): void {
      for (const fn of listeners) {
        try { fn(err); } catch {}
      }
    },
  };
}

export function AbloProvider<R extends SchemaRecord = SchemaRecord>(
  props: AbloProviderProps<R>,
): React.ReactElement {
  const {
    schema,
    url,
    userId,
    organizationId,
    teamIds,
    capabilityToken,
    apiKey,
    meshBaseURL,
    preventUnsavedChanges,
    postBootstrap,
    onSessionExpired,
    onError,
    observability,
    logger,
    mutationExecutor,
    mutationDispatcher,
    sessionErrorDetector,
    onlineStatus,
    configOverrides,
    syncGroups,
    bootstrapBaseUrl,
    maxPoolSize,
    fallback = <DefaultFallback />,
    children,
  } = props;

  // ── Error emitter (provider-instance scoped) ─────────────────────
  //
  // Built once, reused for the lifetime of this provider. Survives
  // engine rotations so error listeners don't need to resubscribe.
  const errorEmitterRef = useRef<ReturnType<typeof createErrorEmitter> | null>(null);
  if (!errorEmitterRef.current) {
    errorEmitterRef.current = createErrorEmitter();
  }
  const errorEmitter = errorEmitterRef.current;

  // Stash `onError` in a ref so forwarding it doesn't trigger
  // engine rotation. The provider wraps it and calls via ref at fire
  // time, matching the `useEventCallback` idiom.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  useEffect(() => {
    return errorEmitter.subscribe((err) => onErrorRef.current?.(err));
  }, [errorEmitter]);

  // ── Engine lifecycle keyed on (userId, organizationId, url) ──────
  //
  // `useEngineInstance` below rotates the engine when any of these
  // change. For everything else (mutators, DI, callbacks), we stash
  // in refs so mutations to those props don't tear down the engine.

  const engineKey = `${userId}|${organizationId}|${url}`;
  const [engineState, setEngineState] = useState<{
    key: string;
    engine: SyncEngine<R> | null;
    mesh: AbloClient<Schema<R>> | null;
  }>({ key: engineKey, engine: null, mesh: null });

  // Keep a ref to the current engine key so the rotation effect can
  // detect late-arriving prop changes without causing React churn.
  const currentKeyRef = useRef(engineState.key);
  currentKeyRef.current = engineState.key;

  useEffect(() => {
    const abort = new AbortController();
    let isStale = false;

    // Construct engine + mesh for this key.
    const engine = createSyncEngine<R>({
      url,
      schema,
      user: { id: userId, organizationId, teamIds },
      apiKey,
      logger,
      observability,
      sessionErrorDetector,
      onlineStatus,
      mutationExecutor,
      mutationDispatcher,
      configOverrides,
      syncGroups,
      bootstrapBaseUrl,
      maxPoolSize,
      autoStart: false,
    });

    const mesh = createMesh<Schema<R>>({
      schema,
      baseURL: meshBaseURL,
      apiKey,
      capabilityToken,
    });

    setEngineState({ key: engineKey, engine, mesh });

    // Forward session-error events to the consumer. Purge first so
    // the IndexedDB is wiped before the app redirects to /signin.
    const unsubscribeSession = engine.onSessionError(async (err) => {
      errorEmitter.emit(err);
      try {
        await engine.purge();
      } catch {}
      try {
        await onSessionExpired?.();
      } catch (hookErr) {
        errorEmitter.emit(hookErr as Error);
      }
    });

    // Drive initial bootstrap + post-bootstrap hooks.
    (async () => {
      try {
        // Register declarative hooks before ready() — the base store
        // runs them after IDB hydration but before `dataReady`.
        if (postBootstrap) {
          for (const [i, hook] of postBootstrap.entries()) {
            postBootstrapRegistry.register(`ablo_provider_hook_${engineKey}_${i}`, hook);
          }
        }

        await engine.ready();
        if (isStale || abort.signal.aborted) return;
      } catch (err) {
        if (isStale || abort.signal.aborted) return;
        errorEmitter.emit(err as Error);
      }
    })();

    return () => {
      isStale = true;
      abort.abort();
      unsubscribeSession();
      void engine.dispose();
      // AbloClient is stateless-ish — participants manage their own
      // WebSocket connections via `participant.disconnect()`. No client
      // close is needed.
    };
    // We intentionally only re-run on engineKey. All other DI is
    // captured at first render; rotating the engine on every
    // `mutationExecutor` identity change would destroy the WebSocket.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineKey]);

  // ── beforeunload + preventUnsavedChanges ─────────────────────────

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (event: BeforeUnloadEvent) => {
      const engine = engineState.engine;
      if (!engine) return;
      // Best-effort: dispose on unload. The async work may not
      // complete before the tab closes — that's fine for IDB, which
      // flushes pending writes transactionally.
      void engine.dispose();
      if (preventUnsavedChanges && engine._store.hasUnsyncedChanges) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [engineState.engine, preventUnsavedChanges]);

  // ── SyncContext value (for useQuery/useOne/useMutate hooks) ──────

  const syncValue = useMemo(() => {
    if (!engineState.engine) return null;
    return {
      store: engineState.engine._store,
      organizationId,
      schema,
    };
  }, [engineState.engine, organizationId, schema]);

  // ── Internal context (currentUserId + error subscription) ────────

  const internalValue = useMemo<AbloInternalContextValue>(() => ({
    currentUserId: userId,
    subscribeError: errorEmitter.subscribe,
    emitError: errorEmitter.emit,
    // `engine` is null until bootstrap finishes; `useSync()` throws
    // on null so callers are forced to gate with <ClientSideSuspense>.
    engine: engineState.engine as SyncEngine<SchemaRecord> | null,
  }), [userId, errorEmitter, engineState.engine]);

  // ── Render ───────────────────────────────────────────────────────
  //
  // Two-phase gate (see `BootstrapGate` below for the latch logic):
  //
  //   1. Engine is null on first render (constructed in the effect
  //      above, not in render). We render `fallback` directly — there
  //      is no SyncContext to read status from, and by definition the
  //      engine hasn't started bootstrapping.
  //   2. Engine exists. Mount SyncContext. `BootstrapGate` then reads
  //      `useSyncStatus()` and shows `fallback` only during the very
  //      first `connecting` transition; children render on every
  //      subsequent state change, including reconnects and auth
  //      failures (the app's own UI handles those).
  //
  // `fallback === 'passthrough'` short-circuits both branches — children
  // render immediately without any gate, restoring pre-gate behavior
  // for consumers who need debug helpers / error boundaries / analytics
  // to mount before the engine is ready.

  const passthrough = fallback === 'passthrough';
  const initialFallback = passthrough ? children : fallback;

  if (!syncValue) {
    return (
      <AbloInternalContext.Provider value={internalValue}>
        <MeshContext.Provider value={engineState.mesh as AbloClient<Schema> | null}>
          {initialFallback}
        </MeshContext.Provider>
      </AbloInternalContext.Provider>
    );
  }

  return (
    <AbloInternalContext.Provider value={internalValue}>
      <MeshContext.Provider value={engineState.mesh as AbloClient<Schema> | null}>
        <SyncContext.Provider value={syncValue}>
          {passthrough ? (
            children
          ) : (
            <BootstrapGate key={engineState.key} fallback={fallback}>
              {children}
            </BootstrapGate>
          )}
        </SyncContext.Provider>
      </MeshContext.Provider>
    </AbloInternalContext.Provider>
  );
}

/**
 * Internal gate that renders `fallback` only during the very first
 * bootstrap pass. Latches open on the first `connected` / `reconnecting`
 * / `disconnected` transition and stays open — subsequent transient
 * `connecting` states (hard reconnect after an offline stretch) do NOT
 * re-show the fallback, because by then the app has already rendered
 * once and its own reconnect UI should take over.
 *
 * Re-keyed on `engineState.key` in the parent so engine rotations
 * (userId/org/url change) reset the latch — a new engine genuinely IS
 * a new "first bootstrap" cycle.
 */
function BootstrapGate({
  fallback,
  children,
}: {
  readonly fallback: ReactNode;
  readonly children: ReactNode;
}): React.ReactElement {
  const status = useSyncStatus();
  const [everConnected, setEverConnected] = useState(false);

  useEffect(() => {
    if (
      status.name === 'connected' ||
      status.name === 'reconnecting' ||
      status.name === 'disconnected'
    ) {
      setEverConnected(true);
    }
  }, [status.name]);

  const showFallback = !everConnected && status.name === 'connecting';
  return <>{showFallback ? fallback : children}</>;
}

// ── Mesh hooks ───────────────────────────────────────────────────────

/**
 * Returns the `AbloClient` from the nearest `<AbloProvider>`. Throws
 * if called outside the provider. Loosely typed for v0.3.0; cast on
 * read if you want schema-typed mesh APIs:
 *
 * ```ts
 * const ablo = useAblo() as AbloClient<typeof schema>;
 * ```
 */
export function useAblo(): AbloClient<Schema> {
  const ablo = useContext(MeshContext);
  if (!ablo) {
    throw new AbloValidationError(
      'useAblo: no <AbloProvider> mounted above this component.',
      { code: 'no_ablo_provider' },
    );
  }
  return ablo;
}

export interface UseParticipantOptions {
  /** Scope — required. Flat object `{ matters: id }` or array form. */
  readonly scope: JoinOptions<Schema>['scope'];
  /** Human-readable name peers see in presence + audit logs. */
  readonly label?: string;
  /** Delegation principal. */
  readonly as?: JoinOptions<Schema>['as'];
  /** TTL. Number (seconds) or duration string (`'1h'`, `'3m'`). */
  readonly ttlSeconds?: JoinOptions<Schema>['ttlSeconds'];
  /** Escape hatch for callers that hold their own agent object by reference. */
  readonly agent?: AgentLike;
  /** Idempotency key. */
  readonly idempotencyKey?: string | null;
  /** Seconds before expiry to auto-rotate. Default 300. `null` to disable. */
  readonly autoRefreshThresholdSeconds?: number | null;
  /** Tear down + don't re-join while true. */
  readonly paused?: boolean;
}

export type MeshParticipantStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'disconnected';

export interface UseParticipantReturn {
  readonly participant: MeshParticipant<AgentLike, Schema> | null;
  /** Everyone else on the mesh (`participant.presence.others`), bridged to React. */
  readonly peers: ReadonlyArray<PresenceEntry>;
  /** Active intent claims by peers (`participant.intents.others`), bridged to React. */
  readonly claims: ReadonlyArray<ActiveIntent>;
  readonly status: MeshParticipantStatus;
  readonly error: Error | null;
}

const EMPTY_PRESENCE: ReadonlyArray<PresenceEntry> = Object.freeze([]);
const EMPTY_INTENTS: ReadonlyArray<ActiveIntent> = Object.freeze([]);

/**
 * Join the mesh for a given scope. Returns the participant and its
 * lifecycle status. Auto-cleans up on unmount or when `paused`
 * flips to true.
 *
 * Matches the flat `ablo.<model>.join(id, { label, scope, as })`
 * convention from the mesh SDK — see `docs/mesh.md` for full
 * coordination primitives.
 *
 * The participant is typed as `MeshParticipant<AgentLike, Schema>`.
 * Consumers who need a more specific agent type should call
 * `ablo.join(myAgent, opts)` directly on the client from
 * `useAblo()` — this hook synthesizes a minimal agent and is
 * intentionally narrow.
 */
export function useParticipant(opts: UseParticipantOptions): UseParticipantReturn {
  const ablo = useAblo();
  const {
    autoRefreshThresholdSeconds = 300,
    paused = false,
  } = opts;

  const [participant, setParticipant] = useState<MeshParticipant<AgentLike, Schema> | null>(null);
  const [status, setStatus] = useState<MeshParticipantStatus>('idle');
  const [error, setError] = useState<Error | null>(null);

  // Stash opts in a ref — plain-object props churn identity every
  // render, and depending on them would rejoin on every parent render.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    if (paused) return;
    let canceled = false;
    let stopAutoRefresh: (() => void) | null = null;
    let active: MeshParticipant<AgentLike, Schema> | null = null;

    (async () => {
      setStatus('connecting');
      setError(null);
      try {
        const current = optsRef.current;
        // Synthesize a minimal agent from `label` when the caller didn't
        // bring their own — matches `ablo.<model>.join(id, { label })`.
        const agent: AgentLike = current.agent
          ?? (current.label !== undefined ? { label: current.label } : {});
        const joined = await ablo.join(agent, {
          scope: current.scope,
          as: current.as,
          label: current.label,
          ttlSeconds: current.ttlSeconds,
          idempotencyKey: current.idempotencyKey ?? undefined,
          autoConnect: false,
        });
        if (canceled) { await joined.disconnect(); return; }
        await joined.connect();
        if (canceled) { await joined.disconnect(); return; }
        active = joined;
        if (autoRefreshThresholdSeconds !== null) {
          stopAutoRefresh = joined.autoRefresh({
            schedule: 'beforeExpiry',
            thresholdSeconds: autoRefreshThresholdSeconds,
          });
        }
        setParticipant(joined);
        setStatus('connected');
      } catch (err) {
        if (canceled) return;
        setError(err as Error);
        setStatus('error');
      }
    })();

    return () => {
      canceled = true;
      if (stopAutoRefresh) stopAutoRefresh();
      if (active) void active.disconnect();
      setParticipant(null);
      setStatus('disconnected');
    };
  }, [ablo, paused, autoRefreshThresholdSeconds]);

  // Bridge the mesh's presence + intents streams into React state.
  // Plain useState + useEffect is sufficient here — mid-frame tearing
  // on a peer list is harmless (users won't notice one frame of stale
  // presence), and the simpler shape sidesteps the cached-snapshot
  // contract that useSyncExternalStore requires. Queries and sync
  // status still use useSyncExternalStore because store transactions
  // CAN tear visibly; presence can't.
  const [peers, setPeers] = useState<ReadonlyArray<PresenceEntry>>(EMPTY_PRESENCE);
  const [claims, setClaims] = useState<ReadonlyArray<ActiveIntent>>(EMPTY_INTENTS);

  useEffect(() => {
    if (!participant) {
      setPeers(EMPTY_PRESENCE);
      setClaims(EMPTY_INTENTS);
      return;
    }
    setPeers(participant.presence.others);
    setClaims(participant.intents.others);
    const unsubPresence = participant.presence.subscribe(() => {
      setPeers(participant.presence.others);
    });
    const unsubIntents = participant.intents.subscribe(() => {
      setClaims(participant.intents.others);
    });
    return () => {
      unsubPresence();
      unsubIntents();
    };
  }, [participant]);

  return { participant, peers, claims, status, error };
}

// ── Escape-hatches: raw engine/store access ──────────────────────────

/**
 * Returns the raw `SyncEngine` proxy. Typically you want the typed
 * hooks (`useQuery`, `useOne`, `useMutate`) — this is for rare cases
 * where you need direct access (e.g., `sync.tasks.subscribe(cb)`).
 *
 * The generic parameter narrows the return type to your schema's
 * model record so call sites get typed `sync.tasks.findMany()` /
 * `sync.slides.create(...)` without a cast at the call site:
 *
 * ```ts
 * const sync = useSync<(typeof schema)['models']>();
 * ```
 *
 * The runtime value is the exact engine the provider constructed;
 * the generic just widens the compile-time type.
 */
export function useSync<R extends SchemaRecord = SchemaRecord>(): SyncEngine<R> {
  const ctx = useContext(AbloInternalContext);
  if (!ctx) {
    throw new AbloValidationError(
      'useSync: no <AbloProvider> mounted above this component.',
      { code: 'no_ablo_provider' },
    );
  }
  if (!ctx.engine) {
    throw new AbloValidationError(
      'useSync: the sync engine has not yet initialized. Wrap your ' +
        'consumer in <ClientSideSuspense> or guard on useSyncStatus().',
      { code: 'sync_not_ready' },
    );
  }
  return ctx.engine as SyncEngine<R>;
}

/**
 * Returns the underlying `SyncStoreContract` (the BaseSyncedStore).
 * Most consumers should prefer the typed hooks (`useQuery` etc.); this
 * is for advanced cases like direct ObjectPool access or custom
 * reactive bridges. Throws if the provider hasn't mounted the store
 * yet — wrap consumers in `<ClientSideSuspense>` to gate correctly.
 *
 * The generic parameter lets consumers widen the return type to a
 * concrete `BaseSyncedStore<...>` subclass if they track one:
 *
 * ```ts
 * type AppStore = BaseSyncedStore<AppEvents, typeof schema>;
 * const store = useSyncStore<AppStore>();  // no cast needed at call site
 * ```
 *
 * The runtime value is always the concrete store the SDK constructed,
 * so widening the type is safe. The bounded generic (`T extends
 * SyncStoreContract`) keeps the widening honest.
 */
export function useSyncStore<T extends SyncStoreContract = SyncStoreContract>(): T {
  const sync = useContext(SyncContext);
  if (!sync || !sync.store) {
    throw new AbloValidationError(
      'useSyncStore: the sync engine has not yet initialized. Wrap ' +
        'consumers in <ClientSideSuspense> or guard on useSyncStatus().',
      { code: 'sync_not_ready' },
    );
  }
  return sync.store as T;
}
