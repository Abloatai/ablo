/**
 * `ablo status --json` — pins that the diagnostic reports the EFFECTIVE
 * credential through the ONE shared chain (env → .env.local → .env → stored),
 * i.e. exactly what `ablo push` would present. (The four-divergent-chains bug:
 * status used to skip the project env files push reads, so it could report the
 * stored sandbox key while push presented the production key in `.env.local`.)
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
  effectiveKey: { prefix: string | null; source: string | null; kind: string | null };
  push: { flow: string; keyPrefix: string | null; keySource: string | null };
  reachable: boolean;
}

describe('ablo status --json (effective-key provenance)', () => {
  const OLD_ENV = process.env;
  let dir: string;
  let oldCwd: string;
  let lines: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ablo-status-'));
    process.env = { ...OLD_ENV, ABLO_CONFIG_DIR: dir };
    delete process.env.ABLO_API_KEY;
    delete process.env.ABLO_API_URL;
    // The effective-key chain reads ./.env.local and ./.env — pin cwd so a
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

  it('reports the .env.local key as the effective credential — the same one push presents', async () => {
    writeConfig({
      mode: 'sandbox',
      profiles: { default: { sandbox: { apiKey: 'sk_test_stored' } } },
    });
    writeFileSync(join(dir, '.env.local'), 'ABLO_API_KEY=sk_live_filekey123\n');

    await status(['--json']);

    const out = JSON.parse(lines.join('\n')) as StatusJson;
    expect(out.effectiveKey).toEqual({
      prefix: 'sk_live_file',
      source: '.env.local',
      kind: 'secret',
    });
    // resolvePushPlan agrees: same key, same source, flow named by its prefix.
    expect(out.push).toEqual({
      flow: 'production',
      keyPrefix: 'sk_live_file',
      keySource: '.env.local',
    });
  });

  it('falls back to the stored login key with source "stored"', async () => {
    writeConfig({
      mode: 'sandbox',
      profiles: { default: { sandbox: { apiKey: 'sk_test_stored99' } } },
    });

    await status(['--json']);

    const out = JSON.parse(lines.join('\n')) as StatusJson;
    expect(out.effectiveKey).toEqual({
      prefix: 'sk_test_stor',
      source: 'stored',
      kind: 'secret',
    });
    expect(out.push.keySource).toBe('stored');
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
    expect(out.effectiveKey.kind).toBe('restricted');

    lines = [];
    await status();
    const printed = lines.join('\n');
    expect(printed).toContain('scoped');
    expect(printed).toContain('sk_live_');
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
