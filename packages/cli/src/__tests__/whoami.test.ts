import { parseWhoamiArgs, selectWhoamiCredential } from '../whoami';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('parseWhoamiArgs — explicit, safe credential selection', () => {
  it('defaults to the active credential', () => {
    expect(parseWhoamiArgs([])).toEqual({ json: false });
  });

  it('accepts a named environment variable and JSON output', () => {
    expect(parseWhoamiArgs(['--key-env', 'ABLO_API_KEY_LIVE', '--json'])).toEqual({
      json: true,
      keyEnv: 'ABLO_API_KEY_LIVE',
    });
  });

  it('accepts a direct key for parity with token-taking CLIs', () => {
    expect(parseWhoamiArgs(['--key', 'sk_live_example'])).toEqual({
      json: false,
      key: 'sk_live_example',
    });
  });

  it('refuses ambiguous, missing, invalid, and unknown inputs', () => {
    expect(() => parseWhoamiArgs(['--key', 'one', '--key-env', 'TWO'])).toThrow(
      /Choose one credential source/,
    );
    expect(() => parseWhoamiArgs(['--key-env'])).toThrow(/needs an environment variable name/);
    expect(() => parseWhoamiArgs(['--key-env', 'NOT-A-NAME'])).toThrow(
      /not a valid environment variable name/,
    );
    expect(() => parseWhoamiArgs(['--wat'])).toThrow(/unknown whoami flag/);
  });
});

describe('selectWhoamiCredential — provenance without secret output', () => {
  const original = process.env.ABLO_CANDIDATE_KEY;

  afterEach(() => {
    if (original === undefined) delete process.env.ABLO_CANDIDATE_KEY;
    else process.env.ABLO_CANDIDATE_KEY = original;
  });

  it('reads a named variable and labels the source, not the value', () => {
    process.env.ABLO_CANDIDATE_KEY = 'sk_live_secret';
    expect(
      selectWhoamiCredential({ json: false, keyEnv: 'ABLO_CANDIDATE_KEY' }),
    ).toEqual({
      key: 'sk_live_secret',
      source: 'env:ABLO_CANDIDATE_KEY',
      targetSource: 'env',
    });
  });

  it('reads the explicitly named candidate from .env.local without sourcing the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ablo-whoami-'));
    try {
      delete process.env.ABLO_CANDIDATE_KEY;
      writeFileSync(
        join(dir, '.env.local'),
        'DATABASE_URL=postgres://host/db?sslmode=require&channel_binding=require\n' +
          'ABLO_CANDIDATE_KEY=sk_live_from_file\n',
      );
      expect(
        selectWhoamiCredential(
          { json: false, keyEnv: 'ABLO_CANDIDATE_KEY' },
          dir,
        ),
      ).toEqual({
        key: 'sk_live_from_file',
        source: '.env.local:ABLO_CANDIDATE_KEY',
        targetSource: 'env',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails clearly when the named variable is absent', () => {
    delete process.env.ABLO_CANDIDATE_KEY;
    expect(() =>
      selectWhoamiCredential({ json: false, keyEnv: 'ABLO_CANDIDATE_KEY' }),
    ).toThrow(/not set in the process environment/);
  });
});
