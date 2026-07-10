/**
 * The functional update — `ablo.<model>.update(id, current => next)`.
 *
 * This is the surface that just works under contention. You express only your
 * intent — given the latest row, here is the next state — and the client does
 * the rest: it reads the fresh row and its watermark, runs your updater, writes
 * the result as a compare-and-swap against that watermark, and on any concurrent
 * write it re-reads, recomputes, and retries. No claim, no identity, no transport
 * awareness, and no `stale_context` or `claim_*` error codes ever reach the
 * caller. The write either lands or, at the extreme, throws a single
 * {@link AbloContentionError} once the reconcile budget is spent.
 *
 * Correctness comes from the `readAt` watermark plus `onStale: 'reject'`
 * (optimistic concurrency, or compare-and-swap), not from participant identity.
 * That is why it is immune to the shared-credential silent-overwrite hazard and
 * behaves identically on both transports: the HTTP and WebSocket clients inject
 * the same two functions ({@link ReconcileTransport}) into the shared loop below,
 * so the guarantee cannot drift between them — only the mechanism differs.
 *
 * The mental model is React's `setState(prev => next)`: pass a function of the
 * current state and the runtime owns reconciliation.
 */

import {
  AbloError,
  AbloNotFoundError,
  AbloStaleContextError,
  AbloClaimedError,
  AbloContentionError,
} from '../errors.js';

/**
 * The functional form of an update: given the freshly-read row, return the
 * fields to write. Return `null` or `undefined` to make no write — a no-op the
 * caller chose after seeing the latest state (for example, "already done").
 */
export type ModelUpdater<T> = (
  current: T,
) => Partial<T> | null | undefined | Promise<Partial<T> | null | undefined>;

/** Tuning for the functional update's internal reconcile loop. */
export interface ContentionOptions {
  /**
   * Max reconcile rounds under contention before throwing
   * {@link AbloContentionError}. Each round re-reads the latest row and re-runs
   * your updater. Defaults to {@link DEFAULT_CONTENTION_RETRIES}.
   */
  readonly retries?: number;
  /** Abort the reconcile loop (e.g. the request was cancelled). */
  readonly signal?: AbortSignal;
}

/** Reconcile rounds before a hot row is declared permanently contended. */
export const DEFAULT_CONTENTION_RETRIES = 16;

/**
 * Reports whether a thrown error means "another writer moved the row — re-read
 * and retry" rather than a genuine failure to surface. These are the
 * optimistic-concurrency signals the functional update reconciles against:
 *   - `stale_context` — the `readAt` watermark was overtaken by a concurrent write
 *   - `claim_lost`    — a holder preempted the write (for example a human under `humansOverwrite`)
 *   - `claim_queued`  — a holder is actively editing the row right now
 */
export function isReconcilableConflict(err: unknown): boolean {
  if (err instanceof AbloStaleContextError) return true;
  if (err instanceof AbloClaimedError) {
    return err.code === 'claim_lost' || err.code === 'claim_queued';
  }
  return false;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Jittered backoff so N reconcilers retrying at once don't lock-step straight
 * back into the same collision. Bounded; grows mildly with the attempt.
 */
function backoffMs(attempt: number): number {
  return 60 + attempt * 40 + Math.floor(Math.random() * 60);
}

/**
 * The transport-specific read and write that the shared loop drives. Each client
 * injects its own pair — the one thing that differs between the HTTP and
 * WebSocket transports.
 */
export interface ReconcileTransport<T, R> {
  readonly model: string;
  readonly id: string;
  /** Read the latest row and its watermark from the authoritative store. */
  readFresh: () => Promise<{ readonly data: T | null | undefined; readonly stamp: number }>;
  /**
   * Write the computed patch as a compare-and-swap against `readAt`. It must
   * throw a reconcilable conflict (`stale_context` or `claim_*`) when the
   * watermark was overtaken — that rejection is what drives the next reconcile
   * round.
   */
  writeNext: (patch: Partial<T>, readAt: number) => Promise<R>;
}

/**
 * Run the read-fresh → compute → compare-and-swap → reconcile loop. Shared by
 * both transports so the guarantee is provably identical. Returns the write's
 * result, or `undefined` when the updater opted out of writing.
 */
export async function reconcileFunctionalUpdate<T, R>(
  updater: ModelUpdater<T>,
  options: ContentionOptions | undefined,
  transport: ReconcileTransport<T, R>,
): Promise<R | undefined> {
  const retries = options?.retries ?? DEFAULT_CONTENTION_RETRIES;
  let lastConflict: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (options?.signal?.aborted) {
      throw new AbloError(
        `Update of ${transport.model}/${transport.id} was aborted before it landed.`,
        { code: 'update_aborted' },
      );
    }

    const { data, stamp } = await transport.readFresh();
    if (data == null) {
      throw new AbloNotFoundError(
        `Cannot update ${transport.model}/${transport.id}: it does not exist (or is ` +
          `outside this credential's scope).`,
        [transport.id],
      );
    }

    const patch = await updater(data);
    if (patch == null) return undefined; // updater opted out after reading fresh

    try {
      return await transport.writeNext(patch, stamp);
    } catch (err) {
      if (!isReconcilableConflict(err)) throw err; // genuine failure — surface it
      lastConflict = err;
      if (attempt < retries) await sleep(backoffMs(attempt));
    }
  }

  throw new AbloContentionError(transport.model, transport.id, retries + 1, {
    cause: lastConflict,
  });
}

// Re-exported so call sites import the loop and its terminal error from one
// place; the class itself lives with the rest of the error hierarchy.
export { AbloContentionError };
