/**
 * Identifier translation in `ddl.ts`: `snakeToCamel` and the schema slug. Both
 * run on names that arrive from outside, so each keeps its old output and
 * stays linear on a long `_` run that the earlier regexes retried from every
 * underscore.
 */

import { appSchemaName, snakeToCamel } from '../ddl.js';

describe('snakeToCamel', () => {
  it('round-trips camelToSnake output and keeps underscores with nothing to capitalize', () => {
    expect(snakeToCamel('operator_id')).toBe('operatorId');
    expect(snakeToCamel('a__b')).toBe('aB');
    expect(snakeToCamel('_private')).toBe('Private');
    expect(snakeToCamel('trailing__')).toBe('trailing__');
    expect(snakeToCamel('upper_B')).toBe('upper_B');
  });

  it('stays linear on a long underscore run', () => {
    const started = performance.now();
    expect(snakeToCamel(`a${'_'.repeat(100_000)}`)).toHaveLength(100_001);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe('appSchemaName', () => {
  it('slugs to [a-z0-9_] with no edge underscores', () => {
    expect(appSchemaName('__Org-ID 42__')).toBe('app_org_id_42');
    expect(appSchemaName('!!!')).toBe('app_x');
  });

  it('stays linear on a long underscore run', () => {
    const started = performance.now();
    expect(appSchemaName(`a${'_'.repeat(100_000)}!`)).toBe('app_a');
    expect(performance.now() - started).toBeLessThan(250);
  });
});
