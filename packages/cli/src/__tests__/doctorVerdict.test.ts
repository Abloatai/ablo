import { doctorVerdict } from '../doctor';

/**
 * The rule this pins: a check that could not be RUN is not a check that PASSED.
 *
 * `ablo doctor` is used as a setup gate in CI, and it used to exit zero whenever
 * nothing had actively failed — including runs where the database or delivery
 * check could not be determined at all. A restricted key that cannot read the
 * plane produced a green build over a question nobody answered. The readiness
 * layer already keeps `unknown` separate from healthy; this is the last step
 * that carries the distinction out to the caller.
 */
describe('doctorVerdict', () => {
  it('is ready only when everything ran and nothing failed', () => {
    expect(doctorVerdict({ blockers: 0, failed: 0, skipped: 0 })).toBe('ready');
  });

  it('is unverified when a check could not be run, even with no failures', () => {
    expect(doctorVerdict({ blockers: 0, failed: 0, skipped: 1 })).toBe('unverified');
  });

  it('reports a real failure ahead of an unverified one', () => {
    expect(doctorVerdict({ blockers: 0, failed: 1, skipped: 3 })).toBe('blocked');
  });

  it('is blocked on a blocker even when every check rendered clean', () => {
    expect(doctorVerdict({ blockers: 1, failed: 0, skipped: 0 })).toBe('blocked');
  });
});
