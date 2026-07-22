/**
 * Keeps the short-lived access credential fresh. It owns the re-mint hook, a
 * single-flight guard that stops concurrent triggers from minting more than
 * once, and a browser-only proactive refresh — a timer plus an OS-wake listener
 * — that renews the credential ahead of expiry. It reaches the rest of the
 * client only through the small {@link CredentialLifecycleContext} interface,
 * so the two can reference each other without an import cycle.
 */

import type { RecoveryClass } from '../errorCodes.js';
import { noopLogger, type Logger } from '../logger.js';

/**
 * Tri-state outcome of a credential re-mint, mirroring the `getToken`
 * contract (see {@link CredentialLifecycle.refresh}).
 */
export type CredentialRefreshOutcome = 'refreshed' | 'session_error' | 'network_error';

/**
 * What an auth-rejected transport should do after recovery has run. `'retry'`
 * means a fresh credential is now in place — replay the request once. `'stop'`
 * means don't replay: either the session is gone for good, the rejection is one
 * a re-mint can't cure, or the mint failed transiently and the caller's own
 * retry path will recover later.
 */
export type CredentialRecoveryOutcome = 'retry' | 'stop';

/**
 * What a credential refresher may resolve with. The plain-string form returns
 * just the token. The object form also carries the mint response's `expiresAt`
 * (an ISO string, epoch milliseconds, or a `Date`), which lets the proactive
 * pre-roll schedule against the credential's real lifetime rather than assume
 * the server's default expiry.
 */
export type CredentialRefreshResult =
  | string
  | { readonly token: string; readonly expiresAt?: string | number | Date }
  | null;

/** A credential re-mint hook. `Promise<string | null>` resolvers remain
 *  assignable — the widened result type is a superset. */
export type CredentialRefresher = () => Promise<CredentialRefreshResult>;

/** The fallback pre-roll interval, and also its ceiling: 10 minutes, which sits
 *  comfortably inside the server's 15-minute default credential lifetime. Used
 *  as-is when the refresher reports no expiry. */
export const DEFAULT_PREROLL_INTERVAL_MS = 10 * 60 * 1000;

/** Floor so a very short (or already-elapsed) TTL can't hot-loop the mint. */
export const MIN_PREROLL_DELAY_MS = 30 * 1000;

/**
 * Computes how long to wait before pre-rolling a credential that expires at
 * `expiresAtMs`: about two-thirds of the remaining lifetime (a 15-minute
 * credential yields 10 minutes), clamped to
 * [{@link MIN_PREROLL_DELAY_MS}, {@link DEFAULT_PREROLL_INTERVAL_MS}]. An
 * unknown expiry (`null`) falls back to the 10-minute interval. Exported for
 * unit tests.
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
 * The callbacks this lifecycle needs back from the surrounding client. It is
 * deliberately minimal — three callbacks, each resolved lazily at call time,
 * because the connection machinery behind two of them isn't constructed until
 * the sync connection is set up.
 */
export interface CredentialLifecycleContext {
  /** Push a freshly-minted access token into the shared credential source
   *  (no-op when the deployment wired no credential source). */
  setAuthToken(token: string): void;
  /** Nudge the connection to re-probe using the credential now in place. */
  nudgeReconnect(): void;
  /** Report that the long-lived login is gone, so the connection can move to
   *  its signed-out state. */
  reportSessionExpired(): void;
}

export class CredentialLifecycle {
  /**
   * The hook that mints a fresh short-lived access credential (the `ek_`/`rk_`
   * key). An integrator wires it from their own token endpoint: this lifecycle
   * decides when to refresh (a stale-credential probe or an external nudge),
   * and the hook decides how to mint. It follows the same contract as a
   * `getToken` function — it resolves a token string on success, `null` when
   * the long-lived login is gone (a terminal state), and throws on a transient
   * or offline failure. Used by {@link refresh}. When it is absent there is no
   * silent re-mint, as with a static `apiKey` whose credential source is
   * refreshed elsewhere.
   */
  private credentialRefresher: CredentialRefresher | null = null;

  /** Single-flight guard so a wake nudge + an in-flight request + a probe don't
   *  all mint at once (the classic "token thrash → random logout" bug). */
  private inFlightCredentialRefresh: Promise<CredentialRefreshOutcome> | null = null;

  /** Tears down the proactive credential lifecycle (the refresh timer and the
   *  OS-wake listener) installed by {@link start}; cleared when the client
   *  disconnects. Null when no refresher is wired. */
  private credentialLifecycleTeardown: (() => void) | null = null;

