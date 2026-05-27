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
import type { Schema, SchemaRecord } from '../schema/schema.js';
import { Ablo } from '../client/Ablo.js';
import type { InternalAbloOptions } from '../client/Ablo.js';
import type { AbloPersistence } from '../client/persistence.js';
import type {
  SyncEngineConfig,
  MutationExecutor,
  MutationDispatcher,
  SessionErrorDetector,
  OnlineStatusProvider,
  SyncLogger,
  SyncObservabilityProvider,
} from '../config/index.js';
import type { UseMutatorsOptions } from './useMutators.js';
import type { MutatorDefs } from '../mutators/defineMutators.js';
import type {
  ActiveIntent,
  Peer,
} from '../types/streams.js';
import type {
  EngineParticipant,
  ParticipantScope,
  ParticipantStatus,
} from '../sync/participants.js';
import {
  createParticipantClaimId,
  parseParticipantTtlSeconds,
  resolveParticipantSyncGroups,
} from '../sync/participants.js';
import { SyncContext, type SyncStoreContract } from './context.js';
import { AbloInternalContext, type AbloInternalContextValue } from './internalContext.js';
import { AbloValidationError } from '../errors.js';
import { useSyncStatus } from './useSyncStatus.js';
import { DefaultFallback } from './DefaultFallback.js';

/**
 * Ablo umbrella provider — owns the sync engine, multiplayer, and
 * the full lifecycle (Strict-Mode-safe singleton, `beforeunload`,
 * session-expiry handling, post-bootstrap hooks).
 *
 * Design goals (borrowed from Liveblocks' `LiveblocksProvider` and
 * Zero's `ZeroProvider`):
 *
 *   - **One component, one import.** Consumers write the provider
 *     once at the root; nothing else needs to plumb the engine.
 *   - **Multiplayer is default.** React consumers are always browsers doing
 *     multiplayer UI, so `useParticipant()` / `useAblo()` are always
 *     available. No opt-in prop.
 *   - **Declarative props for app glue.** `preventUnsavedChanges`,
 *     `onSessionExpired`, `postBootstrap`, `resolveUsers` — each
 *     absorbs a class of integration code that previously lived in
 *     userland.
 *   - **Singleton safety.** The engine lives in a ref and rotates
 *     only when `userId` / account scope / `url` change. React
 *     Strict Mode double-mount does not leak a second WebSocket.
 */

// ── Props ────────────────────────────────────────────────────────────

/**
 * Props for `<AbloProvider>`.
 *
 * The default path is one prop:
 *
 * ```tsx
 * <AbloProvider schema={schema}>
 *   <App />
 * </AbloProvider>
 * ```
 *
 * That's it for most apps — the provider resolves identity, account
 * scope, and realtime permissions from auth. `userId`/`apiKey`/`url`
 * are situational; the `bootstrapMode`, `persistence`, and `fallback`
 * props are opt-in tuning; and the block tagged "Optional DI (advanced)"
 * below is escape-hatch wiring for tests and platform builders — if you
 * don't recognize a prop there, you don't need it.
 */
export interface AbloProviderProps<R extends SchemaRecord = SchemaRecord> {
  /**
   * Schema from `defineSchema()`. Determines the typed hook surface.
   * This is the only prop most apps pass — start here.
   */
  schema: Schema<R>;

  /**
   * WebSocket URL of the sync server (`wss://...` or `ws://...`).
   * Hosted apps omit this.
   */
  url?: string;

  /**
   * Optional app user id for app-owned fields. Ablo resolves sync
   * participant identity from auth; this is not required to connect.
   */
  userId?: string;

  /** Team IDs the user belongs to. Expanded into sync groups. */
  teamIds?: string[];

  /**
   * API key for engine bootstrap auth. Used by the bootstrap fetch
   * path; falls back to `credentials: 'include'` (session cookie)
   * when unset. Browser apps typically omit this and rely on
   * same-origin session cookies.
   */
  apiKey?: string;

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
   * Local persistence mode for the underlying `Ablo` client. Defaults
   * to `volatile` — pass `'indexeddb'` to opt back into offline-queue +
   * reload-surviving cache in a browser. See `AbloOptions.persistence`
   * for the full semantics.
   */
  persistence?: AbloPersistence;

