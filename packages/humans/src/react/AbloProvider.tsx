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
import type { Schema, SchemaRecord } from '@abloatai/transaction/schema/schema';
import type { AbloClient as Ablo } from '../client.js';
import type { PresenceSession } from '@abloatai/transaction/presence';
import type { GroupScope } from '../local/sync/scopeGroups.js';
import { resolveScopeGroups } from '../local/sync/scopeGroups.js';
import { SyncContext, type SyncStoreContract } from './context.js';
import { AbloInternalContext, type AbloInternalContextValue } from './internalContext.js';
import { AbloValidationError } from '@abloatai/transaction/errors';
import { useSyncStatus } from './useSyncStatus.js';
import { DefaultFallback } from './DefaultFallback.js';
import { presenceOfClient } from '../presence/index.js';

/**
 * Ablo umbrella provider — owns the sync engine, multiplayer, and
 * the full lifecycle (Strict-Mode-safe singleton, `beforeunload`,
 * session-expiry handling, post-bootstrap hooks).
 *
 * Design goals:
 *
 *   - **One component, one import.** Consumers write the provider
 *     once at the root; nothing else needs to plumb the engine.
 *   - **Multiplayer is default.** React consumers share the client's scoped
 *     groups, presence stream, and model surface without another join step.
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
 * binding over it:
 *
 * ```tsx
 * // Build once at module scope — a new instance per render tears down the socket.
 * // The endpoint string points at your session-mint route (`ablo init`
 * // scaffolds it); the SDK fetches it and keeps the token fresh.
 * const ablo = Ablo({ schema, session: { endpoint: '/api/ablo-session' } });
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
   * the bootstrap gate, error/​session forwarding).
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
   * Fired after the client has completed its terminal authentication cleanup
   * (or surfaced a cleanup failure). Use it for app side effects such as a
   * redirect to sign-in or clearing analytics identity.
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
  // wake/online/focus re-mint — see `Ablo({ apiKey })`), transport, and
  // `dispose()`. The CONSUMER built the client, so the consumer owns teardown;
  // the provider never disposes it.
  const engine = client;
  const schema = engine.schema;

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
  //   1. Forward the client's completed terminal-session transition to
  //      onSessionExpired. Credential cleanup lives in the CLIENT, so direct
  //      consumers and React consumers have the same security boundary.
  //   2. Drive `ready()` (idempotent) so bootstrap starts on mount, then read the
  //      resolved org scope for SyncContext.
  // It does NOT dispose the client (consumer-owned) and does NOT touch auth.
  useEffect(() => {
    let stale = false;

    const unsubscribeSession = engine.onSessionError((err) => {
      errorEmitter.emit(err);
      void (async () => {
        try {
          await onSessionExpiredRef.current?.();
        } catch (hookErr) {
          errorEmitter.emit(hookErr as Error);
        }
      })().catch(() => {
        // Only a throwing errorEmitter subscriber can land here — it was
        // already the error-reporting path, so swallow rather than surface
        // an unhandled rejection loop.
      });
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
    return () => { window.removeEventListener('beforeunload', handler); };
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


const EMPTY_PRESENCE: readonly PresenceSession[] = Object.freeze([]);

export type { GroupScope };

/**
 * Read-only presence: the other sessions currently visible to this
 * connection, bridged to React. This is a pure reader of the engine's
 * already-flowing presence stream; it does not mutate connection groups.
 *
 * Pass `scope` to narrow to the peers on that scope's sync group(s); omit
 * it to get everyone on the engine's groups. Membership is driven entirely
 * by the presence channel (set server-side on connect, independent of any
 * cursor/collaboration traffic), so reading it never affects what the
 * connection is subscribed to and can't deadlock against a gated channel.
 *
 * Use this to answer "is anyone else here?", for example to suppress
 * live-cursor broadcasts while alone.
 *
 * ```ts
 * const peers = usePeers({ reports: reportId });
 * const alone = !peers.some((p) => p.participantKind === 'user');
 * ```
 */
export function usePeers(scope?: GroupScope): readonly PresenceSession[] {
  const ctx = useContext(AbloInternalContext);
  const engine = ctx?.engine ?? null;

  // Resolve scope → groups through the schema.
  // The stringified, sorted key is the stable effect dependency.
  const scopeKey = JSON.stringify(
    resolveScopeGroups(scope, engine?.schema).sort(),
  );
  const groups = useMemo(() => JSON.parse(scopeKey) as string[], [scopeKey]);

  const [peers, setPeers] = useState<readonly PresenceSession[]>(EMPTY_PRESENCE);

  useEffect(() => {
    if (!engine) {
      setPeers(EMPTY_PRESENCE);
      return;
    }
    const presence = presenceOfClient(engine);
    const compute = (): readonly PresenceSession[] =>
      groups.length === 0
        ? presence.others
        : presence.others.filter((session) =>
            session.activities.some(({ target }) =>
              target.id !== undefined && groups.includes(
                `${target.model.toLowerCase()}:${target.id}`,
              ),
            ),
          );
    // Plain useState + onChange — presence changes on connect/disconnect/activity
    // only (never on cursor traffic, a separate channel), so this fires
    // rarely; a frame of stale presence is harmless.
    setPeers(compute());
    return presence.onChange(() => { setPeers(compute()); });
  }, [engine, groups, scopeKey]);

  return peers;
}

// ── Escape-hatches: raw engine/store access ──────────────────────────

/**
 * Returns the raw `SyncEngine` proxy. Typically you want the typed
 * hooks (`useQuery`, `useOne`, `useMutate`) — this is for rare cases
 * where you need direct access (e.g., `sync.items.onChange(cb)`).
 *
 * The generic parameter narrows the return type to your schema's
 * model record so call sites get typed `sync.items.findMany()` /
 * `sync.sections.create(...)` without a cast at the call site:
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
  return rebindProviderEngine(ctx.engine);
}

function rebindProviderEngine<R extends SchemaRecord>(
  engine: Ablo<SchemaRecord>,
): Ablo<R> {
  return engine as Ablo<R>;
}

/**
 * Returns the underlying `SyncStoreContract` (the BaseSyncedStore).
 * Most consumers should prefer the typed hooks (`useQuery` etc.); this
 * is for advanced cases like direct InstanceCache access or custom
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
  if (!sync?.store) {
    throw new AbloValidationError(
      'useSyncStore: the sync engine has not yet initialized. Wrap ' +
        'consumers in <ClientSideSuspense> or guard on useSyncStatus().',
      { code: 'sync_not_ready' },
    );
  }
  return sync.store as T;
}