  /** Epoch milliseconds at which the current credential expires, when the
   *  refresher reports it (the object form of {@link CredentialRefreshResult}).
   *  `null` for the string-form resolver, in which case the pre-roll uses its
   *  fixed interval. */
  private credentialExpiresAtMs: number | null = null;

  /** Re-arms the proactive pre-roll timer (set by {@link start}). Called after
   *  every successful mint, so a refresh triggered reactively (by a probe, an
   *  OS wake, or the first mint) re-anchors the schedule to the fresh
   *  credential's real expiry instead of a stale fixed delay. */
  private prerollReschedule: (() => void) | null = null;

  constructor(
    private readonly ctx: CredentialLifecycleContext,
    private readonly logger: Logger = noopLogger,
  ) {}

  /**
   * Registers the re-mint hook for the access credential — a function that
   * mints a fresh `ek_`/`rk_` key, typically the integrator's `getToken`. See
   * {@link credentialRefresher}.
   */
  setRefresher(refresher: CredentialRefresher | null): void {
    this.credentialRefresher = refresher;
  }

  /**
   * Re-mints the short-lived access credential, pushes it into the credential
   * source, and reports a three-way outcome the connection layer acts on:
   *   - a token string → `'refreshed'`     (the fresh key is in place; re-probe and reconnect)
   *   - `null`         → `'session_error'` (the login itself is gone — terminal, sign out)
   *   - a thrown error → `'network_error'` (the mint endpoint was unreachable — transient)
   *
   * The call is single-flight: concurrent triggers (an OS wake, an in-flight
   * request, a probe) share one in-flight promise, so the credential is never
   * minted twice at once. This avoids the failure where every rejected request
   * mints a new token and the resulting thrash logs the user out.
   *
   * With no refresher wired, it resolves `'refreshed'` as a no-op re-probe: a
   * static-`apiKey` client has no session to mint from and its credential
   * source is refreshed elsewhere, so it simply re-probes with what it holds.
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
          // null = the long-lived login is gone (the mint endpoint answered
          // 401/403). Terminal — this routes to sign-out.
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
        // A relative-URL resolver invoked on the server (Node's fetch has no
        // origin to resolve against) throws the opaque "Failed to parse URL" or
        // "Only absolute URLs are supported". Translate it into something
        // actionable rather than a mystery transient blip: the proactive
        // refresh is browser-only, so reaching here means the resolver fired
        // from a server render or a server route.
        if (typeof window === 'undefined' && /parse URL|absolute URLs?/i.test(message)) {
          this.logger.warn(
            'credential resolver ran on the server with a relative URL — Node fetch needs an absolute URL. ' +
              'Refresh the Ablo client in the browser, or build an absolute URL server-side ' +
              "(e.g. new URL('/api/ablo-session', process.env.NEXT_PUBLIC_APP_URL)).",
            { error: message },
          );
        } else {
          this.logger.debug('access-credential re-mint failed (transient)', { error: message });
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
   * Interprets a refresh outcome and drives the connection accordingly. This is
   * the single place the three-way outcome is acted on, shared by the proactive
   * pre-roll, the OS-wake nudge, and the HTTP auth-recovery path, so every
   * trigger converges on the same behavior.
   */
  private routeRefreshOutcome(outcome: CredentialRefreshOutcome): CredentialRecoveryOutcome {
    if (outcome === 'refreshed') {
      // Fresh key already pushed into the credential source by `refresh`;
      // nudge a parked connection to re-probe with it.
      this.ctx.nudgeReconnect();
      return 'retry';
    }
    if (outcome === 'session_error') {
      // The long-lived login is gone (the mint answered 401/403). Report it;
      // this is harmless in connection states that don't accept the event,
      // which converge on sign-out anyway.
      this.ctx.reportSessionExpired();
      return 'stop';
    }
    // 'network_error' → transient (offline or a mint hiccup); the next proactive
    // tick or the connection's own probe retries. Never sign out, never replay now.
    return 'stop';
  }

