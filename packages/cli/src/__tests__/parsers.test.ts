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
    const a = parseDevArgs([
      '--watch', '--schema', 's.ts', '--export', 'sch', '--url', 'https://engine.example',
    ]);
    expect(a.watch).toBe(true);
    expect(a.schemaPath).toBe('s.ts');
    expect(a.exportName).toBe('sch');
    expect(a.url).toBe('https://engine.example');
  });
  it('refuses a --url that would send the key over plaintext', () => {
    // The resolver behind `--url` is the SDK's rule for where a credential may
    // travel, so the CLI stops at parse time rather than at the first request.
    expect(() => parseDevArgs(['--url', 'http://engine.example'])).toThrow(/must use https/);
    expect(parseDevArgs(['--url', 'http://localhost:8787/']).url).toBe('http://localhost:8787');
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
