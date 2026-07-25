import { EventEmitter } from 'events';
import {
  observeCommitLatency,
  type CommitLatencySample,
} from '../mutations/commitLatency.js';

/**
 * The latency observer pairs events the MutationQueue already emits, so these
 * tests drive a bare emitter with the same event names and payload shapes
 * rather than standing up a queue. The shapes are pinned by
 * `MutationQueue.enqueueCommit` (`commit:staging`/`commit:created` send
 * `{ clientTxId }`) and `completeQueuedCommit` (`transaction:completed` sends
 * the transaction itself, whose `id` IS the `clientTxId`).
 */
describe('observeCommitLatency', () => {
  function setup() {
    const source = new EventEmitter();
    const samples: CommitLatencySample[] = [];
    const stop = observeCommitLatency(source, (s) => samples.push(s));
    return { source, samples, stop };
  }

  /** Drive one full commit lifecycle for `id`. */
  function completeCommit(source: EventEmitter, id: string): void {
    source.emit('commit:staging', { clientTxId: id, operations: [] });
    source.emit('commit:created', { clientTxId: id, operations: [] });
    source.emit('transaction:completed', { id, kind: 'commit' });
  }

  it('emits one sample per completed commit', () => {
    const { source, samples, stop } = setup();

    completeCommit(source, 'tx-1');

    expect(samples).toHaveLength(1);
    expect(samples[0]?.clientTxId).toBe('tx-1');
    stop();
  });

  it('splits the span so seal and ack sum to the total', () => {
    const { source, samples, stop } = setup();

    completeCommit(source, 'tx-1');

    const sample = samples[0];
    expect(sample).toBeDefined();
    if (!sample) return;
    // Wall-clock values are environment-dependent, but the decomposition is an
    // invariant: the two halves must reconstruct the whole.
    expect(sample.sealMs + sample.ackMs).toBeCloseTo(sample.totalMs, 5);
    expect(sample.sealMs).toBeGreaterThanOrEqual(0);
    expect(sample.ackMs).toBeGreaterThanOrEqual(0);
    stop();
  });

  it('ignores completions for transactions it never staged', () => {
    const { source, samples, stop } = setup();

    // `transaction:completed` also fires for local (non-commit) transactions
    // and for mutation-log replay. Those must not produce samples.
    source.emit('transaction:completed', { id: 'local-1', kind: 'local' });

    expect(samples).toHaveLength(0);
    stop();
  });

  it('correlates interleaved commits independently', () => {
    const { source, samples, stop } = setup();

    source.emit('commit:staging', { clientTxId: 'tx-1' });
    source.emit('commit:staging', { clientTxId: 'tx-2' });
    source.emit('commit:created', { clientTxId: 'tx-2' });
    source.emit('transaction:completed', { id: 'tx-2' });
    source.emit('commit:created', { clientTxId: 'tx-1' });
    source.emit('transaction:completed', { id: 'tx-1' });

    expect(samples.map((s) => s.clientTxId)).toEqual(['tx-2', 'tx-1']);
    stop();
  });

  it('drops a commit whose seal failed', () => {
    const { source, samples, stop } = setup();

    source.emit('commit:staging', { clientTxId: 'tx-1' });
    source.emit('commit:seal_failed', { clientTxId: 'tx-1' });
    // A later completion for the same id can only be a stale echo — the
    // pending timing is gone, so nothing is reported.
    source.emit('transaction:completed', { id: 'tx-1' });

    expect(samples).toHaveLength(0);
    stop();
  });

  it('drops a commit that permanently failed', () => {
    const { source, samples, stop } = setup();

    source.emit('commit:staging', { clientTxId: 'tx-1' });
    source.emit('transaction:failed', {
      transaction: { id: 'tx-1' },
      error: new Error('rejected'),
      permanent: true,
    });
    source.emit('transaction:completed', { id: 'tx-1' });

    expect(samples).toHaveLength(0);
    stop();
  });

  it('stops reporting after unsubscribe', () => {
    const { source, samples, stop } = setup();

    stop();
    completeCommit(source, 'tx-1');

    expect(samples).toHaveLength(0);
    expect(source.listenerCount('commit:staging')).toBe(0);
    expect(source.listenerCount('transaction:completed')).toBe(0);
  });

  it('tolerates malformed payloads without throwing', () => {
    const { source, samples, stop } = setup();

    source.emit('commit:staging', null);
    source.emit('commit:staging', { clientTxId: 42 });
    source.emit('transaction:completed', undefined);
    source.emit('transaction:completed', { id: null });

    expect(samples).toHaveLength(0);
    stop();
  });

  it('bounds pending commits so abandoned ones cannot leak', () => {
    const { source, samples, stop } = setup();

    // MAX_PENDING_COMMITS is 256; stage well past it without completing.
    for (let i = 0; i < 300; i += 1) {
      source.emit('commit:staging', { clientTxId: `tx-${i}` });
    }
    // The oldest were evicted, so their completions report nothing...
    source.emit('transaction:completed', { id: 'tx-0' });
    expect(samples).toHaveLength(0);

    // ...while a recent one still correlates.
    source.emit('transaction:completed', { id: 'tx-299' });
    expect(samples).toHaveLength(1);
    stop();
  });
});
