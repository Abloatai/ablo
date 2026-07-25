/**
 * ClaimLog — the evals-shaped consumption path for coordination activity.
 * Proves:
 *   - `captureClaim` / `captureConflict` accumulate into an ordered list
 *   - `collisions()` surfaces only rejected/lost claims + stale writes
 *   - `onChange` fires on every event and unsubscribes cleanly (the
 *     `useSyncExternalStore` contract a live activity feed depends on)
 *   - `entries` returns a NEW reference per event (so reference-equality
 *     snapshot checks re-render) and a STABLE one between events
 *   - the formatters render one readable line per event
 */

import { ClaimLog, formatClaim, formatConflict } from '../ClaimLog.js';
import type { ClaimEvent, ConflictEvent } from '../../interfaces/index.js';

/**
 * An event shaped the way `recordClaim` builds one: the participant an event
 * names is the counterparty that blocked it, and its kind travels with it
 * rather than sitting loose on the event. A fixture that set a bare
 * `participantKind` pinned the formatter to a shape the SDK never emitted.
 */
const claim = (over: Partial<ClaimEvent> = {}): ClaimEvent => ({
  phase: 'acquired',
  model: 'documents',
  id: 'doc-main',
  actor: 'agent-1',
  heldBy: { actor: 'agent-1', participantKind: 'agent' },
  ...over,
});

const conflict = (over: Partial<ConflictEvent> = {}): ConflictEvent => ({
  clientTxId: 'tx_42',
  rows: [{ model: 'documents', id: 'doc-main', fields: ['body'], writtenBy: 'user' }],
  ...over,
});

describe('ClaimLog', () => {
  it('accumulates claim and conflict events in order', () => {
    const log = new ClaimLog();
    log.captureClaim(claim({ phase: 'acquired' }));
    log.captureClaim(claim({ phase: 'rejected', reason: 'conflict' }));
    log.captureConflict(conflict());

    expect(log.entries).toHaveLength(3);
    expect(log.entries.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(log.entries[0]?.claim?.phase).toBe('acquired');
    expect(log.entries[2]?.conflict?.clientTxId).toBe('tx_42');
  });

  it('flags only collisions: rejected/lost claims and stale writes', () => {
    const log = new ClaimLog();
    log.captureClaim(claim({ phase: 'acquired' }));
    log.captureClaim(claim({ phase: 'queued', position: 1 }));
    log.captureClaim(claim({ phase: 'granted' }));
    log.captureClaim(claim({ phase: 'rejected' }));
    log.captureClaim(claim({ phase: 'lost' }));
    log.captureConflict(conflict());

    expect(log.collisions().map((e) => e.claim?.phase ?? 'conflict')).toEqual([
      'rejected',
      'lost',
      'conflict',
    ]);
  });

  it('fires onChange on every event and stops after unsubscribe', () => {
    const log = new ClaimLog();
    const listener = jest.fn();
    const unsubscribe = log.onChange(listener);

    log.captureClaim(claim());
    log.captureConflict(conflict());
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    log.captureClaim(claim());
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('returns a stable entries reference between events, a fresh one after', () => {
    const log = new ClaimLog();
    const before = log.entries;
    expect(log.entries).toBe(before); // stable — no spurious re-render

    log.captureClaim(claim());
    expect(log.entries).not.toBe(before); // changed — useSyncExternalStore re-renders
  });

  it('caps the buffer and keeps the most recent entries', () => {
    const log = new ClaimLog(2);
    log.captureClaim(claim({ id: 'a' }));
    log.captureClaim(claim({ id: 'b' }));
    log.captureClaim(claim({ id: 'c' }));

    expect(log.entries).toHaveLength(2);
    expect(log.entries.map((e) => e.claim?.id)).toEqual(['b', 'c']);
  });

  it('clear() empties the log and notifies', () => {
    const log = new ClaimLog();
    const listener = jest.fn();
    log.onChange(listener);
    log.captureClaim(claim());

    log.clear();
    expect(log.entries).toHaveLength(0);
    expect(listener).toHaveBeenCalledTimes(2); // capture + clear
  });

  it('toString() renders a marked, numbered timeline', () => {
    const log = new ClaimLog();
    expect(log.toString()).toBe('claim log: (empty)');

    log.captureClaim(claim({ phase: 'acquired' }));
    log.captureClaim(claim({ phase: 'rejected', reason: 'conflict' }));
    const lines = log.toString().split('\n');

    expect(lines[0]).toContain('claim acquired: documents/doc-main');
    expect(lines[1]).toContain('⚠'); // collision marker
    expect(lines[1]).toContain('claim rejected: documents/doc-main');
  });
});

describe('formatters', () => {
  it('formatClaim names the blocking holder on rejected', () => {
    expect(formatClaim(claim({ phase: 'rejected', reason: 'conflict' }))).toBe(
      'claim rejected: documents/doc-main — held by agent-1 (agent): conflict',
    );
  });

  it('formatClaim shows queue position', () => {
    expect(formatClaim(claim({ phase: 'queued', position: 2 }))).toContain('[pos 2]');
  });

  it('formatConflict lists the changed rows and fields', () => {
    expect(formatConflict(conflict())).toBe(
      'conflict: tx tx_42 — 1 row(s) changed underneath: documents/doc-main(body)',
    );
  });
});
