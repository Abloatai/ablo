/**
 * Commit latency — how long a user's edit actually takes to land.
 *
 * The engine has never measured this. HUDs and dashboards reach for
 * `window.fetch` timings, which the sync engine's WebSocket never touches, so
 * the latency a user sees reported while editing has had nothing to do with
 * the writes they are making. This module closes that gap without adding a
 * single timestamp to the hot path: `MutationQueue` already emits the commit
 * lifecycle, and the events already carry the correlation key.
 *
 * Three events, two intervals:
 *
 *   commit:staging ──sealMs──▶ commit:created ──ackMs──▶ transaction:completed
 *
 *  - `sealMs` is **local** — writing the durable envelope before the commit is
 *    allowed onto the wire. Slow here means durable storage, not network.
 *  - `ackMs` is **remote** — dispatch, round-trip, and server work. For a
 *    commit routed at a connected source this also spans the wait for the
 *    correlated echo that promotes `queued` to `confirmed`, so it answers
 *    "when did my edit become real" rather than raw socket round-trip. Read a
 *    large `ackMs` against a small `sealMs` as a network or replication cost.
 *
 * Correlation is by `clientTxId`: `MutationQueue` uses it as the transaction
 * id verbatim, so the staging event and the completion event share one key.
 */

/**
 * The slice of an event emitter this module needs. Declared structurally so a
 * plain object can stand in under test — `MutationQueue` satisfies it by
 * extending `EventEmitter`.
 */
export interface CommitEventSource {
  on(event: string, listener: (payload: unknown) => void): unknown;
  off(event: string, listener: (payload: unknown) => void): unknown;
}

/** One completed commit, broken into its local and remote halves. */
export interface CommitLatencySample {
  /** The commit's `clientTxId`, identical to its transaction id. */
  clientTxId: string;
  /** Milliseconds sealing the durable envelope locally. */
  sealMs: number;
  /** Milliseconds from sealed envelope to acknowledgement. */
  ackMs: number;
  /** Milliseconds from staging to acknowledgement — `sealMs + ackMs`. */
  totalMs: number;
}

interface PendingCommitTiming {
  stagedAt: number;
  /** Set when the envelope seals; null while the seal is still in flight. */
  sealedAt: number | null;
}

/**
 * Cap on commits awaiting completion. A commit whose completion never arrives
 * (connection dropped mid-flight, retry abandoned) would otherwise pin its
 * entry forever, so the map is bounded rather than trusted to drain.
 */
const MAX_PENDING_COMMITS = 256;

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Read `clientTxId` off a `commit:*` payload, or null if it isn't shaped so. */
function readClientTxId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { clientTxId } = payload as { clientTxId?: unknown };
  return typeof clientTxId === 'string' ? clientTxId : null;
}

/** Read `id` off a transaction payload (`transaction:completed` sends the tx). */
function readTransactionId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { id } = payload as { id?: unknown };
  return typeof id === 'string' ? id : null;
}

/** `transaction:failed` wraps the transaction rather than sending it bare. */
function readFailedTransactionId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  return readTransactionId((payload as { transaction?: unknown }).transaction);
}

/**
 * Pair commit lifecycle events into latency samples. Returns an unsubscribe
 * function that also drops any still-pending timings.
 *
 * `onSample` fires once per commit that completes, in completion order.
 */
export function observeCommitLatency(
  source: CommitEventSource,
  onSample: (sample: CommitLatencySample) => void,
): () => void {
  const pending = new Map<string, PendingCommitTiming>();

  const handleStaging = (payload: unknown): void => {
    const id = readClientTxId(payload);
    if (id === null) return;
    // Map preserves insertion order, so the first key is the stalest entry.
    if (pending.size >= MAX_PENDING_COMMITS) {
      const oldest = pending.keys().next();
      if (!oldest.done) pending.delete(oldest.value);
    }
    pending.set(id, { stagedAt: nowMs(), sealedAt: null });
  };

  const handleCreated = (payload: unknown): void => {
    const id = readClientTxId(payload);
    if (id === null) return;
    const timing = pending.get(id);
    if (timing === undefined) return;
    timing.sealedAt = nowMs();
  };

  const handleCompleted = (payload: unknown): void => {
    const id = readTransactionId(payload);
    if (id === null) return;
    const timing = pending.get(id);
    // `transaction:completed` also fires for local (non-commit) transactions
    // and for mutation-log replay. Only ids we staged are commits, so an
    // absent entry is the normal way those are filtered out.
    if (timing === undefined) return;
    pending.delete(id);

    const completedAt = nowMs();
    // A commit can complete without an observed seal only if the listener was
    // attached mid-flight; attributing the whole span to `ackMs` keeps
    // `sealMs + ackMs === totalMs` true rather than reporting a bogus seal.
    const sealedAt = timing.sealedAt ?? timing.stagedAt;
    onSample({
      clientTxId: id,
      sealMs: sealedAt - timing.stagedAt,
      ackMs: completedAt - sealedAt,
      totalMs: completedAt - timing.stagedAt,
    });
  };

  const handleSealFailed = (payload: unknown): void => {
    const id = readClientTxId(payload);
    if (id !== null) pending.delete(id);
  };

  const handleFailed = (payload: unknown): void => {
    const id = readFailedTransactionId(payload);
    if (id !== null) pending.delete(id);
  };

  source.on('commit:staging', handleStaging);
  source.on('commit:created', handleCreated);
  source.on('commit:seal_failed', handleSealFailed);
  source.on('transaction:completed', handleCompleted);
  source.on('transaction:failed', handleFailed);

  return () => {
    source.off('commit:staging', handleStaging);
    source.off('commit:created', handleCreated);
    source.off('commit:seal_failed', handleSealFailed);
    source.off('transaction:completed', handleCompleted);
    source.off('transaction:failed', handleFailed);
    pending.clear();
  };
}
