/**
 * Where-filter extension: tuple-form clauses with operator-tagged values.
 *
 * Exercises `normalizeWhere` (input → canonical clauses) and `matchesClauses`
 * (local pool/IDB predicate). End-to-end network round-trip is covered by
 * the higher-level hydration tests; this file pins the unit semantics so a
 * regression in operator handling fails loudly instead of silently
 * returning wrong rows.
 */

import { matchesClauses, normalizeWhere } from '../OnDemandLoader.js';

describe('normalizeWhere', () => {
  it('passes tuple form through unchanged', () => {
    const input = [['name', 'ILIKE', '%Goldman%']] as const;
    expect(normalizeWhere(input)).toEqual(input);
  });

  it('converts object form to equality clauses', () => {
    const result = normalizeWhere({ orgId: 'o1', scope: 'org' });
    expect(result).toEqual([
      ['orgId', 'o1'],
      ['scope', 'org'],
    ]);
  });

  it('converts array values to IN clauses', () => {
    const result = normalizeWhere({ id: ['a', 'b', 'c'] });
    expect(result).toEqual([['id', 'IN', ['a', 'b', 'c']]]);
  });

  it('returns empty array for null/undefined/non-object inputs', () => {
    expect(normalizeWhere(undefined)).toEqual([]);
    expect(normalizeWhere(null)).toEqual([]);
    expect(normalizeWhere(42)).toEqual([]);
  });

  it('mixed: object with both scalar and array values', () => {
    const result = normalizeWhere({ orgId: 'o1', id: ['a', 'b'] });
    expect(result).toEqual([
      ['orgId', 'o1'],
      ['id', 'IN', ['a', 'b']],
    ]);
  });
});

describe('matchesClauses — equality and IN', () => {
  it('matches single equality clause', () => {
    expect(matchesClauses({ name: 'foo' }, [['name', 'foo']])).toBe(true);
    expect(matchesClauses({ name: 'bar' }, [['name', 'foo']])).toBe(false);
  });

  it('matches explicit = operator', () => {
    expect(matchesClauses({ name: 'foo' }, [['name', '=', 'foo']])).toBe(true);
  });

  it('matches != operator', () => {
    expect(matchesClauses({ name: 'foo' }, [['name', '!=', 'bar']])).toBe(true);
    expect(matchesClauses({ name: 'foo' }, [['name', '!=', 'foo']])).toBe(false);
  });

  it('matches IN over an array', () => {
    expect(matchesClauses({ id: 'b' }, [['id', 'IN', ['a', 'b', 'c']]])).toBe(true);
    expect(matchesClauses({ id: 'z' }, [['id', 'IN', ['a', 'b', 'c']]])).toBe(false);
  });

  it('matches NOT IN', () => {
    expect(matchesClauses({ id: 'z' }, [['id', 'NOT IN', ['a', 'b']]])).toBe(true);
    expect(matchesClauses({ id: 'a' }, [['id', 'NOT IN', ['a', 'b']]])).toBe(false);
  });

  it('ANDs multiple clauses', () => {
    const entity = { orgId: 'o1', scope: 'org', path: 'MEMORY.md' };
    expect(
      matchesClauses(entity, [
        ['orgId', 'o1'],
        ['scope', 'org'],
      ]),
    ).toBe(true);
    expect(
      matchesClauses(entity, [
        ['orgId', 'o1'],
        ['scope', 'user'],
      ]),
    ).toBe(false);
  });
});

describe('matchesClauses — comparisons', () => {
  it('matches numeric < / <= / > / >=', () => {
    expect(matchesClauses({ n: 5 }, [['n', '<', 10]])).toBe(true);
    expect(matchesClauses({ n: 5 }, [['n', '<', 5]])).toBe(false);
    expect(matchesClauses({ n: 5 }, [['n', '<=', 5]])).toBe(true);
    expect(matchesClauses({ n: 5 }, [['n', '>', 3]])).toBe(true);
    expect(matchesClauses({ n: 5 }, [['n', '>=', 5]])).toBe(true);
  });

  it('matches string ordering', () => {
    expect(matchesClauses({ s: 'b' }, [['s', '<', 'c']])).toBe(true);
    expect(matchesClauses({ s: 'b' }, [['s', '>', 'a']])).toBe(true);
  });

  it('mixed types or null on either side yield false', () => {
    expect(matchesClauses({ n: 5 }, [['n', '<', 'abc']])).toBe(false);
    expect(matchesClauses({ n: null }, [['n', '<', 5]])).toBe(false);
    expect(matchesClauses({}, [['n', '<', 5]])).toBe(false);
  });
});