  /**
   * The shared recovery path for a request rejected on authentication, over any
   * transport. The WebSocket probe already routes its own 401s; HTTP callers
   * call this instead of inventing their own handling, so every path shares one
   * single-flight mint, one outcome routing, and one taxonomy. It classifies
   * the same recovery codes the connection probe does:
   *   - `access_credential_expiry` — the routine case, an expired `ek_`/`rk_`:
   *     silently re-mint through the single-flight {@link refresh} and tell the
   *     caller to replay once on success. This never signs out on its own; the
   *     only terminal path is the mint resolving `null`.
   *   - `session_expiry` — the login is gone: report it (which drives sign-out)
   *     and stop, since replaying is pointless.
   *   - `auth_blocked`, `permission`, and everything else — re-minting would
   *     produce the same rejected credential, so stop and leave the connection
   *     alone.
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
   * Installs the credential lifecycle. It has two parts:
   *   1. Reactive — registers `getToken` as the re-mint hook the connection
   *      calls when a probe finds the key stale, or on a nudge.
   *   2. Proactive — keeps the short-lived key fresh ahead of expiry with a
   *      refresh timer inside the credential's lifetime, plus a re-mint on OS
   *      wake. The whole proactive block is browser-gated on `typeof window`,
   *      because a server render has no socket to keep warm and the resolver is
   *      browser-oriented; arming it under Node would fire a relative-URL fetch
   *      and throw. (Agents pass a static `apiKey` with no resolver, so this
   *      method is never called for them.)
   *
   * Refreshing is automatic — a consumer never calls a refresh method. The call
   * is idempotent: a second call replaces the first, and it is torn down when
   * the client disconnects.
   *
   * `opts.proactiveInNode` arms the refresh timer on a windowless host as well.
   * Set it for agent or system participants — long-lived server sockets whose
   * `rk_`/`ek_` must renew before the server's keepalive check closes them.
   * Node timers are `unref`ed, so a finishing script is never held alive by the
   * pre-roll. The OS-wake listener stays browser-only regardless, since there
   * is no `window` to listen on.
   */
  start(getToken: CredentialRefresher, opts?: { proactiveInNode?: boolean }): void {
    this.stop();
    this.setRefresher(getToken);

    // Re-mint through the same single-flight path the reactive probe uses
    // (`refresh`) rather than calling `getToken()` directly. This gives two
    // things: the mint stays single-flight, so an OS wake, an in-flight probe,
    // and this proactive roll share one in-flight promise instead of thrashing;
    // and the three-way outcome is honored, so a `null` result (the login is
    // gone) actually drives expiry instead of being dropped, which would leave a
    // zombie session that re-mints on every tab focus.
    const refresh = async (): Promise<void> => {
      // Same outcome routing as every other trigger (see routeRefreshOutcome):
      // refreshed → nudge, session_error → report, network_error → wait for
      // the next tick / the FSM's own probe. Never sign out for a transient.
      this.routeRefreshOutcome(await this.refresh());
    };

    const teardowns: (() => void)[] = [];

    // The proactive pre-roll arms in the browser, or under Node when the host
    // opts in (`proactiveInNode`, for agent or system participants). The
    // default Node posture stays reactive-only, because a server render can
    // construct user-kind clients whose resolver is browser-oriented (a
    // relative-URL `fetch('/api/ablo-session')`); arming a timer there fires
    // that resolver under Node, where fetch has no origin for a relative URL and
    // throws "Failed to parse URL" on every tick. Long-lived server
    // participants are the opposite case: their socket must outlive the
    // credential's lifetime, so they get the timer. The reactive re-mint hook
    // (`setRefresher` above) stays unconditional: it only fires on a real
    // connection probe, which can't happen during a bare server-side module
    // evaluation.
    if (typeof window !== 'undefined' || opts?.proactiveInNode === true) {
      // A missed tick (throttled in the background) is recovered by the next
      // one, or by the reactive probe. This timer is the only proactive
      // pre-roll — it keeps the key warm ahead of expiry even while the socket
      // sits healthy and connected, a state the connection never probes. The
      // delay comes from the minted credential's real `expiresAt` when the
      // refresher reports one (about two-thirds of the remaining lifetime), with
      // the 10-minute value as both ceiling and fallback, so a deployment that
      // mints shorter-lived keys still pre-rolls in time rather than dropping to
      // reactive-only recovery.
      let timer: ReturnType<typeof setTimeout> | null = null;
      const scheduleNext = (): void => {
        if (timer !== null) clearTimeout(timer); // idempotent re-arm
        const delay = computePrerollDelayMs(this.credentialExpiresAtMs, Date.now());
        timer = setTimeout(() => {
          // `.finally` keeps the chain alive after a transient failure; a
          // successful mint has already re-armed via `prerollReschedule` (the
          // clearTimeout above makes the double-arm a no-op).
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

      // OS-wake, on desktop only: the Electron shell bridges `powerMonitor`
      // 'resume' to this DOM event. It is the one event trigger this lifecycle
      // still owns, because `visibilitychange` does not fire on wake-from-sleep
      // and the connection's own browser listeners don't cover wake. It is
      // browser-gated separately from the timer, since a `proactiveInNode` host
      // has no `window` to listen on and no OS sleep to wake from. Coming back
      // online and regaining tab visibility are handled elsewhere — the
      // connection already re-probes through this same credential path — so
      // listening for them here too would only fire a second, redundant mint.
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
