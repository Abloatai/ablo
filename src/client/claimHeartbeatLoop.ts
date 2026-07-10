/**
 * The auto-heartbeat loop behind `claim({ id, heartbeat: true })` — one
 * implementation shared by both transports (the WebSocket claim stream and the
 * HTTP `ApiClient`), so the cadence and failure semantics cannot drift.
 *
 * A beat is the "still working" signal that keeps a lease alive for the
 * duration of real work. The loop's failure handling follows the lease-system
 * convention (SQS visibility heartbeats, Kubernetes leases): a beat that fails
 * for a transient reason — the network blipped, the server was briefly
 * unavailable — is simply retried on the next tick, because the lease has
 * runway to spare by construction (the default cadence is a third of the TTL,
 * so two consecutive beats can fail before the lease is even at risk). Only a
 * definitive answer from the server — the lease lapsed and may have been
 * granted to the next in line ({@link AbloClaimedError}) — stops the loop and
 * surfaces the loss, because for a caller with no push channel the failed beat
 * IS the loss notification.
 */

import { AbloClaimedError } from '../errors.js';
import type {
  ClaimHeartbeat,
  ClaimHeartbeatOptions,
  Duration,
} from '../types/streams.js';
import { toMs } from '../utils/duration.js';

/**
 * Normalize the public `heartbeat(options?)` argument — a bare Duration is
 * shorthand for `{ ttl }`. Shared by both transports' handle assembly so the
 * shorthand cannot drift.
 */
export function resolveHeartbeatOptions(
  input: Duration | ClaimHeartbeatOptions | undefined,
): ClaimHeartbeatOptions {
  if (input === undefined) return {};
  if (typeof input === 'string' || typeof input === 'number') {
    return { ttl: input };
  }
  return input;
}

/**
 * The beat cadence for a lease of `ttlMs`: an explicit duration when the
 * caller set one, otherwise a third of the TTL (floored at 1s) — the
 * DynamoDB-lock-client rule, leaving two missed beats of runway before the
 * lease is at risk while keeping crash recovery within one beat window.
 */
export function heartbeatCadenceMs(
  ttlMs: number,
  heartbeat: true | Duration,
): number {
  if (heartbeat !== true) return toMs(heartbeat);
  return Math.max(Math.floor(ttlMs / 3), 1_000);
}

export interface ClaimHeartbeatLoopOptions {
  /** Send one beat; resolves while the lease is still ours. */
  beat(): Promise<ClaimHeartbeat>;
  /** Cadence between beats. Callers default this to a third of the TTL. */
  intervalMs: number;
  /**
   * Called once when a beat comes back with a definitive loss — the lease
   * expired or was taken. The loop has already stopped by the time this runs.
   */
  onLost?(error: AbloClaimedError): void;
}

/**
 * Start beating. Returns a stop function; callers stop the loop when the
 * claim is released (all held-claim assembly sites tie this to `release`).
 * Beats never overlap: a tick that fires while the previous beat is still
 * in flight is skipped rather than stacked.
 */
export function startClaimHeartbeatLoop(
  options: ClaimHeartbeatLoopOptions,
): () => void {
  let stopped = false;
  let inFlight = false;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };

  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = true;
    options
      .beat()
      .catch((error: unknown) => {
        if (stopped) return;
        if (error instanceof AbloClaimedError) {
          stop();
          options.onLost?.(error);
          return;
        }
        // Transient (connection, brief server unavailability): the next tick
        // is the retry — the ttl/3 cadence leaves runway for missed beats.
      })
      .finally(() => {
        inFlight = false;
      });
  }, options.intervalMs);
  // The loop must never be what keeps a Node process alive — the held work
  // is. A worker that finishes without releasing exits anyway, and the lease
  // lapses on schedule. No-op in browsers (where setInterval returns a number
  // without `unref`), which is why the call is optional even though the Node
  // timer type always has it.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  timer.unref?.();

  return stop;
}
