/**
 * ConnectionManager — single source of truth for the sync engine's
 * connection lifecycle. Absorbs the FSM every SDK consumer used to
 * rebuild by hand (apps/web's `ConnectionStore` was the reference
 * implementation — 605 LOC of FSM + watchdog + backoff).
 *
 * What it owns:
 *  - Browser online/offline + visibility events
 *  - Network probe orchestration (via `probeNetwork`)
 *  - Session-validity checks (HEAD /api/auth/check)
 *  - Retry backoff with ceiling, jitter, and offline-aware parking
 *  - Watchdog for browser events that never fire (VPN, captive portal)
 *  - The reconnect → bootstrap → WebSocket connect sequence
 *
 * What it DOES NOT own:
 *  - The actual bootstrap / IndexedDB / ObjectPool work — that lives in
 *    `BaseSyncedStore.performReconnect()`. This class calls it via the
 *    `onReconnect` callback and reacts to the outcome.
 *
 * Designed to be embedded by `BaseSyncedStore`: one instance per store,
 * started on first successful connect, disposed on teardown.
 *
 *   CONNECTED ──(socket drop)──► PROBING_NETWORK ──► RECONNECTING ──► CONNECTED
 *        │                              │                  │
 *   (network lost)                      ▼                  ▼
 *        ▼                        SESSION_EXPIRED       BACKOFF ──► PROBING_NETWORK
 *     OFFLINE ──(online)──► PROBING_NETWORK
 *        │
 *        ▼
 *   WAITING_FOR_NETWORK
 *
 * Includes three fixes over the original app-side FSM:
 *   1. `backoff` accepts `NETWORK_ONLINE` / `TAB_VISIBLE` — jumps to
 *      probing immediately when the network comes back, without
 *      waiting for the backoff timer to elapse.
 *   2. `scheduleBackoff` parks in `waiting_for_network` (resetting
 *      `attempt`) when `navigator.onLine === false` at max retries,
 *      instead of hard-reloading an already-offline browser.
 *   3. A socket drop (`WS_DISCONNECTED`, typically code 1006) goes
 *      STRAIGHT to `probing_network`, not the passive `offline` state.
 *      1006 is browser-local and carries no connectivity signal, so on a
 *      healthy machine no `online`/`offline` event ever fires — parking in
 *      `offline` stranded recovery until the 30s watchdog, long enough for
 *      queued commits to roll back. Only a genuine OS-level `NETWORK_LOST`
 *      parks in `offline` and waits for the `online` event.
 */

import { makeAutoObservable, runInAction } from 'mobx';
import { getContext } from '../context.js';
import { probeNetwork, type ProbeResult } from './NetworkProbe.js';
import type { AuthTokenGetter } from '../auth/credentialSource.js';

// ─── State ────────────────────────────────────────────────────────────────

export type ConnectionState =
  | 'connected'
  | 'offline'
  | 'probing_network'
  | 'validating_session'
  | 'refreshing_credential'
  | 'reconnecting'
  | 'backoff'
  | 'waiting_for_network'
  | 'auth_blocked'
  | 'session_expired';

export type ConnectionEvent =
  | { type: 'NETWORK_LOST' }
  | { type: 'NETWORK_ONLINE' }
  | { type: 'TAB_VISIBLE' }
  | { type: 'WS_CONNECTED' }
  | { type: 'WS_DISCONNECTED' }
  | { type: 'WS_SESSION_ERROR' }
  | { type: 'WS_HANDSHAKE_FAILED' }
  | { type: 'PROBE_SUCCESS'; sessionValid: boolean }
  | { type: 'PROBE_AUTH_BLOCKED' }
  /** The probe saw an expired ephemeral access key (`access_credential_expiry`).
   *  Recoverable: re-mint a fresh `ek_`/`rk_` and re-probe — never a sign-out. */
  | { type: 'PROBE_CREDENTIAL_STALE' }
  | { type: 'PROBE_FAILED' }
  /** A fresh access credential is available (the re-mint succeeded, or one was
   *  pushed in via `setAuthToken`). Re-probe so a parked connection picks it up. */
  | { type: 'CREDENTIAL_REFRESHED' }
  | { type: 'RECONNECT_SUCCESS' }
  | { type: 'RECONNECT_FAILED' }
  | { type: 'BACKOFF_ELAPSED' }
  | { type: 'BOOTSTRAP_FAILED_SESSION' }
  | { type: 'MANUAL_RETRY' };

