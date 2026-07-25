import { parsePushArgs } from '../push';

describe('parsePushArgs', () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.ABLO_API_URL;
    delete process.env.ABLO_API_KEY;
  });
  afterEach(() => {
    process.env = OLD_ENV;
  });

  it('applies defaults', () => {
    const args = parsePushArgs([]);
    expect(args.schemaPath).toBe('ablo/schema.ts');
    expect(args.exportName).toBe('schema');
    expect(args.url).toBe('https://api.abloatai.com');
    expect(args.force).toBe(false);
    expect(args.renames).toEqual([]);
    // Confirmation/guard flags default OFF — push is interactive + guarded by default.
    expect(args.yes).toBe(false);
    expect(args.dryRun).toBe(false);
  });

  it('parses confirmation + guard flags (incl. aliases)', () => {
    expect(parsePushArgs(['--yes']).yes).toBe(true);
    expect(parsePushArgs(['-y']).yes).toBe(true);
    // Retired: git state informs but never blocks, so there is nothing to
    // override — the flag is still ACCEPTED so old scripts don't break.
    expect(() => parsePushArgs(['--allow-dirty'])).not.toThrow();
    expect(parsePushArgs(['--dry-run']).dryRun).toBe(true);
    expect(parsePushArgs(['--plan']).dryRun).toBe(true);
  });

  it('reads url + key from env', () => {
    process.env.ABLO_API_URL = 'http://localhost:8787/';
    process.env.ABLO_API_KEY = 'sk_test_123';
    const args = parsePushArgs([]);
    // trailing slash stripped
    expect(args.url).toBe('http://localhost:8787');
    expect(args.apiKey).toBe('sk_test_123');
  });

  it('parses flags and repeated --rename', () => {
    const args = parsePushArgs([
      '--schema', 'db/s.ts',
      '--export', 'mySchema',
      '--url', 'https://x.dev',
      '--force',
      '--rename', 'old:new',
      '--rename', 'a:b',
    ]);
    expect(args.schemaPath).toBe('db/s.ts');
    expect(args.exportName).toBe('mySchema');
    expect(args.url).toBe('https://x.dev');
    expect(args.force).toBe(true);
    expect(args.renames).toEqual([
      { from: 'old', to: 'new' },
      { from: 'a', to: 'b' },
    ]);
  });

  it('rejects a malformed --rename', () => {
    expect(() => parsePushArgs(['--rename', 'noColon'])).toThrow(/old:new/);
  });

  it('rejects unknown flags', () => {
    expect(() => parsePushArgs(['--nope'])).toThrow(/unknown flag/);
  });
});
