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
 *   CONNECTED ──► OFFLINE ──► PROBING_NETWORK ──► RECONNECTING ──► CONNECTED
 *                    │              │                    │
 *                    ▼              ▼                    ▼
 *             WAITING_FOR_NETWORK  SESSION_EXPIRED    BACKOFF ──► PROBING_NETWORK
 *
 * Includes two fixes over the original app-side FSM:
 *   1. `backoff` accepts `NETWORK_ONLINE` / `TAB_VISIBLE` — jumps to
 *      probing immediately when the network comes back, without
 *      waiting for the backoff timer to elapse.
 *   2. `scheduleBackoff` parks in `waiting_for_network` (resetting
 *      `attempt`) when `navigator.onLine === false` at max retries,
 *      instead of hard-reloading an already-offline browser.
 */

import { makeAutoObservable, runInAction } from 'mobx';
import { getContext } from '../context.js';
import { probeNetwork, type ProbeResult } from './NetworkProbe.js';

// ─── State ────────────────────────────────────────────────────────────────

export type ConnectionState =
  | 'connected'
  | 'offline'
  | 'probing_network'
  | 'validating_session'
  | 'reconnecting'
  | 'backoff'
  | 'waiting_for_network'
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
  | { type: 'PROBE_FAILED' }
  | { type: 'RECONNECT_SUCCESS' }
  | { type: 'RECONNECT_FAILED' }
  | { type: 'BACKOFF_ELAPSED' }
  | { type: 'BOOTSTRAP_FAILED_SESSION' }
  | { type: 'MANUAL_RETRY' };

// ─── Callbacks ────────────────────────────────────────────────────────────

export interface ConnectionCallbacks {
  /** Run bootstrap + WebSocket reconnect. Returns the outcome. */
  onReconnect: () => Promise<'success' | 'session_error' | 'network_error'>;
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
  private disposed = false;
  private readonly baseUrl?: string;
  private readonly backoff: typeof DEFAULT_BACKOFF;

  private handleBrowserOnline: (() => void) | null = null;
  private handleBrowserOffline: (() => void) | null = null;
  private handleVisibilityChange: (() => void) | null = null;

  constructor(options: ConnectionManagerOptions = {}) {
    this.baseUrl = options.baseUrl;
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
          case 'WS_DISCONNECTED':
            return 'offline';
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
            // Network came back while we were waiting out a backoff
            // delay — jump straight to probing instead of waiting the
            // full exponential interval. Fixes the "doesn't retrigger
            // when internet comes back" bug.
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

  private onEnterState(state: ConnectionState, _event: ConnectionEvent): void {
    switch (state) {
      case 'connected':
        this.clearBackoffTimer();
        break;

      case 'offline':
        this.clearBackoffTimer();
        this.callbacks?.onDisconnectWebSocket();
        break;

      case 'probing_network':
        this.runProbe();
        break;

      case 'waiting_for_network':
        this.scheduleBackoff();
        break;

      case 'reconnecting':
        this.runReconnect();
        break;

      case 'backoff':
        this.scheduleBackoff();
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
      const result = await probeNetwork(this.baseUrl);
      runInAction(() => {
        this.lastProbeResult = result;
      });
      if (result.reachable) {
        this.send({ type: 'PROBE_SUCCESS', sessionValid: result.sessionValid ?? true });
      } else {
        this.send({ type: 'PROBE_FAILED' });
      }
    } catch {
      this.send({ type: 'PROBE_FAILED' });
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
    return this.state === 'probing_network' || this.state === 'reconnecting' || this.state === 'backoff';
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
