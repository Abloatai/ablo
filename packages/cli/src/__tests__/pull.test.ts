/**
 * `ablo pull` — the Postgres type map, and argument parsing.
 *
 * What the lowering produces is asserted by the shared conformance battery in
 * `derivation/`, alongside the ORM sources, so the database path cannot drift
 * away from what `pull prisma` and `pull drizzle` produce for the same tables.
 * The field-name round-trip rule moved with it: it is one policy in
 * `schemaSource.ts` now, not a rule this command owns.
 */

import { parsePullArgs, pgTypeToKind } from '../pull';
import { fieldNameForColumn } from '../schemaSource';

describe('pgTypeToKind', () => {
  it('maps the Postgres types the engine emits', () => {
    expect(pgTypeToKind('text').kind).toBe('string');
    expect(pgTypeToKind('character varying').kind).toBe('string');
    expect(pgTypeToKind('uuid').kind).toBe('string');
    expect(pgTypeToKind('integer').kind).toBe('number');
    expect(pgTypeToKind('double precision').kind).toBe('number');
    expect(pgTypeToKind('boolean').kind).toBe('boolean');
    expect(pgTypeToKind('timestamp with time zone').kind).toBe('date');
    expect(pgTypeToKind('date').kind).toBe('date');
    expect(pgTypeToKind('jsonb').kind).toBe('json');
    expect(pgTypeToKind('ARRAY').kind).toBe('json');
  });

  it('flags an unrepresentable type for review rather than guessing quietly', () => {
    const r = pgTypeToKind('USER-DEFINED');
    expect(r.kind).toBe('string');
    expect(r.note).toMatch(/USER-DEFINED/);
  });
});

describe('fieldNameForColumn', () => {
  it('prefers camelCase when it maps back to the same column', () => {
    expect(fieldNameForColumn('actor_kind')).toBe('actorKind');
    expect(fieldNameForColumn('delegation_chain_root_user_id')).toBe('delegationChainRootUserId');
    expect(fieldNameForColumn('title')).toBe('title');
  });

  it('keeps the raw column when camelCase would not recover it', () => {
    // `step_2` → `step2` → `step2`, which is a different column, so the field
    // would point at something that does not exist.
    expect(fieldNameForColumn('step_2')).toBe('step_2');
  });
});

describe('parsePullArgs', () => {
  it('applies defaults', () => {
    expect(parsePullArgs([])).toEqual({
      out: 'ablo/schema.ts',
      appSchema: 'public',
      importPath: '@abloatai/ablo/schema',
      force: false,
    });
  });

  it('parses flags', () => {
    expect(parsePullArgs(['--out', 'x.ts', '--app-schema', 'app_1', '--import', '@x/y', '--force'])).toEqual({
      out: 'x.ts',
      appSchema: 'app_1',
      importPath: '@x/y',
      force: true,
    });
  });

  it('throws on an unknown flag', () => {
    expect(() => parsePullArgs(['--bogus'])).toThrow(/unknown flag/);
  });
});
