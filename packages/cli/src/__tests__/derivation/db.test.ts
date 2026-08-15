/**
 * `ablo pull` against a live database, run through the derivation conformance
 * battery.
 *
 * This source knows less than the ORM sources, and the suite list is where that
 * is stated. Each omission below is a capability this path cannot have — not a
 * gap to close later — so it is declared here in the open rather than skipped
 * inside a shared suite where nobody would see it.
 */

import { lowerColumnRows } from '../../pull';
import { adoptSuite, baseColumnsSuite, runConformance, type ConformanceSuite } from './conformance';
import { COLUMN_ROWS } from './fixtures/db';

/** What introspection does that no ORM source has to: invent field names, and
 *  report the types it could not recover. */
const introspectionSuite: ConformanceSuite = (ctx) => {
  describe('introspection', () => {
    it('derives a camelCase field when it maps back to the column', () => {
      const f = ctx.field('records', 'dueAt');
      expect(f.column).toBe('due_at');
      expect(f.kind).toBe('date');
    });

    it('keeps the raw column when camelCase would not recover it', () => {
      // `step_2` → `step2` → `step2` is a different column, so the field keeps
      // the column's own name rather than pointing at one that does not exist.
      expect(ctx.field('records', 'step_2').column).toBe('step_2');
    });

    it('reduces an enum to a string and says the type was not recovered', () => {
      const f = ctx.field('records', 'status');
      expect(f.kind).toBe('string');
      expect(f.enumValues).toBeUndefined();
      expect(f.note).toMatch(/USER-DEFINED/);
    });

    it('finds no relations, because a column does not carry one', () => {
      expect(ctx.ir().models.flatMap((m) => m.relations)).toEqual([]);
    });
  });
};

runConformance({
  source: 'pull (database)',
  lower: () => lowerColumnRows(COLUMN_ROWS),
  suites: [
    adoptSuite,
    baseColumnsSuite,
    introspectionSuite,
    // scalarsSuite — the ORM's field names were never stored, so `due_at` comes
    //   back as `dueAt` rather than the `deadline` the ORM sources declare.
    // namingSuite — same reason: there is no column override to recover.
    // enumsSuite — a pg enum arrives as `USER-DEFINED` with its members gone.
    // relationsSuite — a foreign key is a constraint, not something the column
    //   carries; see the introspection suite above, which asserts the absence.
    // emitSuite — asserts the enum and the relation neither of which exist here.
  ],
});
