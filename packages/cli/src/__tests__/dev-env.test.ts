/**
 * `ablo dev` env wiring — the zero-copy-paste step of onboarding. `dev`
 * resolves the branch-bound key and writes it into `.env.local` itself, so
 * the SDK (which reads ABLO_API_KEY) finds it with no manual export. These
 * tests pin the idempotent file behaviors and the gitignore warning.
 */

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { wireEnvLocal, classifyKey, parseDevArgs, registerLocalSource } from '../dev';

const KEY = 'sk_abc123';

describe('local connector flags', () => {
  it('opts into the generated Data Source without changing the default dev path', () => {
    expect(parseDevArgs(['--watch']).local).toBe(false);
    expect(parseDevArgs(['--watch', '--local', '--source', 'src/ablo/source.ts'])).toMatchObject({
      local: true,
      sourcePath: 'src/ablo/source.ts',
      watch: true,
    });
  });

  it('registers a connector-only localhost descriptor, never a database URL', async () => {
    const originalFetch = globalThis.fetch;
    // Declare fetch's parameters on the mock. Without them jest infers a
    // zero-arity call signature, `mock.calls[0]` is the empty tuple, and
    // destructuring the arguments this test exists to inspect cannot typecheck.
    const fetchMock = jest.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('{}', { status: 201 })
    );
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      await registerLocalSource({ url: 'https://api.example', apiKey: KEY });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example/v1/datasources');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      endpoint: 'http://localhost/ablo-dev/reverse-channel',
      signingKey: KEY,
      reverseChannel: true,
    });
    expect(String(init?.body)).not.toContain('postgres://');
  });
});

describe('classifyKey (branch-bound credential contract)', () => {
  function reasonOf(apiKey: string | undefined): string {
    const result = classifyKey(apiKey);
    if (result.ok) throw new Error('expected a refusal');
    return result.reason;
  }

  it('accepts current and legacy secret keys', () => {
    expect(classifyKey('sk_abc')).toEqual({ ok: true });
    expect(classifyKey('sk_test_abc')).toEqual({ ok: true });
    expect(classifyKey('sk_live_abc')).toEqual({ ok: true });
  });

  it('keyless: names login and the branch workflow, with no mode bookkeeping', () => {
    const reason = reasonOf(undefined);
    expect(reason).toContain('ablo login');
    expect(reason).toContain('ABLO_API_KEY');
    expect(reason).toContain('development branch');
    expect(reason).not.toContain('Mode is currently');
  });

  it('restricted key asks for one secret-key class', () => {
    const reason = reasonOf('rk_live_abc');
    expect(reason).toContain('sk_');
    expect(reason).toContain('development branch');
    expect(reason).not.toContain('sk_test_');
    expect(reason).not.toContain('sk_live_');
  });

  it('non-secret key names the one expected prefix', () => {
    const reason = reasonOf('pk_test_abc');
    expect(reason).toContain('sk_');
    expect(reason).not.toContain('sk_test_');
    expect(reason).not.toContain('sk_live_');
  });
});

describe('wireEnvLocal', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ablo-dev-env-'));
    // Cover .env.local so the warning branch stays out of these cases.
    writeFileSync(join(dir, '.gitignore'), '.env.local\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates .env.local with the key when the file is missing', () => {
    const message = wireEnvLocal(KEY, dir);
    expect(message).toContain('Created');
    expect(readFileSync(join(dir, '.env.local'), 'utf8')).toBe(`ABLO_API_KEY=${KEY}\n`);
  });

  it('wires the immutable project pin beside a branch key', () => {
    const message = wireEnvLocal(KEY, dir, 'proj_mail', 'br_feature');
    expect(message).toContain('Created');
    expect(readFileSync(join(dir, '.env.local'), 'utf8')).toBe(
      `ABLO_API_KEY=${KEY}\nABLO_PROJECT_ID=proj_mail\nABLO_BRANCH_ID=br_feature\n`
    );
  });

  it('updates the branch pin when the active branch changes', () => {
    writeFileSync(
      join(dir, '.env.local'),
      `ABLO_API_KEY=${KEY}\nABLO_PROJECT_ID=proj_mail\nABLO_BRANCH_ID=br_old\nOTHER=1\n`
    );
    wireEnvLocal(KEY, dir, 'proj_mail', 'br_feature');
    expect(readFileSync(join(dir, '.env.local'), 'utf8')).toBe(
      `ABLO_API_KEY=${KEY}\nABLO_PROJECT_ID=proj_mail\nABLO_BRANCH_ID=br_feature\nOTHER=1\n`
    );
  });

  it('updates the project pin when the active project changes', () => {
    writeFileSync(
      join(dir, '.env.local'),
      `ABLO_API_KEY=${KEY}\nABLO_PROJECT_ID=proj_old\nOTHER=1\n`
    );
    wireEnvLocal(KEY, dir, 'proj_mail');
    expect(readFileSync(join(dir, '.env.local'), 'utf8')).toBe(
      `ABLO_API_KEY=${KEY}\nABLO_PROJECT_ID=proj_mail\nOTHER=1\n`
    );
  });

  it('appends the line when .env.local exists without it', () => {
    writeFileSync(join(dir, '.env.local'), 'DATABASE_URL=postgres://x\n');
    const message = wireEnvLocal(KEY, dir);
    expect(message).toContain('Added');
    expect(readFileSync(join(dir, '.env.local'), 'utf8')).toBe(
      `DATABASE_URL=postgres://x\nABLO_API_KEY=${KEY}\n`,
    );
  });

  it('is a no-op when the same key is already wired', () => {
    writeFileSync(join(dir, '.env.local'), `ABLO_API_KEY=${KEY}\n`);
    const message = wireEnvLocal(KEY, dir);
    expect(message).toContain('already');
    expect(readFileSync(join(dir, '.env.local'), 'utf8')).toBe(`ABLO_API_KEY=${KEY}\n`);
  });

  it('updates a differing key in place, preserving other lines', () => {
    writeFileSync(
      join(dir, '.env.local'),
      `DATABASE_URL=postgres://x\nABLO_API_KEY=sk_old\nOTHER=1\n`,
    );
    const message = wireEnvLocal(KEY, dir);
    expect(message).toContain('Updated');
    expect(readFileSync(join(dir, '.env.local'), 'utf8')).toBe(
      `DATABASE_URL=postgres://x\nABLO_API_KEY=${KEY}\nOTHER=1\n`,
    );
  });

  it('adds .env.local to .gitignore itself when not covered (a key in git history is forever)', () => {
    rmSync(join(dir, '.gitignore'));
    const message = wireEnvLocal(KEY, dir);
    expect(message).toContain('.gitignore');
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('.env.local');
  });

  it('appends to an existing .gitignore without clobbering it', () => {
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
    const message = wireEnvLocal(KEY, dir);
    expect(message).toContain('.gitignore');
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('node_modules\n.env.local\n');
  });

  it('leaves .gitignore alone when a pattern already covers .env.local', () => {
    // beforeEach wrote `.env.local\n` — the message should not mention gitignore.
    const message = wireEnvLocal(KEY, dir);
    expect(message).not.toContain('.gitignore');
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('.env.local\n');
  });
});
