import { parseDevArgs } from '../dev';
import { parseCheckArgs } from '../check';

describe('parseDevArgs', () => {
  it('defaults to ONE-SHOT (watch is opt-in — `push` is the honest default)', () => {
    const a = parseDevArgs([]);
    expect(a.schemaPath).toBe('ablo/schema.ts');
    expect(a.exportName).toBe('schema');
    expect(a.watch).toBe(false);
  });
  it('--watch opts into the re-push loop; flags parse', () => {
    const a = parseDevArgs(['--watch', '--schema', 's.ts', '--export', 'sch', '--url', 'http://x']);
    expect(a.watch).toBe(true);
    expect(a.schemaPath).toBe('s.ts');
    expect(a.exportName).toBe('sch');
    expect(a.url).toBe('http://x');
  });
  it('throws on unknown flag', () => {
    expect(() => parseDevArgs(['--bogus'])).toThrow(/unknown flag/);
  });
});

describe('parseCheckArgs', () => {
  it('applies defaults', () => {
    expect(parseCheckArgs([])).toEqual({
      schemaPath: 'ablo/schema.ts',
      exportName: 'schema',
      appSchema: 'public',
    });
  });
  it('parses flags', () => {
    expect(parseCheckArgs(['--schema', 's.ts', '--export', 'x', '--app-schema', 'app_1'])).toEqual({
      schemaPath: 's.ts',
      exportName: 'x',
      appSchema: 'app_1',
    });
  });
  it('throws on unknown flag', () => {
    expect(() => parseCheckArgs(['--bogus'])).toThrow(/unknown flag/);
  });
});
