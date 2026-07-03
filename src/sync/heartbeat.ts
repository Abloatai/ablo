/**
 * Application-level heartbeat for the sync WebSocket.
 *
 * The browser WebSocket API hides RFC 6455 protocol-level ping/pong from
 * JavaScript, so the server's `ws.ping()` keepalive can't be observed by
 * client code — meaning the client cannot tell a healthy idle connection
 * apart from a "zombie" socket where TCP silently broke (laptop sleep,
 * NAT timeout, mobile handoff). We send an application-level
 * `{ type: 'ping' }` every 30s and force-close the socket if no inbound
 * traffic arrives within 10s. ANY inbound message counts as
 * proof-of-life — the explicit `pong` is just a guarantee that something
 * will arrive even on an idle stream.
 */

import { getContext } from '../context.js';
import { PING_INTERVAL_MS } from '../wire/protocol.js';

/**
 * One cadence for both sides: the SDK's application-level ping runs at the
 * same `PING_INTERVAL_MS` as the server's RFC 6455 keepalive (and the claim
 * lease window is derived from it — see `wire/protocol.ts`).
 */
export const HEARTBEAT_INTERVAL_MS = PING_INTERVAL_MS;
export const HEARTBEAT_TIMEOUT_MS = 10_000;

/**
 * The slice of the socket the heartbeat needs — kept minimal so this
 * leaf never depends on the SyncWebSocket class itself.
 */
export interface HeartbeatTransport {
  /** True only while the underlying socket is `OPEN`. */
  isSocketOpen(): boolean;
  /** Send the `{ type: 'ping' }` frame; throws when the socket is already dead. */
  sendPing(): void;
  /**
   * Force-close the socket from the client side (private 4xxx code) so
   * `onclose` fires and runs the owner's reconnect / handshake-failed
   * dispatch.
   */
  forceClose(reason: string): void;
}

/**
 * Every `HEARTBEAT_INTERVAL_MS` while `OPEN`, send `{ type: 'ping' }`
 * and arm a `HEARTBEAT_TIMEOUT_MS` watchdog. Any inbound frame (the
 * owner's `onmessage` calls {@link clearHeartbeatTimeout}) clears the
 * watchdog. If the watchdog fires, we treat the connection as zombie
 * and force-close it — `onclose` then triggers the existing reconnect
 * path.
 *
 * Why both sides need this:
 *  - The server sends RFC 6455 protocol pings via `ws.ping()` every
 *    30s. Browsers auto-respond with a pong but DO NOT expose either
 *    frame to JavaScript, so the client is blind to its own keepalive.
 *  - On a half-open TCP (laptop wake, NAT timeout, mobile handoff)
 *    the browser may keep `readyState === OPEN` for minutes before
 *    the OS surfaces the broken connection. App-level traffic is
 *    the only signal we can observe.
 */
export class HeartbeatController {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly transport: HeartbeatTransport) {}

  start(): void {
    this.stop();
    this.heartbeatTimer = setInterval(() => {
      if (!this.transport.isSocketOpen()) return;

      // Send the ping. If `send` throws, the socket is already dead —
      // force-close so onclose triggers the reconnect cycle.
      try {
        this.transport.sendPing();
      } catch (err) {
        getContext().observability.captureWebSocketError({
          context: 'heartbeat-send-failed',
          error: err instanceof Error ? err.message : String(err),
        });
        this.transport.forceClose('heartbeat-send-failed');
        return;
      }

      // Arm the timeout. ANY inbound message clears it (see the owner's
      // onmessage). We don't require an explicit `pong` — a delta or any
      // other frame is equally good proof-of-life.
      if (this.heartbeatTimeoutTimer) clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = setTimeout(() => {
        getContext().observability.captureWebSocketError({
          context: 'heartbeat-timeout',
        });
        this.transport.forceClose('heartbeat-timeout');
      }, HEARTBEAT_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.clearHeartbeatTimeout();
  }

  clearHeartbeatTimeout(): void {
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }
}
