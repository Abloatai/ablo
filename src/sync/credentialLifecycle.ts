/**
 * credentialLifecycle — reconnect-credential re-mint + proactive pre-roll.
 *
 * Extracted from BaseSyncedStore.ts as a cohesive leaf: owns the re-mint
 * hook, the single-flight guard, and the browser-only proactive refresh
 * (timer + OS-wake listener). The store keeps thin public delegates
 * (`setCredentialRefresher` / `performCredentialRefresh` /
 * `startCredentialLifecycle`) so its published surface is unchanged, and
 * talks back through the minimal {@link CredentialLifecycleContext} —
 * never the store's class type — so no module cycle forms.
 */

import { getContext } from '../context.js';
import type { RecoveryClass } from '../errorCodes.js';

/**
 * Tri-state outcome of a credential re-mint, mirroring the `getToken`
 * contract (see {@link CredentialLifecycle.refresh}).
 */
export type CredentialRefreshOutcome = 'refreshed' | 'session_error' | 'network_error';

/**
 * What an auth-rejected transport should do after the backbone has run:
 * `'retry'` = a fresh credential is in the credential source, replay the
 * request ONCE; `'stop'` = don't replay (terminal session loss, a rejection
 * a re-mint can't cure, or a transient mint failure the caller's own
 * retry/revalidation path will recover later).
 */
export type CredentialRecoveryOutcome = 'retry' | 'stop';

/**
 * What a credential refresher may resolve with. The plain-string form is the
 * classic `getToken` contract; the object form additionally carries the mint
 * response's `expiresAt` (ISO string / epoch ms / Date) so the proactive
 * pre-roll can schedule off the credential's ACTUAL lifetime instead of
 * assuming the server's default TTL.
 */
export type CredentialRefreshResult =
  | string
  | { readonly token: string; readonly expiresAt?: string | number | Date }
  | null;

/** A credential re-mint hook. `Promise<string | null>` resolvers remain
 *  assignable — the widened result type is a superset. */
export type CredentialRefresher = () => Promise<CredentialRefreshResult>;

/** Fallback pre-roll cadence AND ceiling — the historical 10-minute value,
 *  comfortably inside the server's 15m default `ek_` TTL. Used verbatim when
 *  the refresher reports no expiry. */
export const DEFAULT_PREROLL_INTERVAL_MS = 10 * 60 * 1000;

/** Floor so a very short (or already-elapsed) TTL can't hot-loop the mint. */
export const MIN_PREROLL_DELAY_MS = 30 * 1000;

/**
 * When to pre-roll a credential that expires at `expiresAtMs`: after ~2/3 of
 * the REMAINING lifetime (15m TTL → 10m, exactly the historical cadence),
 * clamped to [{@link MIN_PREROLL_DELAY_MS}, {@link DEFAULT_PREROLL_INTERVAL_MS}].
 * Unknown expiry (`null`) → the 10-minute fallback. Exported for unit tests.
 */
export function computePrerollDelayMs(expiresAtMs: number | null, nowMs: number): number {
  if (expiresAtMs === null || !Number.isFinite(expiresAtMs)) {
    return DEFAULT_PREROLL_INTERVAL_MS;
  }
  const remaining = expiresAtMs - nowMs;
  if (remaining <= 0) return MIN_PREROLL_DELAY_MS;
  const twoThirds = Math.floor((remaining * 2) / 3);
  return Math.min(Math.max(twoThirds, MIN_PREROLL_DELAY_MS), DEFAULT_PREROLL_INTERVAL_MS);
}

/** Narrow a refresher-supplied `expiresAt` to epoch ms, or `null` when
 *  absent/unparseable (→ fallback cadence, never a crash). */
