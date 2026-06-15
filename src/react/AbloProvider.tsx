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
import type {
  ActiveClaim,
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
 * The one required prop is a prebuilt {@link Ablo} client — the client
 * owns auth and the credential lifecycle; this provider is the reactive
 * binding over it (Stripe's `<Elements stripe={...}>` model):
 *
 * ```tsx
 * // Build once at module scope — a new instance per render tears down the socket.
 * const ablo = Ablo({
 *   schema,
 *   getToken: () =>
 *     fetch('/api/ablo-session', { method: 'POST' })
 *       .then((r) => r.json())
 *       .then((d) => d.token),
 * });
 *
 * <AbloProvider client={ablo}>
 *   <App />
 * </AbloProvider>
 * ```
 *
 * That's it for most apps. `userId` is informational; the `fallback`,
 * `preventUnsavedChanges`, and `on*` props are opt-in app glue; and the
 * block tagged "Optional DI (advanced)" below is escape-hatch wiring for
 * tests and platform builders — if you don't recognize a prop there, you
 * don't need it.
 */
export interface AbloProviderProps<R extends SchemaRecord = SchemaRecord> {
  /**
   * A prebuilt {@link Ablo} client — **the only way to configure the engine.**
   * Construct it yourself with `Ablo({ schema, apiKey, ... })` and pass the
   * instance: the CLIENT owns auth, the credential lifecycle, transport, and
   * connection; this provider is the thin REACTIVE binding over it (context,
   * the bootstrap gate, error/​session forwarding). Mirrors Stripe
   * `<Elements stripe={...}>` and a Supabase client passed into a context.
   *
   * Memoize it (build it once, e.g. with `useMemo` or module scope) — a new
   * instance each render re-keys the bootstrap gate and tears down the socket.
   */
  client: Ablo<R>;

  /**
   * The app user id, surfaced via `useCurrentUserId()` for app-owned fields.
   * Purely informational for the React tree — sync identity is resolved by the
   * client from its auth, not from this. Optional.
   */
  userId?: string;

  /**
   * Block tab close while there are unsynced local writes (the standard
   * `beforeunload` prompt). Browsers ignore custom messages — don't pass one.
   */
  preventUnsavedChanges?: boolean;

  /**
   * Fired when the server rejects the session. The provider has ALREADY called
   * `client.purge()` (disposed + wiped IndexedDB) by the time this runs — use it
   * for app side effects (redirect to sign-in, clear analytics identity).
   */
  onSessionExpired?: () => void | Promise<void>;

  /**
   * Fired on any error the provider surfaces (engine/WebSocket/bootstrap). For
   * Sentry/Datadog. React-only consumers can use `useErrorListener()` instead.
   */
  onError?: (error: Error) => void;

  /** @internal placeholder so the old WS-URL prop shape doesn't silently leak in. */
  url?: never;

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
    client,
    userId,
    preventUnsavedChanges,
    onSessionExpired,
    onError,
    fallback = <DefaultFallback />,
    children,
  } = props;

  // The client IS the engine — synchronous, never null. This provider is a
  // REACTIVE binding over it (context + bootstrap gate + error/session
  // forwarding); it does NOT construct, configure, or own the connection. The
  // client owns auth, the credential lifecycle (first mint, refresh, and
  // wake/online/focus re-mint — see `Ablo({ getToken })`), transport, and
  // `dispose()`. The CONSUMER built the client, so the consumer owns teardown;
  // the provider never disposes it.
  const engine = client;
  const schema = engine.schema as Schema<R>;

  // Account scope isn't a prop — read it from `_store.orgId` once `ready()`
  // resolves the identity from the client's auth.
  const [resolvedAccountScope, setResolvedAccountScope] = useState<string | null>(null);

  // ── Error emitter (provider-instance scoped) ─────────────────────
  const errorEmitterRef = useRef<ReturnType<typeof createErrorEmitter> | null>(null);
  if (!errorEmitterRef.current) {
    errorEmitterRef.current = createErrorEmitter();
  }
  const errorEmitter = errorEmitterRef.current;

  // Stash callbacks in refs so a new identity each render doesn't re-run the
  // start effect (the `useEventCallback` idiom).
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  useEffect(() => {
    return errorEmitter.subscribe((err) => onErrorRef.current?.(err));
  }, [errorEmitter]);
  const onSessionExpiredRef = useRef(onSessionExpired);
  onSessionExpiredRef.current = onSessionExpired;

  // Re-key the bootstrap gate when the client INSTANCE changes — a genuinely new
  // engine is a fresh "first bootstrap". Stable for the common single-client app.
  const clientGenRef = useRef<{ client: Ablo<R>; gen: number }>({ client, gen: 0 });
  if (clientGenRef.current.client !== client) {
    clientGenRef.current = { client, gen: clientGenRef.current.gen + 1 };
  }
  const engineKey = String(clientGenRef.current.gen);

  // ── Start + session-error wiring ─────────────────────────────────
  //
  // Two reactive jobs only:
  //   1. Forward a SERVER session-rejection → purge (wipe IndexedDB so the next
  //      login starts clean) → onSessionExpired (the app redirects). The
  //      offline/transient-vs-terminal credential logic lives in the CLIENT now.
  //   2. Drive `ready()` (idempotent) so bootstrap starts on mount, then read the
  //      resolved org scope for SyncContext.
  // It does NOT dispose the client (consumer-owned) and does NOT touch auth.
  useEffect(() => {
    let stale = false;

    const unsubscribeSession = engine.onSessionError(async (err) => {
      errorEmitter.emit(err);
      try {
        await engine.purge();
      } catch {}
      try {
        await onSessionExpiredRef.current?.();
      } catch (hookErr) {
        errorEmitter.emit(hookErr as Error);
      }
    });

    engine
      .ready()
      .then(() => {
        if (stale) return;
        setResolvedAccountScope(
          (engine._store as SyncStoreContract & { orgId?: string }).orgId ?? null,
        );
      })
      .catch((err) => {
        if (stale) return;
        errorEmitter.emit(err as Error);
      });

    return () => {
      stale = true;
      unsubscribeSession();
    };
  }, [engine, errorEmitter]);

  // ── beforeunload + preventUnsavedChanges ─────────────────────────

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (event: BeforeUnloadEvent) => {
      // Best-effort IDB flush on TAB CLOSE — the client is going away with the
      // page regardless. This is NOT an unmount teardown: the consumer owns the
      // client's lifecycle and the provider never disposes it on unmount.
      void engine.dispose();
      if (preventUnsavedChanges && engine._store.hasUnsyncedChanges) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [engine, preventUnsavedChanges]);

  // ── SyncContext value (for useQuery/useOne/useMutate hooks) ──────
  //
  // The engine is always present (it's the `client` prop), but its org scope is
  // unknown until `ready()` resolves identity — so `syncValue` is null until
  // then, which drives the initial fallback below.
  const syncValue = useMemo(() => {
    const currentAccountScope =
      resolvedAccountScope ??
      (engine._store as SyncStoreContract & { orgId?: string }).orgId;
    if (!currentAccountScope) return null;
    return {
      store: engine._store,
      organizationId: currentAccountScope,
      schema,
    };
  }, [engine, resolvedAccountScope, schema]);

  // ── Internal context (currentUserId + error subscription) ────────

  const internalValue = useMemo<AbloInternalContextValue>(() => ({
    currentUserId: userId ?? null,
    subscribeError: errorEmitter.subscribe,
    emitError: errorEmitter.emit,
    engine: engine as Ablo<SchemaRecord>,
  }), [userId, errorEmitter, engine]);

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
          <BootstrapGate key={engineKey} fallback={fallback}>
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
  /**
   * Acquire a write-claim CLAIM on the scope, in addition to read interest.
   *
   * Default `false`: opening a scope subscribes the connection to its deltas
   * (read interest, via `update_subscription`) but does NOT claim it — a
   * viewer is not a claimant. Set `true` when the participant intends to
   * WRITE (editing a deck, an agent staking work): the claim is sent so peers
   * observe it, and the scope is pinned so it stays subscribed (never warms)
   * for as long as the claim is held.
   */
  readonly claim?: boolean;
  /**
   * Backfill the scope's CURRENT state into the pool on enter, in addition to
   * tailing live changes.
   *
   * Default `false`: entering a scope subscribes to its FUTURE deltas only — if
   * the scope's rows aren't already loaded, the view is empty until something
   * changes. Set `true` when opening an entity that may not be loaded yet (a
   * deep-linked deck, a never-opened sheet) so its current rows are fetched and
   * injected once, then kept fresh by the live tail. The fetch is single-flight
   * and runs once per group; a failure soft-fails (the live tail still flows).
   */
  readonly hydrate?: boolean;
}

/** @deprecated Use `ParticipantStatus`. */
export type MeshParticipantStatus = ParticipantStatus;

export interface UseParticipantReturn {
  readonly participant: EngineParticipant | null;
  /** Everyone else on the engine's sync groups (`participant.presence.others`), bridged to React. */
  readonly peers: ReadonlyArray<Peer>;
  /** Active claim claims by peers (`participant.claims.others`), bridged to React. */
  readonly claims: ReadonlyArray<ActiveClaim>;
  readonly status: ParticipantStatus;
  readonly error: Error | null;
}

const EMPTY_PRESENCE: ReadonlyArray<Peer> = Object.freeze([]);
const EMPTY_INTENTS: ReadonlyArray<ActiveClaim> = Object.freeze([]);

/**
 * Join multiplayer for a given scope. Returns the participant and its
 * lifecycle status. Auto-cleans up on unmount or when `paused`
 * flips to true.
 *
 * The returned `participant` is an `EngineParticipant` — `.presence`
 * + `.claims` only — backed by the engine's existing socket. For
 * headless-bot patterns (a separate identity in the same browser
 * tab), construct a second `Ablo({ kind: 'agent', ... })` directly.
 */
export function useParticipant(opts: UseParticipantOptions): UseParticipantReturn {
  const ctx = useContext(AbloInternalContext);
  const engine = ctx?.engine ?? null;
  const { paused = false } = opts;
  // Resolve the model-form scope ({ decks: id } / refs) THROUGH the schema, so a
  // model's declared `scope` kind is honored (typename `SlideDeck` → `deck:<id>`,
  // not the `type:id` string fallback). Schema appears once the engine is ready;
  // until then refs resolve by convention, then re-resolve when it arrives.
  const scopeKey = JSON.stringify(
    resolveParticipantSyncGroups(opts.scope, engine?.schema).sort(),
  );
  const scopedSyncGroups = useMemo(
    () => JSON.parse(scopeKey) as string[],
    [scopeKey],
  );
  const [claimError, setClaimError] = useState<Error | null>(null);
  const [claimConnected, setClaimConnected] = useState(false);

  // Reference-stable participant facade — same socket as entity sync,
  // so there is no `connect()` / `disconnect()` lifecycle here. The
  // engine manages the connection; the hook is a thin window onto its
  // already-attached presence + claim streams.
  const participant: EngineParticipant | null = useMemo(() => {
    if (!engine) return null;
    return { presence: engine.presence, claims: engine.claims };
  }, [engine]);

  // Status maps to the engine's sync state. `connecting` while the
  // engine bootstraps; `connected` once `engine.ready()` resolves and
  // any scoped participant claim has acked; `error` if the claim
  // fails; `disconnected` while paused or before the engine exists.
  const syncStatus = useSyncStatus();
  // Only a write-claim participant waits on a claim ack. A pure reader
  // (the default) is `connected` as soon as the engine is — its read
  // interest is fire-and-forget `update_subscription`, not a claim.
  const needsClaim = !!opts.claim && scopedSyncGroups.length > 0;
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

  // ── Read interest (always) ───────────────────────────────────────
  // Subscribe the connection to the scope's sync groups while mounted +
  // connected — the area-of-interest navigation primitive. No claim, no
  // TTL: a viewer just receives the scope's deltas. Hysteresis (warm TTL)
  // lives in the store's AreaOfInterestManager, so a quick unmount/remount
  // (tab flip) doesn't re-bootstrap.
  useEffect(() => {
    const scope = opts.scope;
    if (paused || !engine || !scope || scopedSyncGroups.length === 0) return;
    if (syncStatus.name !== 'connected') return;
    const store = engine._store;
    // `hydrate` backfills the scope's current state after subscribing
    // (store handles subscribe-first ordering + single-flight). leaveScope
    // only moves read interest; the hydrated rows stay in the pool.
    void store.enterScope?.(scope, { hydrate: opts.hydrate });
    return () => {
      void store.leaveScope?.(scope);
    };
    // scopeKey is the stable proxy for the resolved groups; same idiom as
    // the claim effect below.
  }, [engine, paused, scopeKey, syncStatus.name, opts.hydrate]);

  // ── Write claim (opt-in: `claim: true`) ─────────────────────────
  // A claim is the write-claim primitive — distinct from read interest
  // above. Only sent when the caller opts in; it makes peers observe the
  // claim and pins the scope so it never warms while held.
  useEffect(() => {
    setClaimError(null);
    setClaimConnected(false);
    const scope = opts.scope;
    if (paused || !engine || !opts.claim || !scope || scopedSyncGroups.length === 0)
      return;
    if (syncStatus.name !== 'connected') return;
    const ws = engine._ws;
    if (!ws) return;
    const store = engine._store;

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
    // Prominence: hold the scope subscribed for as long as the claim lives.
    void store.pinScope?.(scope);

    return () => {
      cancelled = true;
      ws.sendRelease(claimId);
      void store.unpinScope?.(scope);
    };
  }, [engine, paused, scopeKey, syncStatus.name, opts.ttlSeconds, opts.claim]);

  // Bridge the engine's presence + claims streams into React state.
  // Plain useState + useEffect is sufficient — mid-frame tearing on a
  // peer list is harmless (users won't notice one frame of stale
  // presence). Queries and sync status use useSyncExternalStore
  // because transactions CAN tear visibly; presence can't.
  const [peers, setPeers] = useState<ReadonlyArray<Peer>>(EMPTY_PRESENCE);
  const [claims, setClaims] = useState<ReadonlyArray<ActiveClaim>>(EMPTY_INTENTS);

  useEffect(() => {
    if (!participant || paused) {
      setPeers(EMPTY_PRESENCE);
      setClaims(EMPTY_INTENTS);
      return;
    }
    setPeers(participant.presence.others);
    setClaims(participant.claims.others);
    const unsubPresence = participant.presence.onChange(() => {
      setPeers(participant.presence.others);
    });
    const unsubClaims = participant.claims.onChange(() => {
      setClaims(participant.claims.others);
    });
    return () => {
      unsubPresence();
      unsubClaims();
    };
  }, [participant, paused]);

  // `opts.as`, `opts.agent`, `opts.idempotencyKey`, and
  // `opts.autoRefreshThresholdSeconds` remain migration placeholders
  // for future capability-mint/attenuation wiring. `scope` is already
  // active: it opens a multiplexed claim on the engine WebSocket.

  return { participant, peers, claims, status, error };
}

/**
 * Read-only presence: the OTHER participants currently visible to this
 * connection, bridged to React. Unlike {@link useParticipant}, this does
 * NOT enter/leave a scope (no `update_subscription`, no warm-TTL churn) —
 * it is a pure reader of the engine's already-flowing presence stream.
 *
 * Pass `scope` to narrow to the peers on that scope's sync group(s); omit
 * it to get everyone on the engine's groups. Membership is driven entirely
 * by the presence channel (set server-side on connect, independent of any
 * cursor/collaboration traffic), so reading it never affects what the
 * connection is subscribed to and can't deadlock against a gated channel.
 *
 * Use this to answer "is anyone else here?" — e.g. suppressing live-cursor
 * broadcasts while alone — when some OTHER mount already owns the scope's
 * read interest (scope `leave` is not reference-counted, so a second
 * `useParticipant` on the same scope would warm-drop the owner's
 * subscription on unmount).
 *
 * ```ts
 * const peers = usePeers({ slideDecks: deckId });
 * const alone = !peers.some((p) => p.participantKind === 'user');
 * ```
 */
export function usePeers(scope?: ParticipantScope): ReadonlyArray<Peer> {
  const ctx = useContext(AbloInternalContext);
  const engine = ctx?.engine ?? null;

  // Resolve scope → groups through the schema (same idiom as useParticipant).
  // The stringified, sorted key is the stable effect dependency.
  const scopeKey = JSON.stringify(
    resolveParticipantSyncGroups(scope, engine?.schema).sort(),
  );
  const groups = useMemo(() => JSON.parse(scopeKey) as string[], [scopeKey]);

  const [peers, setPeers] = useState<ReadonlyArray<Peer>>(EMPTY_PRESENCE);

  useEffect(() => {
    if (!engine) {
      setPeers(EMPTY_PRESENCE);
      return;
    }
    const presence = engine.presence;
    const compute = (): ReadonlyArray<Peer> =>
      groups.length === 0
        ? presence.others
        : presence.others.filter((p) =>
            p.syncGroups.some((g) => groups.includes(g)),
          );
    // Plain useState + onChange — presence changes on join/leave/activity
    // only (never on cursor traffic, a separate channel), so this fires
    // rarely; a frame of stale presence is harmless (same rationale as
    // useParticipant's peers bridge).
    setPeers(compute());
    return presence.onChange(() => setPeers(compute()));
  }, [engine, scopeKey]);

  return peers;
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
  return ctx.engine as unknown as Ablo<R>;
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
