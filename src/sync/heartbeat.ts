/**
 * Application-level heartbeat for the sync WebSocket.
 *
 * The browser WebSocket API hides RFC 6455 protocol-level ping and pong frames
 * from JavaScript, so the server's keepalive cannot be observed by client
 * code. That leaves the client unable to tell a healthy idle connection apart
 * from a "zombie" socket whose underlying TCP connection has silently broken
 * (laptop sleep, NAT timeout, mobile handoff). To close the gap, the client
 * sends an application-level `{ type: 'ping' }` every 30 seconds and
 * force-closes the socket if no inbound traffic arrives within 10 seconds. Any
 * inbound message counts as proof the connection is alive; the explicit `pong`
 * merely guarantees that something arrives even on an otherwise idle stream.
 */

import { getContext } from '../context.js';
import { PING_INTERVAL_MS } from '../wire/protocol.js';

/**
 * The interval between application-level pings, shared with both sides of the
 * connection: the client pings at the same {@link PING_INTERVAL_MS} the server
 * uses for its own keepalive, and the claim lease window is derived from the
 * same constant.
 */
export const HEARTBEAT_INTERVAL_MS = PING_INTERVAL_MS;
export const HEARTBEAT_TIMEOUT_MS = 10_000;

/**
 * The narrow slice of the socket the heartbeat depends on. Keeping it small
 * lets the {@link HeartbeatController} work without depending on the full
 * WebSocket transport.
 */
export interface HeartbeatTransport {
  /** True only while the underlying socket is open. */
  isSocketOpen(): boolean;
  /** Sends the `{ type: 'ping' }` frame; throws when the socket is already dead. */
  sendPing(): void;
  /**
   * Closes the socket from the client side with a private 4xxx code, so the
   * socket's close event fires and the owner's reconnect or handshake-failure
   * handling runs.
   */
  forceClose(reason: string): void;
}

/**
 * Runs the application-level heartbeat for one socket. While the socket is
 * open, it sends a `{ type: 'ping' }` frame every {@link HEARTBEAT_INTERVAL_MS}
 * and arms a {@link HEARTBEAT_TIMEOUT_MS} watchdog. Any inbound frame clears
 * the watchdog — the owner calls {@link HeartbeatController.clearHeartbeatTimeout}
 * from its message handler. If the watchdog fires first, the connection is
 * treated as a zombie and force-closed, which lets the owner's reconnect path
 * run.
 *
 * The heartbeat exists because the client cannot see the protocol-level
 * keepalive: browsers answer the server's pings automatically but never expose
 * those frames to JavaScript. On a half-open connection (laptop wake, NAT
 * timeout, mobile handoff) the socket can report itself open for minutes
 * before the operating system surfaces the break, so observable application
 * traffic is the only reliable signal.
 */
export class HeartbeatController {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly transport: HeartbeatTransport) {}

  start(): void {
    this.stop();
    this.heartbeatTimer = setInterval(() => {
      if (!this.transport.isSocketOpen()) return;

      // Send the ping. If it throws, the socket is already dead, so
      // force-close it to let the close event drive the reconnect cycle.
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

      // Arm the timeout. Any inbound message clears it; an explicit `pong` is
      // not required, since a delta or any other frame is equally good proof
      // that the connection is alive.
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
