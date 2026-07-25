import { blockers, schemaDrift, type DataSourceState } from '../readiness';

/**
 * The verdict `ablo status` closes with. It decides whether the command may
 * claim a write would succeed — the claim that previously went unqualified
 * while every write was being held, which sent the search into the application
 * instead of the setup. These exercise the pure decision on constructed inputs;
 * the network reads that produce them are covered where they are used.
 */

// No hosts reported, so pooler detection finds nothing — the neutral baseline
// these cases want, which is separate from what pooler detection does with one.
const connected: DataSourceState = { kind: 'connected', connections: ['direct'], hosts: [] };
const none: DataSourceState = { kind: 'none' };
const unknown: DataSourceState = { kind: 'unknown', detail: 'HTTP 403' };

/** A setup with nothing wrong: reachable, keyed, connected, schema in sync. */
function healthy(over: Partial<Parameters<typeof blockers>[0]> = {}) {
  return {
    reachable: true,
    hasKey: true,
    dataSource: connected,
    schemaPushed: true,
    drift: null,
    ...over,
  };
}

describe('blockers', () => {
  it('reports nothing when the setup can actually write', () => {
    expect(blockers(healthy())).toEqual([]);
  });

  it('names a plane with no database — the state a read probe cannot see', () => {
    const found = blockers(healthy({ dataSource: none }));
    expect(found).toHaveLength(1);
    expect(found[0]?.problem).toContain('no database is connected');
    expect(found[0]?.fix).toContain('ablo connect apply');
  });

  it('does NOT treat an unreadable plane as a missing database', () => {
    // A restricted key cannot enumerate data sources. That is a fact about the
    // key; concluding "nothing is connected" from it would be a false alarm.
    expect(blockers(healthy({ dataSource: unknown }))).toEqual([]);
  });

  it('stops at the first fact that makes the others unverifiable', () => {
    // Unreachable: every downstream finding was read from a server that did not
    // answer, so reporting them alongside would present guesses as findings.
    const found = blockers(healthy({ reachable: false, dataSource: none, schemaPushed: false }));
    expect(found).toHaveLength(1);
    expect(found[0]?.problem).toContain('unreachable');
  });

  it('leads with the missing key, since nothing else can be checked without one', () => {
    const found = blockers(healthy({ hasKey: false, reachable: false }));
    expect(found).toHaveLength(1);
    expect(found[0]?.problem).toContain('no API key');
  });

  it('reports drift with both hashes, so the two can be matched by eye', () => {
    const found = blockers(healthy({ drift: { local: 'b2534261', server: 'ed3ab796' } }));
    expect(found).toHaveLength(1);
    expect(found[0]?.problem).toContain('b2534261');
    expect(found[0]?.problem).toContain('ed3ab796');
  });

  it('accumulates independent problems rather than reporting only the first', () => {
    const found = blockers(healthy({ dataSource: none, schemaPushed: false }));
    expect(found.map((b) => b.problem)).toHaveLength(2);
  });
});

describe('schemaDrift', () => {
  it('is silent when the two agree', () => {
    expect(schemaDrift('abc123', 'abc123')).toBeNull();
  });

  it('is silent when either side is unknown — absence is not disagreement', () => {
    expect(schemaDrift(null, 'abc123')).toBeNull();
    expect(schemaDrift('abc123', undefined)).toBeNull();
  });

  it('reports both sides when they differ', () => {
    expect(schemaDrift('local1', 'server1')).toEqual({ local: 'local1', server: 'server1' });
  });
});
