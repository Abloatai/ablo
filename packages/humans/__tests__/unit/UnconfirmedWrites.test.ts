/**
 * UnconfirmedWrites — pin the contract the receive layer depends
 * on. The class itself is small, but its behavior is load-bearing
 * for the chart-delete flicker fix: a regression here re-opens the
 * bug. Tests assert the public API only (markPending /
 * consumeEcho / drainOnRollback / getMetrics).
 */

import { describe, it, expect } from '@jest/globals';
import { UnconfirmedWrites } from '../../src/local/transactions/mutations/UnconfirmedWrites';

describe('UnconfirmedWrites', () => {
  it('consumeEcho drains a pending id and reports a hit', () => {
    const tracker = new UnconfirmedWrites();
    tracker.markPending('tx-1');

    expect(tracker.consumeEcho('tx-1')).toBe(true);
    // Second call → no longer pending → not an echo
    expect(tracker.consumeEcho('tx-1')).toBe(false);

    const m = tracker.getMetrics();
    expect(m.size).toBe(0);
    expect(m.hits).toBe(1);
    expect(m.totalAdded).toBe(1);
  });

  it('consumeEcho returns false for unknown / null / undefined ids', () => {
    const tracker = new UnconfirmedWrites();
    expect(tracker.consumeEcho('foreign-tx')).toBe(false);
    expect(tracker.consumeEcho(null)).toBe(false);
    expect(tracker.consumeEcho(undefined)).toBe(false);
    expect(tracker.getMetrics().hits).toBe(0);
  });

  it('drainOnRollback removes the id and counts under rollbacks (not hits)', () => {
    const tracker = new UnconfirmedWrites();
    tracker.markPending('tx-1');
    tracker.drainOnRollback('tx-1');

    expect(tracker.consumeEcho('tx-1')).toBe(false);
    const m = tracker.getMetrics();
    expect(m.rollbacks).toBe(1);
    expect(m.hits).toBe(0);
    expect(m.size).toBe(0);
  });

  it('drainOnRollback on an unknown id is a no-op (no metric bump)', () => {
    const tracker = new UnconfirmedWrites();
    tracker.drainOnRollback('never-staged');
    expect(tracker.getMetrics().rollbacks).toBe(0);
  });

  it('markPending is idempotent — repeated calls do not double-count', () => {
    const tracker = new UnconfirmedWrites();
    tracker.markPending('tx-1');
    tracker.markPending('tx-1');
    tracker.markPending('tx-1');

    const m = tracker.getMetrics();
    expect(m.size).toBe(1);
    expect(m.totalAdded).toBe(1);
  });

  it('evicts oldest pending id (FIFO) when maxSize is hit', () => {
    const tracker = new UnconfirmedWrites({ maxSize: 3 });
    tracker.markPending('tx-1');
    tracker.markPending('tx-2');
    tracker.markPending('tx-3');
    tracker.markPending('tx-4'); // forces eviction of tx-1

    expect(tracker.consumeEcho('tx-1')).toBe(false); // evicted
    expect(tracker.consumeEcho('tx-2')).toBe(true);
    expect(tracker.consumeEcho('tx-3')).toBe(true);
    expect(tracker.consumeEcho('tx-4')).toBe(true);

    const m = tracker.getMetrics();
    expect(m.evictions).toBe(1);
    expect(m.totalAdded).toBe(4);
    expect(m.hits).toBe(3);
  });

  it('clear() resets the pending set but preserves cumulative metrics', () => {
    const tracker = new UnconfirmedWrites();
    tracker.markPending('tx-1');
    tracker.consumeEcho('tx-1');
    tracker.markPending('tx-2');
    tracker.clear();

    const m = tracker.getMetrics();
    expect(m.size).toBe(0);
    // Cumulative counters are not reset — that's intentional;
    // dashboards aggregate over a session, not a single window.
    expect(m.totalAdded).toBe(2);
    expect(m.hits).toBe(1);
  });
});