// ─── Callbacks ────────────────────────────────────────────────────────────

export interface ConnectionCallbacks {
  /** Run bootstrap + WebSocket reconnect. Returns the outcome. */
  onReconnect: () => Promise<'success' | 'session_error' | 'network_error'>;
  /**
   * Re-mint the short-lived access credential (the Stripe-style `ek_`/`rk_`)
   * and push it into the credential source, then report the outcome. Invoked
   * on `refreshing_credential` — i.e. when a probe found the access key stale
   * (`PROBE_CREDENTIAL_STALE`). Mirrors the `getToken` contract:
   *   - `'refreshed'`     → a fresh credential is in place; re-probe & reconnect.
   *   - `'session_error'` → the LONG-LIVED login is gone (mint returned null →
   *                          401/403); terminal → sign out.
   *   - `'network_error'` → couldn't reach the mint endpoint (offline/5xx/throw);
   *                          transient → back off and retry, never sign out.
   * Optional: a deployment with no re-mint path (e.g. a static `apiKey`) omits
   * it, and the FSM falls back to a plain re-probe.
   */
  onRefreshCredential?: () => Promise<'refreshed' | 'session_error' | 'network_error'>;
  /** Called when the session is confirmed expired — route to signin. */
  onSessionExpired: () => void;
  /** Called to tear down the WebSocket when entering a dead state. */
  onDisconnectWebSocket: () => void;
  /**
   * Fired on every FSM state transition. Lets the embedding store
   * mirror recovery progress into its visible `syncStatus` so the UI
   * can show "Reconnecting…" instead of a sticky "offline" while the
   * FSM cycles through `probing_network` → `reconnecting` → `backoff`.
   * Optional — omitting it preserves the previous behavior where the
   * FSM was opaque to the UI.
   */
  onStateChange?: (next: ConnectionState, prev: ConnectionState) => void;
}

export interface ConnectionManagerOptions {
  /**
   * Sync-server base URL used for probes. Falls back to the env-based
   * default of `probeNetwork`.
   */
  baseUrl?: string;
  /**
   * Current bearer credential for authenticated probes. Read lazily so token
   * refreshes pushed through `Ablo.setAuthToken()` are used by the next probe
   * without recreating the manager.
   */
  getAuthToken?: AuthTokenGetter;
  /** Override retry ceilings / jitter. Production should leave defaults. */
  backoff?: Partial<typeof DEFAULT_BACKOFF>;
}

// ─── Tunables ─────────────────────────────────────────────────────────────

const DEFAULT_BACKOFF = {
  BASE_MS: 2_000,
  MAX_MS: 30_000,
  MAX_ATTEMPTS: 8,
  JITTER: 0.15,
} as const;

const ONLINE_DEBOUNCE_MS = 500;
const WATCHDOG_INTERVAL_MS = 30_000;
const MAX_STUCK_CYCLES_BEFORE_RELOAD = 6;
/** Cap on consecutive access-key re-mints before giving up to `auth_blocked`.
 *  Stops a hot loop if the server keeps reporting the key stale even after a
 *  "successful" re-mint (clock skew, a mint returning an already-rejected key). */
const MAX_CREDENTIAL_REFRESH_ATTEMPTS = 3;

// ─── ConnectionManager ────────────────────────────────────────────────────

export class ConnectionManager {
  // Observable state
  state: ConnectionState = 'connected';
  offlineSince: Date | null = null;
  attempt: number = 0;
  lastProbeResult: ProbeResult | null = null;

  // Private
  private callbacks: ConnectionCallbacks | null = null;
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private stuckCycles: number = 0;
  /** Consecutive access-key re-mints in the current recovery cycle; reset on
   *  reaching `connected`. See {@link MAX_CREDENTIAL_REFRESH_ATTEMPTS}. */
  private credentialRefreshAttempts: number = 0;
  private disposed = false;
  private readonly baseUrl?: string;
  private readonly getAuthToken?: AuthTokenGetter;
  private readonly backoff: typeof DEFAULT_BACKOFF;

  private handleBrowserOnline: (() => void) | null = null;
  private handleBrowserOffline: (() => void) | null = null;
  private handleVisibilityChange: (() => void) | null = null;