function normalizeExpiresAtMs(expiresAt: string | number | Date | undefined): number | null {
  if (expiresAt === undefined) return null;
  const ms =
    expiresAt instanceof Date
      ? expiresAt.getTime()
      : typeof expiresAt === 'number'
        ? expiresAt
        : Date.parse(expiresAt);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * What the lifecycle needs back from its host store. Deliberately minimal —
 * three callbacks, all resolved lazily at call time (the ConnectionManager
 * behind two of them doesn't exist until `setupWebSocketSync`).
 */
export interface CredentialLifecycleContext {
  /** Push a freshly-minted access token into the shared credential source
   *  (no-op when the deployment wired no credential source). */
  setAuthToken(token: string): void;
  /** Nudge the connection FSM to re-probe with the current credential —
   *  the host's `nudgeReconnect()` (`CREDENTIAL_REFRESHED`). */
  nudgeReconnect(): void;
  /** Surface a terminal session loss to the connection FSM
   *  (`BOOTSTRAP_FAILED_SESSION`) — the long-lived login is gone. */
  reportSessionExpired(): void;
}

export class CredentialLifecycle {
  /**
   * Re-mint hook for the short-lived access credential (the Stripe-style
   * `ek_`/`rk_`). Wired by the React provider from its `getToken`/`authEndpoint`
   * — the engine owns WHEN to refresh (a stale-credential probe / an external
   * nudge), the integrator owns HOW to mint. Mirrors the `getToken` contract:
   * resolves a token string on success, `null` when the long-lived login is
   * gone (terminal), and THROWS on a transient/offline failure. Used by
   * {@link refresh}. Absent ⇒ no silent re-mint (e.g. a static
   * `apiKey` deployment whose credential source refreshes out-of-band).
   */
  private credentialRefresher: CredentialRefresher | null = null;

  /** Single-flight guard so a wake nudge + an in-flight request + a probe don't
   *  all mint at once (the classic "token thrash → random logout" bug). */
  private inFlightCredentialRefresh: Promise<CredentialRefreshOutcome> | null = null;

  /** Teardown for the proactive credential lifecycle (refresh timer + wake/
   *  online/focus listeners) installed by {@link start};
   *  cleared on `BaseSyncedStore.disconnect`. Null when no resolver is wired. */
  private credentialLifecycleTeardown: (() => void) | null = null;

  /** Epoch ms the CURRENT credential expires, when the refresher reports it
   *  (object-form {@link CredentialRefreshResult}); `null` for the classic
   *  string-form resolver → the pre-roll falls back to its fixed cadence. */
  private credentialExpiresAtMs: number | null = null;

  /** Re-arm hook for the proactive pre-roll timer (set by {@link start}).
   *  Invoked after every successful mint so a REACTIVE refresh (probe, wake,
   *  the initial `ready()` mint) immediately re-anchors the schedule to the
   *  fresh credential's real expiry instead of a stale fixed delay. */
  private prerollReschedule: (() => void) | null = null;

  constructor(private readonly ctx: CredentialLifecycleContext) {}

  /**
   * Register the access-credential re-mint hook. Called by the React provider
   * with a thunk that mints a fresh `ek_`/`rk_` (typically its `getToken`).
   * See {@link credentialRefresher}.
   */
  setRefresher(refresher: CredentialRefresher | null): void {
    this.credentialRefresher = refresher;
  }

  /**
   * Re-mint the short-lived access credential and push it into the credential
   * source, reporting a tri-state outcome the `ConnectionManager` maps to
   * its FSM. The contract mirrors `getToken` (and PowerSync's `fetchCredentials`
   * / Liveblocks' `authEndpoint`, but made explicit instead of overloading
   * return/throw):
   *   - token string  → `'refreshed'`     (fresh key in place; re-probe & reconnect)
   *   - `null`        → `'session_error'` (login itself is gone → terminal, sign out)
   *   - throw         → `'network_error'` (couldn't reach the mint endpoint → transient)
   *
   * SINGLE-FLIGHT: concurrent callers (a wake nudge, an in-flight request, the
   * probe) share one in-flight promise so we never double-mint — the canonical
   * fix for the "every 401 mints a token → thrash → spurious logout" anti-pattern.
   *
   * No refresher wired ⇒ `'refreshed'` (a no-op re-probe): a static-`apiKey`
   * deployment has no session to re-mint from; its credential source refreshes
   * out-of-band, so we just re-probe with whatever it currently holds.
   */
  async refresh(): Promise<CredentialRefreshOutcome> {
    const refresher = this.credentialRefresher;
    if (!refresher) return 'refreshed';
    if (this.inFlightCredentialRefresh) return this.inFlightCredentialRefresh;

    const run = (async (): Promise<CredentialRefreshOutcome> => {
      try {
        const result = await refresher();
        const token = typeof result === 'string' ? result : result?.token;
        if (!token) {
          // null = the long-lived login is gone (mint endpoint answered 401/403).
          // Terminal — the FSM routes this to sign-out.
          return 'session_error';
        }
        // Object-form resolvers carry the mint's actual expiry; remember it so
        // the proactive pre-roll schedules off the real TTL (string-form
        // resolvers leave it null → fixed fallback cadence).
        this.credentialExpiresAtMs =
          typeof result === 'object' && result !== null
            ? normalizeExpiresAtMs(result.expiresAt)
            : null;
        this.ctx.setAuthToken(token);
        // Re-anchor the proactive pre-roll to the fresh credential's expiry.
        this.prerollReschedule?.();
        return 'refreshed';
      } catch (error) {
        // A throw = transient (offline / mint endpoint unreachable / 5xx). The
        // login may be perfectly valid; never sign out for this — back off and
        // retry. Mirrors the `getToken` throw-vs-null contract end-to-end.
        const message = (error as Error)?.message ?? String(error);
        // A relative-URL resolver invoked server-side (Node fetch has no origin
        // to resolve against) emits the opaque "Failed to parse URL" / "Only
        // absolute URLs are supported". Translate it into something actionable
        // instead of a mystery transient blip — the proactive refresh is now
        // browser-only, so hitting this means the resolver fired from SSR/RSC or
        // a server route.
        if (typeof window === 'undefined' && /parse URL|absolute URLs?/i.test(message)) {
          getContext().logger.warn(
            'credential resolver ran on the server with a relative URL — Node fetch needs an absolute URL. ' +
              'Refresh the Ablo client in the browser, or build an absolute URL server-side ' +
              "(e.g. new URL('/api/ablo-session', process.env.NEXT_PUBLIC_APP_URL)).",
            { error: message },
          );
        } else {
          getContext().logger.debug('access-credential re-mint failed (transient)', { error: message });
        }
        return 'network_error';
      }
    })();

    this.inFlightCredentialRefresh = run;
    try {
      return await run;
    } finally {
      this.inFlightCredentialRefresh = null;
    }
  }

  /**
   * Route a refresh outcome into the FSM — the ONE place the tri-state is
   * interpreted, shared by the proactive pre-roll, the wake nudge, and the
   * HTTP auth-recovery path so every trigger converges on identical behavior.
   */
  private routeRefreshOutcome(outcome: CredentialRefreshOutcome): CredentialRecoveryOutcome {
    if (outcome === 'refreshed') {
      // Fresh key already pushed into the credential source by `refresh`;
      // nudge a parked connection to re-probe with it.
      this.ctx.nudgeReconnect();
      return 'retry';
    }
    if (outcome === 'session_error') {
      // The long-lived login is gone (mint answered 401/403). Surface it —
      // a no-op in FSM states that don't accept the event (the probe
      // converges on sign-out there anyway); `session_expired`'s onEnter
      // owns the authoritative log.
      this.ctx.reportSessionExpired();
      return 'stop';
    }
    // 'network_error' → transient (offline / mint hiccup); the next proactive
    // tick or the FSM's own probe retries. Never sign out, never replay now.
    return 'stop';
  }

  /**
   * THE recovery backbone for auth-rejected requests, whatever the transport.
   * The WS probe already routes 401s through the FSM; HTTP consumers (the
   * lazy-query lane, bootstrap helpers) call THIS instead of inventing their
   * own handling — one single-flight mint, one outcome routing, one taxonomy.
   *
   * Mirrors `NetworkProbe`'s classification of the same codes:
   *   - `access_credential_expiry` — the routine case (an expired `ek_`/`rk_`):
   *     silently re-mint via the single-flight {@link refresh} and tell the
   *     caller to replay ONCE on success. Never a sign-out by itself — the
   *     only terminal path is the mint itself resolving `null`.
   *   - `session_expiry` — the login is gone. Report to the FSM (sign-out
   *     path) and stop; replaying is pointless.
   *   - `auth_blocked` / `permission` / everything else — re-minting produces
   *     the same rejected credential; stop without touching the FSM.
   */
  async recoverFromAuthRejection(recovery: RecoveryClass): Promise<CredentialRecoveryOutcome> {
    switch (recovery) {
      case 'access_credential_expiry':
        return this.routeRefreshOutcome(await this.refresh());
      case 'session_expiry':
        this.ctx.reportSessionExpired();
        return 'stop';
      default:
        return 'stop';
    }
  }

  /**
   * Install the access-credential lifecycle the CLIENT owns (this used to live
   * in the React provider — wrong layer). Two parts:
   *   1. REACTIVE — register `getToken` as the re-mint hook the FSM calls when a
   *      probe finds the key stale (`credential_stale`) or on a nudge.
   *   2. PROACTIVE — keep the short-lived key fresh ahead of trouble: a refresh
   *      timer inside the TTL, plus re-mint on OS wake. The ENTIRE proactive
   *      block is browser-gated (`typeof window`): server/SSR has no socket to
   *      keep warm and the resolver is browser-oriented, so arming it in Node
   *      would fire a relative-URL fetch and throw. (Agents pass a static
   *      `apiKey` with no resolver, so this method is never called for them.)
   *
   * Config-driven and invisible, like Supabase's `autoRefreshToken` — consumers
   * never call a refresh method. Idempotent (a second call replaces the first);
   * torn down on `BaseSyncedStore.disconnect`.
   *
   * `opts.proactiveInNode` arms the refresh TIMER on a windowless host too —
   * set for agent/system participants (long-lived server sockets whose
   * `rk_`/`ek_` must renew BEFORE the hub's keepalive reaper closes them; the
   * PowerSync/Ably "SDK renews everywhere" model). Node timers are `unref`ed
   * so a finishing script is never kept alive by the pre-roll. The OS-wake
   * listener remains browser-only regardless (no `window` to listen on).
   */
  start(getToken: CredentialRefresher, opts?: { proactiveInNode?: boolean }): void {
    this.stop();
    this.setRefresher(getToken);

    // Re-mint through the SAME single-flight path the FSM's reactive probe uses
    // (`refresh`) rather than calling `getToken()` directly. Two
    // wins over the old direct call:
    //   - SINGLE-FLIGHT: a wake nudge, an in-flight probe, and this proactive
    //     roll share one in-flight promise — no double-mint thrash.
    //   - The tri-state is HONOURED. The old code did `if (token) {…}` and
    //     dropped a `null` on the floor — a zombie session that re-minted on
    //     every tab focus and logged "signing out" forever without ever signing
    //     out. `session_error` now drives the FSM to actually expire.
    const refresh = async (): Promise<void> => {
      // Same outcome routing as every other trigger (see routeRefreshOutcome):
      // refreshed → nudge, session_error → report, network_error → wait for
      // the next tick / the FSM's own probe. Never sign out for a transient.
      this.routeRefreshOutcome(await this.refresh());
    };

    const teardowns: (() => void)[] = [];

    // The proactive pre-roll arms in the browser, or in Node when the host
    // OPTED IN (`proactiveInNode` — agent/system participants). The default
    // Node posture stays reactive-only because a Next.js SSR/RSC eval of the
    // `providers` module constructs user-kind clients whose scaffolded
    // resolver is browser-oriented (a relative-URL `fetch('/api/ablo-session')`)
    // — arming a timer there fires that resolver in Node, where fetch has no
    // origin to resolve a relative URL against → "Failed to parse URL" on
    // every tick. Long-lived server participants are the opposite case: their
    // socket MUST outlive the credential TTL, so they get the timer (the
    // PowerSync/Ably model — "the SDK invokes fetchCredentials when a token is
    // nearing expiry", on every platform). The reactive re-mint hook
    // (`setRefresher` above) stays UNCONDITIONAL: it only fires on a
    // real connection probe, which can't happen during a bare SSR module eval.
    if (typeof window !== 'undefined' || opts?.proactiveInNode === true) {
      // A missed (background-throttled) tick is recovered by the next, or by
      // the reactive probe. The timer is the sole proactive PRE-ROLL — it keeps
      // the key warm ahead of expiry even while the socket sits healthy-
      // `connected` (a state the FSM never probes). The delay is derived from
      // the minted credential's ACTUAL `expiresAt` when the refresher reports
      // one (~2/3 of remaining TTL), with the historical 10-minute value as
      // ceiling AND fallback — a deployment minting shorter-TTL keys no longer
      // outlives a fixed pre-roll and drops to reactive-only recovery.
      let timer: ReturnType<typeof setTimeout> | null = null;
      const scheduleNext = (): void => {
        if (timer !== null) clearTimeout(timer); // idempotent re-arm
        const delay = computePrerollDelayMs(this.credentialExpiresAtMs, Date.now());
        timer = setTimeout(() => {
          // `.finally` keeps the chain alive on transient failures; a
          // SUCCESSFUL mint already re-armed via `prerollReschedule` (no-op
          // double-arm thanks to the clearTimeout above).
          void refresh().finally(scheduleNext);
        }, delay);
        // Node: never keep a finishing process alive just for the pre-roll
        // (browser timers have no unref — optional call is a no-op there).
        (timer as { unref?: () => void }).unref?.();
      };
      scheduleNext();
      this.prerollReschedule = scheduleNext;
      teardowns.push(() => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        this.prerollReschedule = null;
      });

      // OS-wake (desktop only): the Electron shell bridges `powerMonitor`
      // 'resume' to this DOM event. This is the ONE event-trigger the lifecycle
      // still owns, because `visibilitychange` does NOT fire on wake-from-sleep
      // and — unlike `online`/`visibilitychange` — the ConnectionManager's own
      // browser listeners (`setupBrowserListeners`) don't cover wake.
      // Browser-gated separately from the timer: a `proactiveInNode` host has
      // no `window` to listen on (and no OS sleep to wake from).
      //
      // The `online` and `visibilitychange` listeners that used to live here
      // were REMOVED: the FSM already re-probes on NETWORK_ONLINE / TAB_VISIBLE
      // through this exact credential path, so registering them here too only
      // fired a second, null-swallowing mint per focus — the "session-key
      // POSTed on every tab focus" spam in the console.
      if (typeof window !== 'undefined') {
        const onWake = (): void => void refresh();
        window.addEventListener('ablo:wake', onWake);
        teardowns.push(() => { window.removeEventListener('ablo:wake', onWake); });
      }
    }

    this.credentialLifecycleTeardown = (): void => {
      for (const t of teardowns) t();
    };
  }

  /** Tear down the proactive credential lifecycle (idempotent). */
  stop(): void {
    this.credentialLifecycleTeardown?.();
    this.credentialLifecycleTeardown = null;
  }
}
