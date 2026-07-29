/**
 * `ablo status --json` reports the runtime credential the application would
 * resolve (env → .env.local → .env → legacy stored fallback), including its
 * provenance.
 *
 * Network calls (ping / schema introspection) go through the jest-setup fetch
 * mock, which rejects — status degrades to `reachable: false` / `schema: null`,
 * which is exactly the offline shape we want for a hermetic test.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { status } from '../status';
import { writeConfig } from '../config';

interface StatusJson {
  mode: string;
  runtimeKey: { prefix: string | null; source: string | null; kind: string | null };
  reachable: boolean;
}

describe('ablo status --json (runtime-key provenance)', () => {
  const OLD_ENV = process.env;
  let dir: string;
  let oldCwd: string;
  let lines: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ablo-status-'));
    process.env = { ...OLD_ENV, ABLO_CONFIG_DIR: dir };
    delete process.env.ABLO_API_KEY;
    delete process.env.ABLO_API_URL;
    // The runtime-key chain reads ./.env.local and ./.env — pin cwd so a
    // real project's env files can never leak into the test.
    oldCwd = process.cwd();
    process.chdir(dir);
    lines = [];
    jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.chdir(oldCwd);
    process.env = OLD_ENV;
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports the .env.local key as the application runtime credential', async () => {
    writeConfig({
      mode: 'sandbox',
      profiles: { default: { sandbox: { apiKey: 'sk_test_stored' } } },
    });
    writeFileSync(join(dir, '.env.local'), 'ABLO_API_KEY=sk_live_filekey123\n');

    await status(['--json']);

    const out = JSON.parse(lines.join('\n')) as StatusJson;
    expect(out.runtimeKey).toEqual({
      prefix: 'sk_live_file',
      source: '.env.local',
      kind: 'secret',
    });
  });

  it('falls back to the stored login key with source "stored"', async () => {
    writeConfig({
      mode: 'sandbox',
      profiles: { default: { sandbox: { apiKey: 'sk_test_stored99' } } },
    });

    await status(['--json']);

    const out = JSON.parse(lines.join('\n')) as StatusJson;
    expect(out.runtimeKey).toEqual({
      prefix: 'sk_test_stor',
      source: 'stored',
      kind: 'secret',
    });
  });

  /**
   * The scoped production key `ablo login` stores used to be visible only as a
   * prefix, so the fact that it cannot push arrived as a 403 in the middle of a
   * deploy. Both surfaces carry it now: the human output says what the key does
   * and names the key that deploys, and `--json` reports the kind so a pipeline
   * can check before it pushes rather than after it fails.
   */
  it('names a scoped key and the secret key that deploys, rather than leaving it to a 403', async () => {
    writeConfig({
      mode: 'production',
      profiles: { default: { production: { apiKey: 'rk_live_scopedkey1' } } },
    });

    await status(['--json']);
    const out = JSON.parse(lines.join('\n')) as StatusJson;
    expect(out.runtimeKey.kind).toBe('restricted');

    lines = [];
    await status();
    const printed = lines.join('\n');
    expect(printed).toContain('scoped');
    expect(printed).toContain('sk_');
    expect(printed).not.toContain('sk_live_');
  });

  /** A secret key is unremarkable, and status stays quiet about it. */
  it('says nothing about a secret key, which deploys', async () => {
    writeConfig({
      mode: 'production',
      profiles: { default: { production: { apiKey: 'sk_live_secretkey1' } } },
    });

    await status();
    const printed = lines.join('\n');
    expect(printed).not.toContain('scoped');
    expect(printed).not.toContain('from the dashboard');
  });
});