describe('matchesClauses — LIKE / ILIKE', () => {
  it('matches LIKE with % wildcard (case-sensitive)', () => {
    expect(matchesClauses({ name: 'Goldman Sachs' }, [['name', 'LIKE', '%Goldman%']])).toBe(true);
    expect(matchesClauses({ name: 'goldman sachs' }, [['name', 'LIKE', '%Goldman%']])).toBe(false);
  });

  it('matches ILIKE with % wildcard (case-insensitive)', () => {
    expect(matchesClauses({ name: 'Goldman Sachs' }, [['name', 'ILIKE', '%goldman%']])).toBe(true);
    expect(matchesClauses({ name: 'goldman sachs' }, [['name', 'ILIKE', '%GOLDMAN%']])).toBe(true);
    expect(matchesClauses({ name: 'Apple Inc' }, [['name', 'ILIKE', '%goldman%']])).toBe(false);
  });

  it('matches _ as single-char wildcard', () => {
    expect(matchesClauses({ code: 'A1' }, [['code', 'LIKE', 'A_']])).toBe(true);
    expect(matchesClauses({ code: 'A12' }, [['code', 'LIKE', 'A_']])).toBe(false);
  });

  it('respects prefix and suffix patterns', () => {
    expect(matchesClauses({ path: 'companies/tractian.md' }, [['path', 'LIKE', 'companies/%']])).toBe(true);
    expect(matchesClauses({ path: 'deals/x.md' }, [['path', 'LIKE', 'companies/%']])).toBe(false);
    expect(matchesClauses({ path: 'a.md' }, [['path', 'LIKE', '%.md']])).toBe(true);
  });

  it('NOT LIKE and NOT ILIKE invert the match', () => {
    expect(matchesClauses({ name: 'Apple' }, [['name', 'NOT LIKE', '%Goldman%']])).toBe(true);
    expect(matchesClauses({ name: 'Apple' }, [['name', 'NOT ILIKE', '%apple%']])).toBe(false);
  });

  it('escapes regex metacharacters in the pattern', () => {
    // `.` is a regex special char but a literal in LIKE.
    expect(matchesClauses({ path: 'foo.txt' }, [['path', 'LIKE', 'foo.txt']])).toBe(true);
    expect(matchesClauses({ path: 'fooXtxt' }, [['path', 'LIKE', 'foo.txt']])).toBe(false);
  });

  it('non-string values never match LIKE/ILIKE', () => {
    expect(matchesClauses({ n: 5 }, [['n', 'LIKE', '5']])).toBe(false);
    expect(matchesClauses({ n: null }, [['n', 'ILIKE', '%foo%']])).toBe(false);
  });
});

describe('matchesClauses — IS / IS NOT', () => {
  it('IS null matches null', () => {
    expect(matchesClauses({ x: null }, [['x', 'IS', null]])).toBe(true);
    expect(matchesClauses({ x: 'foo' }, [['x', 'IS', null]])).toBe(false);
  });

  it('IS NOT null inverts', () => {
    expect(matchesClauses({ x: 'foo' }, [['x', 'IS NOT', null]])).toBe(true);
    expect(matchesClauses({ x: null }, [['x', 'IS NOT', null]])).toBe(false);
  });
});

describe('matchesClauses — empty clauses', () => {
  it('matches every entity when no clauses given', () => {
    expect(matchesClauses({ anything: true }, [])).toBe(true);
    expect(matchesClauses({}, [])).toBe(true);
  });
});