  constructor(options: ConnectionManagerOptions = {}) {
    this.baseUrl = options.baseUrl;
    this.getAuthToken = options.getAuthToken;
    this.backoff = { ...DEFAULT_BACKOFF, ...(options.backoff ?? {}) };
    makeAutoObservable(this, {}, { autoBind: true });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  start(callbacks: ConnectionCallbacks): void {
    this.callbacks = callbacks;
    this.setupBrowserListeners();
    this.startWatchdog();
    getContext().logger.info('[ConnectionManager] Started');
  }

  dispose(): void {
    this.disposed = true;
    this.clearBackoffTimer();
    this.clearDebounceTimer();
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.removeBrowserListeners();
    this.callbacks = null;
    getContext().logger.info('[ConnectionManager] Disposed');
  }

  // ── Send events ──────────────────────────────────────────────────────

  send(event: ConnectionEvent): void {
    if (this.disposed) return;

    const prevState = this.state;
    const nextState = this.transition(prevState, event);
    if (nextState === null) return;

    getContext().logger.info('[ConnectionManager] Transition', {
      from: prevState,
      to: nextState,
      event: event.type,
    });

    runInAction(() => {
      this.state = nextState;
      if (prevState === 'connected' && nextState !== 'connected') {
        this.offlineSince = new Date();
      }
      if (nextState === 'connected') {
        this.offlineSince = null;
        this.attempt = 0;
        this.stuckCycles = 0;
      }
    });

    // Notify the embedding store BEFORE running side effects, so the
    // UI flips to the new label (e.g. "Reconnecting…") at the same
    // tick the probe / backoff actually starts. Errors in the consumer
    // must not break the FSM — wrap defensively.
    try {
      this.callbacks?.onStateChange?.(nextState, prevState);
    } catch (err) {
      getContext().logger.warn('[ConnectionManager] onStateChange threw', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.onEnterState(nextState, event);
  }

  // ── Pure transition ──────────────────────────────────────────────────

  private transition(state: ConnectionState, event: ConnectionEvent): ConnectionState | null {
    switch (state) {
      case 'connected':
        switch (event.type) {
          case 'NETWORK_LOST':
            // The OS reported the NIC down — park passively in `offline` and
            // wait for the `online` event. Probing a downed adapter is wasted
            // work.
            return 'offline';
          case 'WS_DISCONNECTED':
            // The socket died (typically code 1006) but the OS network is
            // almost certainly fine — 1006 is generated locally when the TCP
            // conn vanishes and carries NO connectivity signal, so the browser
            // fires no online/offline event. Probe IMMEDIATELY rather than
            // landing in the passive `offline` dead-end (which only escaped via
            // the 30s watchdog, long after queued commits rolled back). The
            // probe fast-fails if we genuinely ARE offline → waiting_for_network.
            return 'probing_network';
          case 'WS_SESSION_ERROR':
          case 'BOOTSTRAP_FAILED_SESSION':
            return 'session_expired';
          case 'WS_HANDSHAKE_FAILED':
            return 'probing_network';
          case 'TAB_VISIBLE':
            return 'probing_network';
          default:
            return null;
        }

      case 'offline':
        switch (event.type) {
          case 'NETWORK_ONLINE':
          case 'MANUAL_RETRY':
          case 'TAB_VISIBLE':
          case 'WS_HANDSHAKE_FAILED':
          case 'CREDENTIAL_REFRESHED':
            return 'probing_network';
          case 'WS_SESSION_ERROR':
          case 'BOOTSTRAP_FAILED_SESSION':
            return 'session_expired';
          default:
            return null;
        }

      case 'probing_network':
        switch (event.type) {
          case 'PROBE_SUCCESS':
            return event.sessionValid ? 'reconnecting' : 'session_expired';
          case 'PROBE_CREDENTIAL_STALE':
            // Access key expired but the login is fine — re-mint, don't sign out.
            return 'refreshing_credential';
          case 'PROBE_AUTH_BLOCKED':
            return 'auth_blocked';
          case 'PROBE_FAILED':
            return 'waiting_for_network';
          case 'NETWORK_LOST':
            return 'offline';
          default:
            return null;
        }

      case 'waiting_for_network':
        switch (event.type) {
          case 'NETWORK_ONLINE':
          case 'TAB_VISIBLE':
          case 'MANUAL_RETRY':
          case 'BACKOFF_ELAPSED':
          case 'CREDENTIAL_REFRESHED':
            return 'probing_network';
          case 'NETWORK_LOST':
            return 'offline';
          default:
            return null;
        }

      case 'validating_session':
        switch (event.type) {
          case 'PROBE_SUCCESS':
            return event.sessionValid ? 'reconnecting' : 'session_expired';
          case 'PROBE_CREDENTIAL_STALE':
            return 'refreshing_credential';
          case 'PROBE_AUTH_BLOCKED':
            return 'auth_blocked';
          case 'NETWORK_LOST':
            return 'offline';
          default:
            return null;
        }

      case 'refreshing_credential':
        // Re-minting the short-lived access key (the Stripe-style `ek_`/`rk_`).
        // The login is presumed valid; this is NOT a sign-out state.
        switch (event.type) {
          case 'CREDENTIAL_REFRESHED':
            // Fresh key in hand — re-probe so we reconnect with it.
            return 'probing_network';
          case 'BOOTSTRAP_FAILED_SESSION':
            // The re-mint hit a genuine 401/403: the long-lived login itself is
            // gone. THIS is the only path from here to sign-out.
            return 'session_expired';
          case 'RECONNECT_FAILED':
            // Couldn't reach the mint endpoint (offline/5xx/throw) — transient.
            // Back off and retry; never sign out for a network failure.
            return 'backoff';
          case 'PROBE_AUTH_BLOCKED':
            // Bounded-attempt fallback: the key keeps coming back stale even
            // after re-mint (see runRefreshCredential's attempt guard). Stop
            // looping without signing out.
            return 'auth_blocked';
          case 'NETWORK_LOST':
            return 'offline';
          default:
            return null;
        }

      case 'reconnecting':
        switch (event.type) {
          case 'RECONNECT_SUCCESS':
          case 'WS_CONNECTED':
            return 'connected';
          case 'RECONNECT_FAILED':
          case 'WS_HANDSHAKE_FAILED':
            return 'backoff';
          case 'BOOTSTRAP_FAILED_SESSION':
          case 'WS_SESSION_ERROR':
            return 'session_expired';
          case 'NETWORK_LOST':
            return 'offline';
          default:
            return null;
        }

      case 'backoff':
        switch (event.type) {
          case 'BACKOFF_ELAPSED':
          case 'MANUAL_RETRY':
          case 'WS_HANDSHAKE_FAILED':
            return 'probing_network';
          case 'NETWORK_ONLINE':
          case 'TAB_VISIBLE':
          case 'CREDENTIAL_REFRESHED':
            // Network came back (or a fresh credential arrived) while we were
            // waiting out a backoff delay — jump straight to probing instead of
            // waiting the full exponential interval. Fixes the "doesn't
            // retrigger when internet comes back" bug.
            return 'probing_network';
          case 'NETWORK_LOST':
            return 'offline';
          case 'WS_SESSION_ERROR':
          case 'BOOTSTRAP_FAILED_SESSION':
            return 'session_expired';
          default:
            return null;
        }

      case 'auth_blocked':
        // Reachable, but the data-plane rejected the credential (non-retryable,
        // non-expiry — e.g. api_key_required, jwt_issuer_untrusted). Don't
        // auto-reconnect and don't sign out. Allow a manual retry or a
        // tab-focus / network-return / fresh-credential re-probe (e.g. after a
        // server deploy or an out-of-band re-mint); a network drop parks
        // offline; a genuine session error still expires.
        switch (event.type) {
          case 'MANUAL_RETRY':
          case 'TAB_VISIBLE':
          case 'NETWORK_ONLINE':
          case 'CREDENTIAL_REFRESHED':
            return 'probing_network';
          case 'NETWORK_LOST':
            return 'offline';
          case 'WS_SESSION_ERROR':
          case 'BOOTSTRAP_FAILED_SESSION':
            return 'session_expired';
          default:
            return null;
        }

      case 'session_expired':
        return null; // terminal

      default:
        return null;
    }
  }

  // ── Side effects per state ───────────────────────────────────────────

  private onEnterState(state: ConnectionState, event: ConnectionEvent): void {
    switch (state) {
      case 'connected':
        this.clearBackoffTimer();
        runInAction(() => {
          this.credentialRefreshAttempts = 0;
        });
        break;

      case 'offline':
        this.clearBackoffTimer();
        this.callbacks?.onDisconnectWebSocket();
        break;

      case 'probing_network':
        // A socket drop (`WS_DISCONNECTED`) now lands here directly so recovery
        // starts immediately. Tear the dead socket down FIRST — this is what
        // sets SyncWebSocket's `isManualClose=true` and suppresses its own
        // scheduleReconnect, keeping the FSM the single reconnect authority on
        // the human path. The teardown runs synchronously inside the
        // `disconnected` emit, before `SyncWebSocket.onclose` checks the flag,
        // so the timing matches the previous `offline`-entry teardown. We gate
        // on the drop event specifically: the other paths into `probing_network`
        // (TAB_VISIBLE re-validation, handshake retry, backoff elapse) must NOT
        // tear down a socket that may still be live.
        if (event.type === 'WS_DISCONNECTED') {
          this.callbacks?.onDisconnectWebSocket();
        }
        this.runProbe();
        break;

      case 'waiting_for_network':
        this.scheduleBackoff();
        break;

      case 'reconnecting':
        this.runReconnect();
        break;

      case 'refreshing_credential':
        this.runRefreshCredential();
        break;

      case 'backoff':
        this.scheduleBackoff();
        break;

      case 'auth_blocked':
        // Stop — reachable but the credential was rejected (e.g.
        // api_key_required / jwt_issuer_untrusted from the data plane). Neither
        // reconnecting nor re-auth fixes it. Drop the socket and wait for a
        // manual retry / re-probe. Crucially NOT onSessionExpired (no sign-out)
        // and NOT a reconnect — that's the whole point of this state.
        this.clearBackoffTimer();
        this.callbacks?.onDisconnectWebSocket();
        getContext().observability.breadcrumb(
          'Auth blocked — reachable but credential rejected; not reconnecting or signing out',
          'sync.offline',
          'error'
        );
        break;

      case 'session_expired':
        this.clearBackoffTimer();
        this.callbacks?.onDisconnectWebSocket();
        this.callbacks?.onSessionExpired();
        getContext().observability.breadcrumb(
          'Session expired — redirecting to signin',
          'sync.offline',
          'warning'
        );
        break;
    }
  }

  // ── Async operations ─────────────────────────────────────────────────

  private async runProbe(): Promise<void> {
    try {
      const result = await probeNetwork({
        baseUrl: this.baseUrl,
        getAuthToken: this.getAuthToken,
      });
      runInAction(() => {
        this.lastProbeResult = result;
      });
      // One probe outcome → one event. Exhaustive over ProbeOutcome so a new
      // outcome can't be silently dropped.
      switch (result.outcome) {
        case 'reachable':
          this.send({ type: 'PROBE_SUCCESS', sessionValid: true });
          break;
        case 'session_expired':
          // Genuine login expiry — terminal. (PROBE_SUCCESS with
          // sessionValid:false routes to session_expired in the FSM.)
          this.send({ type: 'PROBE_SUCCESS', sessionValid: false });
          break;
        case 'credential_stale':
          // Access key expired but the login is fine — re-mint, don't sign out.
          this.send({ type: 'PROBE_CREDENTIAL_STALE' });
          break;
        case 'auth_blocked':
          this.send({ type: 'PROBE_AUTH_BLOCKED' });
          break;
        case 'unreachable':
          this.send({ type: 'PROBE_FAILED' });
          break;
        default: {
          const _exhaustive: never = result.outcome;
          void _exhaustive;
          this.send({ type: 'PROBE_FAILED' });
        }
      }
    } catch {
      this.send({ type: 'PROBE_FAILED' });
    }
  }

  /**
   * Re-mint the short-lived access key on `refreshing_credential`. Delegates to
   * the `onRefreshCredential` callback (which mints a fresh `ek_`/`rk_` from the
   * still-valid login and pushes it into the credential source) and maps its
   * tri-state outcome onto the FSM:
   *   - `refreshed`     → `CREDENTIAL_REFRESHED` → re-probe & reconnect.
   *   - `session_error` → `BOOTSTRAP_FAILED_SESSION` → sign out (login is gone).
   *   - `network_error` → `RECONNECT_FAILED` → back off & retry (never sign out).
   *
   * A bounded attempt counter guards against a hot loop where the server keeps
   * reporting the key stale even after a "successful" re-mint (e.g. a clock skew
   * or a mint that returns an already-rejected key): after
   * `MAX_CREDENTIAL_REFRESH_ATTEMPTS` we fall through to `auth_blocked` (stop,
   * no sign-out) rather than spin. The counter resets once we reach `connected`.
   *
   * When no refresher is wired (e.g. a static `apiKey` deployment), we re-probe
   * directly — the credential source's own scheduler owns refresh there.
   */
  private async runRefreshCredential(): Promise<void> {
    if (this.credentialRefreshAttempts >= MAX_CREDENTIAL_REFRESH_ATTEMPTS) {
      getContext().logger.warn(
        '[ConnectionManager] Access key still stale after repeated re-mints — stopping',
        { attempts: this.credentialRefreshAttempts },
      );
      runInAction(() => {
        this.credentialRefreshAttempts = 0;
      });
      this.send({ type: 'PROBE_AUTH_BLOCKED' });
      return;
    }
    runInAction(() => {
      this.credentialRefreshAttempts += 1;
    });

    const refresher = this.callbacks?.onRefreshCredential;
    if (!refresher) {
      // No re-mint path wired — re-probe with whatever the credential source
      // holds (a static-key deployment refreshes out-of-band, if at all).
      this.send({ type: 'CREDENTIAL_REFRESHED' });
      return;
    }

    try {
      const result = await refresher();
      switch (result) {
        case 'refreshed':
          this.send({ type: 'CREDENTIAL_REFRESHED' });
          break;
        case 'session_error':
          this.send({ type: 'BOOTSTRAP_FAILED_SESSION' });
          break;
        case 'network_error':
          this.send({ type: 'RECONNECT_FAILED' });
          break;
        default: {
          const _exhaustive: never = result;
          void _exhaustive;
          this.send({ type: 'RECONNECT_FAILED' });
        }
      }
    } catch (error) {
      // A thrown refresher is transient by contract (offline / mint endpoint
      // unreachable) — back off and retry, never sign out.
      getContext().logger.warn('[ConnectionManager] Credential re-mint threw (transient)', { error });
      this.send({ type: 'RECONNECT_FAILED' });
    }
  }

  private async runReconnect(): Promise<void> {
    if (!this.callbacks) return;
    try {
      const result = await this.callbacks.onReconnect();
      switch (result) {
        case 'success':
          this.send({ type: 'RECONNECT_SUCCESS' });
          break;
        case 'session_error':
          this.send({ type: 'BOOTSTRAP_FAILED_SESSION' });
          break;
        case 'network_error':
          this.send({ type: 'RECONNECT_FAILED' });
          break;
      }
    } catch (error) {
      getContext().logger.error('[ConnectionManager] Reconnect threw', { error });
      this.send({ type: 'RECONNECT_FAILED' });
    }
  }

  // ── Backoff ──────────────────────────────────────────────────────────

  private scheduleBackoff(): void {
    this.clearBackoffTimer();

    if (this.attempt >= this.backoff.MAX_ATTEMPTS) {
      // If still offline, a hard reload will fail or serve cached and
      // we'll loop. Park in waiting_for_network and let the `online`
      // event (or watchdog) restart the cycle when the network comes
      // back.
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        getContext().logger.warn(
          '[ConnectionManager] Max retries while offline — parking until network restored',
        );
        getContext().observability.breadcrumb(
          'Max retries — parking offline',
          'sync.offline',
          'warning'
        );
        runInAction(() => {
          this.attempt = 0;
        });
        return;
      }
      getContext().logger.warn('[ConnectionManager] Max retries — hard reload');
      getContext().observability.breadcrumb(
        'Max retries — hard reload',
        'sync.offline',
        'error'
      );
      if (typeof window !== 'undefined') {
        window.location.reload();
      }
      return;
    }

    const baseDelay = Math.min(
      this.backoff.BASE_MS * Math.pow(2, this.attempt),
      this.backoff.MAX_MS,
    );
    const jitter = baseDelay * this.backoff.JITTER * (2 * Math.random() - 1);
    const delay = Math.round(baseDelay + jitter);

    runInAction(() => {
      this.attempt++;
    });

    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = null;
      this.send({ type: 'BACKOFF_ELAPSED' });
    }, delay);
  }

