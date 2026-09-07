'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  createContext,
  type ReactNode,
} from 'react';
import type { Schema, SchemaRecord } from '@abloatai/transaction/schema/schema';
import type { AbloClient as Ablo } from '../client.js';
import { AbloStoreContext, type SyncStoreContract } from './context.js';
import { AbloInternalContext, type AbloInternalContextValue } from './internalContext.js';
import { AbloValidationError } from '@abloatai/transaction/errors';
import { useAblo } from './useAblo.js';
import { DefaultFallback } from './DefaultFallback.js';

/** Reactive binding over an application-owned client. Starts readiness,
 * forwards errors and gates bootstrap; the application owns client disposal.
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
 * That's it for most apps. The `fallback`,
 * `preventUnsavedChanges`, and `on*` props are opt-in app glue; and the
 * block tagged "Optional DI (advanced)" below is escape-hatch wiring for
 * tests and platform builders — if you don't recognize a prop there, you
 * don't need it.
 */
// ── Implementation ───────────────────────────────────────────────────

export function AbloProvider<R extends SchemaRecord = SchemaRecord>(
  props: AbloProvider.Props<R>,
): React.ReactElement {
  const {
    client,
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
  const [resolvedScope, setResolvedScope] = useState<{ engine: typeof engine; account: string | null } | null>(null);

  // Stash callbacks in refs so a new identity each render doesn't re-run the
  // start effect (the `useEventCallback` idiom).
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const reportError = useCallback((error: Error) => {
    try { onErrorRef.current?.(error); } catch { /* Error reporting must not interrupt session cleanup. */ }
  }, []);
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
  //      resolved org scope for the Ablo store context.
  // It does NOT dispose the client (consumer-owned) and does NOT touch auth.
  useEffect(() => {
    let stale = false;

    const unsubscribeSession = engine.onSessionError((err) => {
      reportError(err);
      void (async () => {
        try {
          await onSessionExpiredRef.current?.();
        } catch (hookErr) {
          reportError(hookErr as Error);
        }
      })().catch(() => {
        // This was
        // already the error-reporting path, so swallow rather than surface
        // an unhandled rejection loop.
      });
    });

    engine
      .ready()
      .then(() => {
        if (stale) return;
        setResolvedScope({
          engine,
          account: (engine._store as SyncStoreContract & { orgId?: string }).orgId ?? null,
        });
      })
      .catch((err) => {
        if (stale) return;
        reportError(err as Error);
      });

    return () => {
      stale = true;
      unsubscribeSession();
    };
  }, [engine, reportError]);

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

  // ── Store context value (for Ablo data hooks) ────────────────────
  //
  // The engine is always present (it's the `client` prop), but its org scope is
  // unknown until `ready()` resolves identity — so the store context is null until
  // then, which drives the initial fallback below.
  const storeContextValue = useMemo(() => {
    const currentAccountScope =
      (resolvedScope?.engine === engine ? resolvedScope.account : null) ??
      (engine._store as SyncStoreContract & { orgId?: string }).orgId;
    if (!currentAccountScope) return null;
    return {
      store: engine._store,
      organizationId: currentAccountScope,
      schema,
    };
  }, [engine, resolvedScope, schema]);

  // The React tree holds the same client used by core code.

  const internalValue = useMemo<AbloInternalContextValue>(() => ({
    engine: engine as Ablo<SchemaRecord>,
  }), [engine]);

  // ── Render ───────────────────────────────────────────────────────
  //
  // Keep the context tree stable during startup so passthrough children retain
  // their component state when authenticated row scope becomes available.
  const passthrough = fallback === 'passthrough';

  return (
    <AbloInternalContext.Provider value={internalValue}>
      <AbloStoreContext.Provider value={storeContextValue}>
        {passthrough ? (
          children
        ) : storeContextValue ? (
          <BootstrapGate key={engineKey} fallback={fallback}>
            {children}
          </BootstrapGate>
        ) : fallback}
      </AbloStoreContext.Provider>
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
 * Re-keyed when the client instance changes so account rotations reset the latch — a new engine genuinely IS
 * a new "first bootstrap" cycle.
 */
function BootstrapGate({
  fallback,
  children,
}: {
  readonly fallback: ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  const status = useAblo(ablo => ablo.status);
  const [everConnected, setEverConnected] = useState(false);

  useEffect(() => {
    if (
      status?.name === 'connected' ||
      status?.name === 'reconnecting' ||
      status?.name === 'disconnected'
    ) {
      setEverConnected(true);
    }
  }, [status?.name]);

  const showFallback = !everConnected && status?.name === 'connecting';
  return <>{showFallback ? fallback : children}</>;
}

/** Props for wrappers around the provider, using the same schema parameter. */
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace AbloProvider {
  export interface Props<R extends SchemaRecord = SchemaRecord> {
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
     * Sentry/Datadog or application error UI.
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
     * (for example, `useAblo(ablo => ablo.status)` checks).
     * Useful for pages that mount debug helpers, error boundaries, or
     * analytics that must run pre-ready.
     */
    fallback?: ReactNode | 'passthrough';

    children: ReactNode;
  }
}