  /**
   * How aggressively this provider pulls baseline state at startup.
   *
   *  - `'full'` (default): pull every delta in the configured sync
   *    groups before the engine reports ready — a local replica of the
   *    org's tenant plane. Right for collaborative editors and any page
   *    that reads a lot of shared state.
   *  - `'none'`: open the connection and process live deltas only — no
   *    baseline fetch. Reads round-trip via `ablo.<model>.retrieve(...)`
   *    and subscriptions populate the pool lazily. Right for read-light
   *    pages (a mostly-static dashboard, a settings screen) that don't
   *    want to download the whole org to render.
   *
   * Note: `'none'` still opens the realtime connection — it skips the
   * baseline pull, not the socket. A fully connection-free mode for
   * pages that do zero multiplayer is a separate follow-up (the socket
   * open lives inside `engine.ready()`, so deferring it needs
   * engine-level lazy-connect support, not just a provider prop).
   *
   * Mirrors `AbloOptions.bootstrapMode`. Changing it rotates the engine.
   */
  bootstrapMode?: 'full' | 'none';

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
    url = 'wss://mesh.ablo.finance',
    userId,
    teamIds,
    apiKey,
    preventUnsavedChanges,
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
    persistence,
    bootstrapMode,
    fallback = <DefaultFallback />,
    children,
  } = props;
  // Account scope is no longer accepted from props. The engine learns
  // it from auth (capability token) at bootstrap and we read it back
  // out of `_store.orgId` once `engine.ready()` resolves.
  const [resolvedAccountScope, setResolvedAccountScope] = useState<string | null>(null);

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

  // ── Engine lifecycle keyed on (userId, url) ─────────────────────
  //
  // The engine rotates when either of these change. For everything
  // else (mutators, DI, callbacks) we stash in refs so mutations to
  // those props don't tear down the engine.

  const engineKey = JSON.stringify({
    userId: userId ?? null,
    url,
    bootstrapMode: bootstrapMode ?? null,
  });
  const [engineState, setEngineState] = useState<{
    key: string;
    engine: Ablo<R> | null;
  }>({ key: engineKey, engine: null });

  // Keep a ref to the current engine key so the rotation effect can
  // detect late-arriving prop changes without causing React churn.
  const currentKeyRef = useRef(engineState.key);
  currentKeyRef.current = engineState.key;

  useEffect(() => {
    const abort = new AbortController();
    let isStale = false;
    setResolvedAccountScope(null);

    // Construct engine + multiplayer streams for this key.
    const engineOptions: InternalAbloOptions<R> = {
      baseURL: url,
      schema,
      ...(userId ? { user: { id: userId, teamIds } } : {}),
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
      persistence,
      ...(bootstrapMode ? { bootstrapMode } : {}),
      autoStart: false,
    };
    const engine = Ablo<R>(engineOptions);

    setEngineState({ key: engineKey, engine });

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

    // Drive initial bootstrap. Consumer code that wants to run logic
    // after the engine is ready calls `useAblo()` and wires its own
    // `useEffect` — the SDK no longer holds a registry of "post-
    // bootstrap hooks" because the indirection costs more than it
    // saves once `useAblo` exists.
    (async () => {
      try {
        await engine.ready();
        if (isStale || abort.signal.aborted) return;
        setResolvedAccountScope(
          (engine._store as SyncStoreContract & { orgId?: string }).orgId ?? null,
        );
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
    const currentAccountScope =
      resolvedAccountScope ??
      (engineState.engine._store as SyncStoreContract & { orgId?: string }).orgId;
    if (!currentAccountScope) return null;
    return {
      store: engineState.engine._store,
      organizationId: currentAccountScope,
      schema,
    };
  }, [engineState.engine, resolvedAccountScope, schema]);



  // ── Internal context (currentUserId + error subscription) ────────

  const internalValue = useMemo<AbloInternalContextValue>(() => ({
    currentUserId: userId ?? null,
    subscribeError: errorEmitter.subscribe,
    emitError: errorEmitter.emit,
    // `engine` is null until bootstrap finishes; `useSync()` throws
    // on null so callers are forced to gate with <ClientSideSuspense>.
    engine: engineState.engine as Ablo<SchemaRecord> | null,
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
        {initialFallback}
      </AbloInternalContext.Provider>
    );
  }

  return (
    <AbloInternalContext.Provider value={internalValue}>
      <SyncContext.Provider value={syncValue}>
        {passthrough ? (
          children
        ) : (
          <BootstrapGate key={engineState.key} fallback={fallback}>
            {children}
          </BootstrapGate>
        )}
      </SyncContext.Provider>
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
}): ReactNode {
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


export type { EngineParticipant, ParticipantScope, ParticipantStatus };

/**
 * Options for `useParticipant`. The hook reuses the engine's single
 * WebSocket and opens a scoped claim on it when `scope` is provided:
 * one TCP connection, N logical sub-syncgroup participants.
 */
export interface UseParticipantOptions {
  readonly scope?: ParticipantScope;
  readonly label?: string;
  readonly as?: unknown;
  readonly ttlSeconds?: number | string | null;
  readonly agent?: unknown;
  readonly idempotencyKey?: string | null;
  readonly autoRefreshThresholdSeconds?: number | null;
  /** Tear down + don't re-join while true. */
  readonly paused?: boolean;
}

/** @deprecated Use `ParticipantStatus`. */
export type MeshParticipantStatus = ParticipantStatus;

export interface UseParticipantReturn {
  readonly participant: EngineParticipant | null;
  /** Everyone else on the engine's sync groups (`participant.presence.others`), bridged to React. */
  readonly peers: ReadonlyArray<Peer>;
  /** Active intent claims by peers (`participant.intents.others`), bridged to React. */
  readonly claims: ReadonlyArray<ActiveIntent>;
  readonly status: ParticipantStatus;
  readonly error: Error | null;
}

const EMPTY_PRESENCE: ReadonlyArray<Peer> = Object.freeze([]);
const EMPTY_INTENTS: ReadonlyArray<ActiveIntent> = Object.freeze([]);

/**
 * Join multiplayer for a given scope. Returns the participant and its
 * lifecycle status. Auto-cleans up on unmount or when `paused`
 * flips to true.
 *
 * The returned `participant` is an `EngineParticipant` — `.presence`
 * + `.intents` only — backed by the engine's existing socket. For
 * headless-bot patterns (a separate identity in the same browser
 * tab), construct a second `Ablo({ kind: 'agent', ... })` directly.
 */
export function useParticipant(opts: UseParticipantOptions): UseParticipantReturn {
  const ctx = useContext(AbloInternalContext);
  const engine = ctx?.engine ?? null;
  const { paused = false } = opts;
  const scopeKey = JSON.stringify(resolveParticipantSyncGroups(opts.scope).sort());
  const scopedSyncGroups = useMemo(
    () => JSON.parse(scopeKey) as string[],
    [scopeKey],
  );
  const [claimError, setClaimError] = useState<Error | null>(null);
  const [claimConnected, setClaimConnected] = useState(false);

  // Reference-stable participant facade — same socket as entity sync,
  // so there is no `connect()` / `disconnect()` lifecycle here. The
  // engine manages the connection; the hook is a thin window onto its
  // already-attached presence + intent streams.
  const participant: EngineParticipant | null = useMemo(() => {
    if (!engine) return null;
    return { presence: engine.presence, intents: engine.intents };
  }, [engine]);

  // Status maps to the engine's sync state. `connecting` while the
  // engine bootstraps; `connected` once `engine.ready()` resolves and
  // any scoped participant claim has acked; `error` if the claim
  // fails; `disconnected` while paused or before the engine exists.
  const syncStatus = useSyncStatus();
  const needsClaim = scopedSyncGroups.length > 0;
  const status: ParticipantStatus = paused || !engine
    ? 'disconnected'
    : claimError
      ? 'error'
    : syncStatus.name === 'connected'
      ? needsClaim && !claimConnected
        ? 'connecting'
        : 'connected'
      : syncStatus.name === 'disconnected' || syncStatus.name === 'needs-auth'
        ? 'disconnected'
        : 'connecting';
  const error: Error | null = claimError;

  useEffect(() => {
    setClaimError(null);
    setClaimConnected(false);
    if (paused || !engine || scopedSyncGroups.length === 0) return;
    if (syncStatus.name !== 'connected') return;
    const ws = engine._ws;
    if (!ws) return;

    let cancelled = false;
    const claimId = createParticipantClaimId();
    ws.sendClaim(claimId, scopedSyncGroups, {
      ttlSeconds: parseParticipantTtlSeconds(opts.ttlSeconds),
    })
      .then(() => {
        if (!cancelled) setClaimConnected(true);
      })
      .catch((err) => {
        if (!cancelled) {
          setClaimError(err instanceof Error ? err : new Error(String(err)));
        }
      });

    return () => {
      cancelled = true;
      ws.sendRelease(claimId);
    };
  }, [engine, paused, scopeKey, syncStatus.name, opts.ttlSeconds]);

  // Bridge the engine's presence + intents streams into React state.
  // Plain useState + useEffect is sufficient — mid-frame tearing on a
  // peer list is harmless (users won't notice one frame of stale
  // presence). Queries and sync status use useSyncExternalStore
  // because transactions CAN tear visibly; presence can't.
  const [peers, setPeers] = useState<ReadonlyArray<Peer>>(EMPTY_PRESENCE);
  const [claims, setClaims] = useState<ReadonlyArray<ActiveIntent>>(EMPTY_INTENTS);

  useEffect(() => {
    if (!participant || paused) {
      setPeers(EMPTY_PRESENCE);
      setClaims(EMPTY_INTENTS);
      return;
    }
    setPeers(participant.presence.others);
    setClaims(participant.intents.others);
    const unsubPresence = participant.presence.onChange(() => {
      setPeers(participant.presence.others);
    });
    const unsubIntents = participant.intents.onChange(() => {
      setClaims(participant.intents.others);
    });
    return () => {
      unsubPresence();
      unsubIntents();
    };
  }, [participant, paused]);

  // `opts.as`, `opts.agent`, `opts.idempotencyKey`, and
  // `opts.autoRefreshThresholdSeconds` remain migration placeholders
  // for future capability-mint/attenuation wiring. `scope` is already
  // active: it opens a multiplexed claim on the engine WebSocket.

  return { participant, peers, claims, status, error };
}

// ── Escape-hatches: raw engine/store access ──────────────────────────

/**
 * Returns the raw `SyncEngine` proxy. Typically you want the typed
 * hooks (`useQuery`, `useOne`, `useMutate`) — this is for rare cases
 * where you need direct access (e.g., `sync.tasks.onChange(cb)`).
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
export function useSync<R extends SchemaRecord = SchemaRecord>(): Ablo<R> {
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
  return ctx.engine as Ablo<R>;
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
