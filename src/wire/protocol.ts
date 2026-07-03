/**
 * Cross-boundary protocol TIMING constants — the one place the 30s ping
 * cadence and the claim/presence lease window are defined. Before this leaf
 * existed the pair was copy-pasted across five sites in four modules, kept
 * in sync only by comments ("~3× the 30s ping"); changing the server ping
 * silently skewed the SDK's claim-expiry estimate and presence reaping.
 *
 * Consumers (SDK side, relative import):
 *   - `sync/heartbeat.ts` — `HEARTBEAT_INTERVAL_MS`, the SDK's
 *     application-level `{ type: 'ping' }` cadence.
 *   - `client/createModelProxy.ts` — `DEFAULT_LEASE_TTL_MS`, the client's
 *     expiry estimate for a claim taken without an explicit TTL.
 *
 * Consumers (server side, via `@abloatai/ablo/wire`):
 *   - `apps/sync-server/src/hub/Hub.ts` — the RFC 6455 `ws.ping()`
 *     keepalive interval (the tick that renews claim leases).
 *   - `apps/sync-server/src/hub/claimCoordinator.ts` —
 *     `LEASE_RENEW_TTL_MS`, the lease lifetime granted per keepalive tick.
 *   - `apps/sync-server/src/presence/PresenceStore.ts` — the default
 *     presence-entry TTL (a silently-dead client leaves the roster within
 *     one lease window).
 *
 * INVARIANT: `LEASE_TTL_MS === 3 * PING_INTERVAL_MS`. The lease is renewed
 * on every ping, so a live holder always has ≥ 2 ping intervals of runway,
 * and a silent one lapses ~2 missed pings after it stops renewing. TTL is
 * liveness, not work-duration — never widen the lease without widening the
 * ping (or holders will flap), and never derive either value locally.
 */
export const PING_INTERVAL_MS = 30_000;
export const LEASE_TTL_MS = 3 * PING_INTERVAL_MS;

/**
 * WebSocket subprotocols used to carry the bearer credential OUT of the URL.
 *
 * Browsers cannot set an `Authorization` header on a WebSocket, so the SDK
 * offers the token as a `Sec-WebSocket-Protocol` value — `ablo.bearer.<token>` —
 * alongside the real `ablo.sync.v1` protocol the server selects. This keeps the
 * credential out of the query string, which ALB access logs, proxies, and
 * browser history capture. The server reads the token from the subprotocol and
 * echoes back ONLY `ablo.sync.v1`, never the token-bearing value. Lives in
 * `wire/` (not `auth/`) because it IS the wire contract: client and server
 * import the same constants so the handshake format can never drift.
 * Re-exported from `auth/credentialSource.ts` for existing SDK importers.
 */
export const WS_BEARER_SUBPROTOCOL_PREFIX = 'ablo.bearer.';
export const WS_SYNC_SUBPROTOCOL = 'ablo.sync.v1';
