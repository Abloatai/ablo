/**
 * The timing constants both sides of the protocol must agree on: the ping
 * cadence and the lease window derived from it. Defining them here once keeps
 * the client and the server from skewing apart — a change to the ping interval
 * that did not also move the lease window would make claim expiry and presence
 * timeouts disagree between the two.
 *
 * {@link PING_INTERVAL_MS} is how often the connection pings to prove it is
 * alive. {@link LEASE_TTL_MS} is how long a claim or presence entry stays valid
 * without a renewing ping. On the client, these set the heartbeat cadence and
 * the fallback expiry for a claim taken without an explicit lease. On the
 * server, they set the keepalive interval, the lease granted per keepalive, and
 * the presence-entry lifetime, so a silently disconnected client drops off the
 * roster within one lease window.
 *
 * The lease is three ping intervals long and is renewed on every ping, so a
 * live holder always has at least two intervals of runway and a silent one
 * lapses about two missed pings after it stops renewing. The window measures
 * liveness, not how long a item may run: widening the lease without also
 * widening the ping makes holders flap, and neither value should be redefined
 * anywhere else.
 */
export const PING_INTERVAL_MS = 30_000;
export const LEASE_TTL_MS = 3 * PING_INTERVAL_MS;

/**
 * The WebSocket subprotocols that carry the bearer credential out of the URL.
 *
 * A browser cannot set an `Authorization` header on a WebSocket, so the client
 * offers the token as a `Sec-WebSocket-Protocol` value — `ablo.bearer.<token>` —
 * alongside the real `ablo.sync.v1` protocol the server selects. This keeps the
 * credential out of the query string, which access logs, proxies, and browser
 * history would otherwise capture. The server reads the token from the
 * subprotocol and echoes back only `ablo.sync.v1`, never the token-bearing
 * value. Both the client and the server import these constants, so the
 * handshake format cannot drift.
 */
export const WS_BEARER_SUBPROTOCOL_PREFIX = 'ablo.bearer.';
export const WS_SYNC_SUBPROTOCOL = 'ablo.sync.v1';
