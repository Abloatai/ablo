/**
 * The conflict rule, which decides whether a second writer waits or writes.
 *
 * Every case here is written from the consequence, not the code: a `true` that
 * should be `false` costs someone a wait, and a `false` that should be `true`
 * hands two writers the same target and loses one of their updates silently.
 * The second kind is why this file exists — the rule shipped for a long time
 * with no tests at all, and it had two of them.
 */

import { targetsConflict, subTarget } from '@ablo/transaction/coordination';
import { claimRequestSchema } from '@ablo/transaction/wire';

describe('targetsConflict — whole-entity claims', () => {
  it('a claim naming no part of the row conflicts with everything under it', () => {
    expect(targetsConflict({}, { field: 'title' })).toBe(true);
    expect(targetsConflict({ field: 'title' }, {})).toBe(true);
    expect(targetsConflict({}, {})).toBe(true);
  });
});

describe('targetsConflict — fields', () => {
  it('the same field conflicts, and case never decides it', () => {
    expect(targetsConflict({ field: 'title' }, { field: 'title' })).toBe(true);
    expect(targetsConflict({ field: 'Title' }, { field: 'tITLE' })).toBe(true);
  });

  it('different fields of one row do not conflict', () => {
    expect(targetsConflict({ field: 'title' }, { field: 'body' })).toBe(false);
  });

  // The defect that motivated `fields`. With only `field`, a caller who needed
  // to claim three blocks packed them into one delimited string, and this rule
  // compared that string for equality — so two claims that genuinely shared a
  // block read as unrelated and BOTH were granted.
  it('overlapping field sets conflict', () => {
    expect(
      targetsConflict({ fields: ['b_1'] }, { fields: ['b_1', 'b_2'] }),
    ).toBe(true);
  });

  it('disjoint field sets do not conflict', () => {
    expect(
      targetsConflict({ fields: ['b_1', 'b_2'] }, { fields: ['b_3'] }),
    ).toBe(false);
  });

  it('a set and a single field compare against each other', () => {
    expect(targetsConflict({ field: 'b_2' }, { fields: ['b_1', 'b_2'] })).toBe(
      true,
    );
    expect(targetsConflict({ field: 'b_9' }, { fields: ['b_1', 'b_2'] })).toBe(
      false,
    );
  });

  it('an empty set claims the whole row, like naming no field at all', () => {
    expect(targetsConflict({ fields: [] }, { field: 'title' })).toBe(true);
  });
});

describe('targetsConflict — field is the floor (no sub-field path/range)', () => {
  // `path` and `range` are removed: a claim cannot be finer than a whole
  // field, because nothing writes part of a value. Two writers on one field
  // always contend, and there is no spelling for "different parts of it" until
  // same-field concurrency (operational transformation) is solved.
  it('metadata never decides a conflict', () => {
    expect(
      targetsConflict(
        { field: 'title', meta: { agent: 'one' } },
        { field: 'title', meta: { agent: 'two' } },
      ),
    ).toBe(true);
  });
});

/**
 * The rule is only as good as the path that reaches it.
 *
 * `fields` was added to the schema and to the rule, and neither the request
 * body nor the server's claim construction carried it — so the rule compared
 * sets that never arrived and the fix changed nothing observable. These cases
 * run a claim body through the same projection the routes use, which is what
 * makes them a test of the path rather than of the predicate a second time.
 */
describe('a field set survives the trip from request body to the rule', () => {
  const narrowingFrom = (fields: readonly string[]) =>
    subTarget(claimRequestSchema.parse({ target: { fields } }).target);

  it('the request body accepts a set and the projection keeps it', () => {
    expect(narrowingFrom(['b_1', 'b_2']).fields).toEqual(['b_1', 'b_2']);
  });

  it('two claims sharing one part of the row conflict', () => {
    expect(
      targetsConflict(narrowingFrom(['b_1', 'b_2']), narrowingFrom(['b_2', 'b_3'])),
    ).toBe(true);
  });

  it('two claims on disjoint parts of the row do not', () => {
    expect(
      targetsConflict(narrowingFrom(['b_1', 'b_2']), narrowingFrom(['b_4'])),
    ).toBe(false);
  });
});