  // ── Browser listeners ────────────────────────────────────────────────

  private setupBrowserListeners(): void {
    if (typeof window === 'undefined') return;

    this.handleBrowserOnline = () => {
      this.clearDebounceTimer();
      this.debounceTimer = setTimeout(() => {
        this.send({ type: 'NETWORK_ONLINE' });
      }, ONLINE_DEBOUNCE_MS);
    };

    this.handleBrowserOffline = () => {
      this.clearDebounceTimer();
      this.send({ type: 'NETWORK_LOST' });
    };

    this.handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        this.send({ type: 'TAB_VISIBLE' });
      }
    };

    window.addEventListener('online', this.handleBrowserOnline);
    window.addEventListener('offline', this.handleBrowserOffline);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }
  }

  private removeBrowserListeners(): void {
    if (typeof window === 'undefined') return;
    if (this.handleBrowserOnline) {
      window.removeEventListener('online', this.handleBrowserOnline);
    }
    if (this.handleBrowserOffline) {
      window.removeEventListener('offline', this.handleBrowserOffline);
    }
    if (this.handleVisibilityChange && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
  }

  // ── Watchdog ─────────────────────────────────────────────────────────

  private startWatchdog(): void {
    if (typeof window === 'undefined') return;
    this.watchdogTimer = setInterval(() => {
      if (this.disposed) return;

      // "Stuck" = parked in a non-active recovery state (offline,
      // waiting_for_network, backoff). We deliberately do NOT gate on
      // `navigator.onLine === true` here: per MDN, `navigator.onLine`
      // is only reliable when it returns false ("definitely offline"),
      // and even that lies after laptop wake / VPN flips. Gating the
      // watchdog on `onLine` was the actual "offline forever" bug —
      // when the browser briefly reported offline and never re-fired
      // the `online` event, the FSM had no escape from `'offline'`.
      // The probe itself fast-fails when truly offline (NetworkProbe.ts),
      // so an unconditional retry costs nothing in the genuine case.
      const isStuck =
        this.state !== 'connected' &&
        this.state !== 'session_expired' &&
        this.state !== 'probing_network' &&
        this.state !== 'refreshing_credential' &&
        this.state !== 'reconnecting';

      if (isStuck) {
        this.stuckCycles++;
        // Hard-reload gate: only reload when `navigator.onLine` is true.
        // `onLine === false` is the one direction we trust (MDN: "false
        // means definitely offline"), and reloading while truly offline
        // would either serve cached content forever or fail and leave
        // the user with a broken page.
        const browserOnline =
          typeof navigator === 'undefined' || navigator.onLine === true;
        if (this.stuckCycles >= MAX_STUCK_CYCLES_BEFORE_RELOAD && browserOnline) {
          getContext().logger.warn('[ConnectionManager] Watchdog: sustained stuck — hard reload');
          getContext().observability.breadcrumb(
            'Watchdog hard reload',
            'sync.offline',
            'error'
          );
          if (typeof window !== 'undefined') {
            window.location.reload();
          }
          return;
        }
        getContext().logger.info('[ConnectionManager] Watchdog: stuck — retry', {
          state: this.state,
          stuckCycles: this.stuckCycles,
          browserOnline,
        });
        runInAction(() => {
          this.attempt = 0;
        });
        this.send({ type: 'MANUAL_RETRY' });
      } else {
        this.stuckCycles = 0;
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  // ── UI-friendly computed ──────────────────────────────────────────────

  get isConnected(): boolean { return this.state === 'connected'; }
  get isOffline(): boolean { return this.state === 'offline' || this.state === 'waiting_for_network'; }
  get isReconnecting(): boolean {
    return (
      this.state === 'probing_network' ||
      this.state === 'validating_session' ||
      this.state === 'refreshing_credential' ||
      this.state === 'reconnecting' ||
      this.state === 'backoff'
    );
  }
  get isSessionExpired(): boolean { return this.state === 'session_expired'; }

  get offlineDuration(): string | null {
    if (!this.offlineSince) return null;
    const ms = Date.now() - this.offlineSince.getTime();
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (seconds < 60) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  // ── Timer helpers ─────────────────────────────────────────────────────

  private clearBackoffTimer(): void {
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}
