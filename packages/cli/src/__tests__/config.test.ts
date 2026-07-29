import { mkdtempSync, rmSync, writeFileSync, statSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readConfig,
  writeConfig,
  setKey,
  setMode,
  getMode,
  getKeyEntry,
  modeFromKey,
  describeResolvedKey,
  normalizeMode,
  clearCredential,
  resolveMutationApiKey,
  resolveManagementKey,
  resolveOrgManagementKey,
  resolveOrgKey,
  resolveKey,
  resolveRuntimeApiKey,
  setProfileKeys,
  setActiveProject,
  guardActiveProjectKey,
} from '../config';

describe('config (CLI credential store — AWS-style config/credentials split)', () => {
  const OLD_ENV = process.env;
  let dir: string;
  let oldCwd: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ablo-cfg-'));
    process.env = { ...OLD_ENV, ABLO_CONFIG_DIR: dir };
    delete process.env.ABLO_API_KEY;
    delete process.env.ABLO_MANAGEMENT_KEY;
    // The runtime-key chain reads ./.env.local and ./.env — pin cwd to the
    // fresh temp dir so a real project's env files can never leak into tests.
    oldCwd = process.cwd();
    process.chdir(dir);
  });
  afterEach(() => {
    process.chdir(oldCwd);
    process.env = OLD_ENV;
    rmSync(dir, { recursive: true, force: true });
  });

  describe('modeFromKey', () => {
    it('maps prefixes to environments', () => {
      expect(modeFromKey('sk_test_abc')).toBe('sandbox');
      expect(modeFromKey('sk_live_abc')).toBe('production');
      expect(modeFromKey('rk_test_abc')).toBe('sandbox');
      expect(modeFromKey('rk_live_abc')).toBe('production');
    });
    it('returns undefined for non-Ablo keys', () => {
      expect(modeFromKey('nope')).toBeUndefined();
      expect(modeFromKey('pk_test_x')).toBeUndefined();
    });
  });

  describe('normalizeMode', () => {
    it('accepts canonical names only', () => {
      expect(normalizeMode('sandbox')).toBe('sandbox');
      expect(normalizeMode('production')).toBe('production');
      expect(normalizeMode('test')).toBeUndefined();
      expect(normalizeMode('live')).toBeUndefined();
      expect(normalizeMode('prod')).toBeUndefined();
    });
  });

  describe('describeResolvedKey', () => {
    it('flags an env key whose prefix disagrees with the active CLI mode', () => {
      const diagnostic = describeResolvedKey('sandbox', 'sk_live_env', {
        apiKey: 'sk_test_stored',
      });

      expect(diagnostic).toMatchObject({
        keyPrefix: 'sk_live_env',
        keySource: 'env',
        keyMode: 'production',
        storedKeyPrefix: 'sk_test_stor',
        keyMatchesActiveMode: false,
        keyMatchesStoredActiveKey: false,
        keyMismatch: { code: 'key_mode_mismatch' },
      });
      expect(diagnostic.keyMismatch?.message).toContain('ABLO_API_KEY is a production key');
      expect(diagnostic.keyMismatch?.message).toContain('CLI mode is sandbox');
    });

    it('flags an env key that overrides a different stored key in the same mode', () => {
      const diagnostic = describeResolvedKey('sandbox', 'sk_test_env', {
        apiKey: 'sk_test_stored',
      });

      expect(diagnostic).toMatchObject({
        keyPrefix: 'sk_test_env',
        keySource: 'env',
        keyMode: 'sandbox',
        storedKeyPrefix: 'sk_test_stor',
        keyMatchesActiveMode: true,
        keyMatchesStoredActiveKey: false,
        keyMismatch: { code: 'env_key_overrides_stored' },
      });
      expect(diagnostic.keyMismatch?.message).toContain('overrides the stored sandbox key');
    });

    it('reports a matching stored active key without a mismatch', () => {
      expect(
        describeResolvedKey('production', undefined, { apiKey: 'sk_live_stored' }),
      ).toEqual({
        keyPrefix: 'sk_live_stor',
        keySource: 'stored',
        keyMode: 'production',
        storedKeyPrefix: 'sk_live_stor',
        keyMatchesActiveMode: true,
        keyMatchesStoredActiveKey: null,
        keyMismatch: null,
      });
    });
  });

  it('round-trips config and keeps secrets OUT of config.json', () => {
    writeConfig({ mode: 'sandbox', profiles: { default: { sandbox: { apiKey: 'sk_test_a' } } } });
    expect(readConfig()).toEqual({
      mode: 'sandbox',
      profiles: { default: { sandbox: { apiKey: 'sk_test_a' } } },
    });

    // The non-secret file holds only the mode — no key anywhere in it.
    const cfgRaw = readFileSync(join(dir, 'config.json'), 'utf8');
    expect(cfgRaw).not.toContain('sk_test_a');
    expect(JSON.parse(cfgRaw)).toEqual({ mode: 'sandbox' });

    // The secrets file holds the key (under its profile), owner-only perms.
    const credRaw = readFileSync(join(dir, 'credentials.json'), 'utf8');
    expect(credRaw).toContain('sk_test_a');
    expect(JSON.parse(credRaw)).toEqual({
      profiles: { default: { sandbox: { apiKey: 'sk_test_a' } } },
    });
    expect(statSync(join(dir, 'credentials.json')).mode & 0o777).toBe(0o600);
  });

  it('setKey writes into the active profile and setMode flips active', () => {
    setKey('sandbox', { apiKey: 'sk_test_a' });
    setKey('production', { apiKey: 'sk_live_b' });
    setMode('production');
    expect(readConfig()).toEqual({
      mode: 'production',
      profiles: { default: { sandbox: { apiKey: 'sk_test_a' }, production: { apiKey: 'sk_live_b' } } },
    });
    expect(getMode()).toBe('production');
    expect(getKeyEntry('sandbox')?.apiKey).toBe('sk_test_a');
  });

  describe('per-project profiles', () => {
    it('keeps each project’s keys separate and resolves the ACTIVE one', () => {
      // Default project keys.
      setProfileKeys(
        'default',
        { sandbox: { apiKey: 'sk_test_default' } },
        { mode: 'sandbox', activeProject: undefined },
      );
      // A named project's keys; this also makes it active.
      setProfileKeys(
        'war-room',
        { sandbox: { apiKey: 'sk_test_warroom' } },
        { mode: 'sandbox', activeProject: { id: 'p1', slug: 'war-room' } },
      );

      // Active = war-room → its key resolves, not the default project's.
      expect(resolveMutationApiKey()).toBe('sk_test_warroom');
      expect(getKeyEntry('sandbox')?.apiKey).toBe('sk_test_warroom');

      // Switching back to the org-default resolves the default profile's key —
      // neither key was re-scoped; both coexist.
      setActiveProject(undefined);
      expect(resolveMutationApiKey()).toBe('sk_test_default');

      const cfg = readConfig();
      expect(Object.keys(cfg?.profiles ?? {}).sort()).toEqual(['default', 'war-room']);
    });
  });

  describe('guardActiveProjectKey', () => {
    it('ok when the active project has a key', () => {
      setProfileKeys(
        'war-room',
        { sandbox: { apiKey: 'sk_test_w' } },
        { mode: 'sandbox', activeProject: { id: 'p1', slug: 'war-room' } },
      );
      expect(guardActiveProjectKey()).toEqual({ ok: true, activeProfile: 'war-room', available: ['war-room'] });
    });

    it('flags the mismatch: active project has no key but another profile does', () => {
      // Key minted for default, then switch to a project we never logged into.
      setProfileKeys('default', { sandbox: { apiKey: 'sk_test_d' } }, { mode: 'sandbox', activeProject: undefined });
      setActiveProject({ id: 'p9', slug: 'war-room' });
      expect(guardActiveProjectKey()).toEqual({ ok: false, activeProfile: 'war-room', available: ['default'] });
    });

    it('an explicit ABLO_API_KEY is never blocked (CI escape hatch)', () => {
      setActiveProject({ id: 'p9', slug: 'war-room' });
      process.env.ABLO_API_KEY = 'sk_test_env';
      expect(guardActiveProjectKey().ok).toBe(true);
    });

    it('a key in .env.local is an explicit key too — it decides the target, so the guard stands down', () => {
      // The guard once read `process.env` alone, so a key in a project env file
      // — which every other part of the CLI resolves, reports as overriding the
      // stored login, and pushes with — was invisible to it. It refused a push
      // the key would have routed correctly, and the only way through was to
      // select a project the push would not use.
      setProfileKeys('default', { sandbox: { apiKey: 'sk_test_d' } }, { mode: 'sandbox', activeProject: undefined });
      setActiveProject({ id: 'p9', slug: 'war-room' });
      expect(guardActiveProjectKey().ok).toBe(false);

      writeFileSync(join(dir, '.env.local'), 'ABLO_API_KEY=sk_test_filekey\n');
      try {
        expect(guardActiveProjectKey().ok).toBe(true);
      } finally {
        rmSync(join(dir, '.env.local'));
      }
    });
  });

  describe('migration from older layouts', () => {
    it('reads a combined config.json and splits secrets into the default profile', () => {
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({
          mode: 'sandbox',
          sandbox: { apiKey: 'sk_test_a' },
          production: { apiKey: 'sk_live_b' },
        }),
      );
      expect(readConfig()).toEqual({
        mode: 'sandbox',
        profiles: { default: { sandbox: { apiKey: 'sk_test_a' }, production: { apiKey: 'sk_live_b' } } },
      });
      // The read MIGRATED the file: keys are gone from config.json now.
      expect(readFileSync(join(dir, 'config.json'), 'utf8')).not.toContain('sk_test_a');
      expect(existsSync(join(dir, 'credentials.json'))).toBe(true);
    });

    it('reads the legacy flat shape as the default profile’s sandbox slot', () => {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ apiKey: 'sk_test_legacy' }));
      expect(readConfig()).toEqual({
        mode: 'sandbox',
        profiles: { default: { sandbox: { apiKey: 'sk_test_legacy' } } },
      });
    });

    it('folds a legacy top-level credentials pair into the ACTIVE project', () => {
      // config.json names an active project; credentials.json is the old
      // pre-profiles `{ sandbox, production }` pair. The keys belong to the
      // active project, so they migrate under its slug, not `default`.
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({ mode: 'sandbox', activeProject: { id: 'p1', slug: 'war-room' } }),
      );
      writeFileSync(
        join(dir, 'credentials.json'),
        JSON.stringify({ sandbox: { apiKey: 'sk_test_w' } }),
      );
      expect(readConfig()).toEqual({
        mode: 'sandbox',
        activeProject: { id: 'p1', slug: 'war-room' },
        profiles: { 'war-room': { sandbox: { apiKey: 'sk_test_w' } } },
      });
      // Rewritten into the profile map.
      expect(JSON.parse(readFileSync(join(dir, 'credentials.json'), 'utf8'))).toEqual({
        profiles: { 'war-room': { sandbox: { apiKey: 'sk_test_w' } } },
      });
    });
  });

  describe('resolveMutationApiKey', () => {
    it('env var always wins', () => {
      setKey('sandbox', { apiKey: 'sk_test_stored' });
      process.env.ABLO_API_KEY = 'sk_test_env';
      expect(resolveMutationApiKey()).toBe('sk_test_env');
    });
    it('returns the active environment key, or the override', () => {
      writeConfig({
        mode: 'sandbox',
        profiles: { default: { sandbox: { apiKey: 'sk_test_a' }, production: { apiKey: 'sk_live_b' } } },
      });
      expect(resolveMutationApiKey()).toBe('sk_test_a');
      expect(resolveMutationApiKey('production')).toBe('sk_live_b');
    });
    it('treats an expired key as absent', () => {
      const past = new Date(Date.now() - 1000).toISOString();
      setKey('sandbox', { apiKey: 'sk_test_old', expiresAt: past });
      expect(resolveMutationApiKey()).toBeUndefined();
    });
    it('honors a future expiry', () => {
      const future = new Date(Date.now() + 60_000).toISOString();
      setKey('sandbox', { apiKey: 'sk_test_fresh', expiresAt: future });
      expect(resolveMutationApiKey()).toBe('sk_test_fresh');
    });
  });

  describe('resolveKey (the one resolver — three presets are one-liners over it)', () => {
    it('purpose:data reads ONLY the active profile (a keyless active project resolves nothing)', () => {
      setProfileKeys('default', { sandbox: { apiKey: 'sk_test_default' } }, { mode: 'sandbox', activeProject: undefined });
      setActiveProject({ id: 'p9', slug: 'mail' });
      expect(resolveKey({ purpose: 'data' })).toEqual({ key: undefined, source: null });
    });

    it('purpose:org-read falls back across profiles for the same state', () => {
      setProfileKeys('default', { sandbox: { apiKey: 'sk_test_default' } }, { mode: 'sandbox', activeProject: undefined });
      setActiveProject({ id: 'p9', slug: 'mail' });
      expect(resolveKey({ purpose: 'org-read' })).toEqual({ key: 'sk_test_default', source: 'stored' });
    });

    it('scanEnvFiles pulls an explicit key from .env.local and names its source', () => {
      setProfileKeys('default', { sandbox: { apiKey: 'sk_test_stored' } }, { mode: 'sandbox', activeProject: undefined });
      writeFileSync(join(dir, '.env.local'), 'ABLO_API_KEY=sk_live_filekey\n');
      expect(resolveKey({ purpose: 'data', scanEnvFiles: true })).toEqual({
        key: 'sk_live_filekey',
        source: '.env.local',
      });
      // Without scanning, the same call ignores the file and falls to the store.
      expect(resolveKey({ purpose: 'data' })).toEqual({ key: 'sk_test_stored', source: 'stored' });
    });

    it('honors the mode override for the stored slot', () => {
      writeConfig({
        mode: 'sandbox',
        profiles: { default: { sandbox: { apiKey: 'sk_test_a' }, production: { apiKey: 'sk_live_b' } } },
      });
      expect(resolveKey({ purpose: 'data', mode: 'production' }).key).toBe('sk_live_b');
    });

    it('the three presets are exactly their resolveKey policies', () => {
      setProfileKeys('default', { sandbox: { apiKey: 'sk_test_default' } }, { mode: 'sandbox', activeProject: undefined });
      setActiveProject({ id: 'p9', slug: 'mail' });
      expect(resolveMutationApiKey()).toBe(resolveKey({ purpose: 'data' }).key);
      expect(resolveOrgKey()).toBe(resolveKey({ purpose: 'org-read' }).key);
      expect(resolveRuntimeApiKey()).toEqual(resolveKey({ purpose: 'data', scanEnvFiles: true }));
    });
  });

  describe('resolveOrgKey (org-level reads — keeps `projects use` from locking you out)', () => {
    it('prefers the ACTIVE project’s key when it has one', () => {
      setProfileKeys('default', { sandbox: { apiKey: 'sk_test_default' } }, { mode: 'sandbox', activeProject: undefined });
      setProfileKeys(
        'war-room',
        { sandbox: { apiKey: 'sk_test_warroom' } },
        { mode: 'sandbox', activeProject: { id: 'p1', slug: 'war-room' } },
      );
      expect(resolveOrgKey()).toBe('sk_test_warroom');
    });

    it('falls back to the default profile when the active project has NO key — the lockout fix', () => {
      // Key minted only for `default`, then switched to a project we never logged
      // into. resolveMutationApiKey (strict, data path) returns nothing, which is what
      // used to strand `ablo projects use default`; resolveOrgKey still resolves.
      setProfileKeys('default', { sandbox: { apiKey: 'sk_test_default' } }, { mode: 'sandbox', activeProject: undefined });
      setActiveProject({ id: 'p9', slug: 'mail' });
      expect(resolveMutationApiKey()).toBeUndefined();
      expect(resolveOrgKey()).toBe('sk_test_default');
    });

    it('falls back to ANY profile with a key when neither active nor default has one', () => {
      setProfileKeys(
        'war-room',
        { sandbox: { apiKey: 'sk_test_warroom' } },
        { mode: 'sandbox', activeProject: { id: 'p1', slug: 'war-room' } },
      );
      setActiveProject({ id: 'p9', slug: 'mail' });
      expect(resolveOrgKey()).toBe('sk_test_warroom');
    });

    it('skips an expired key when falling back', () => {
      const past = new Date(Date.now() - 1000).toISOString();
      setProfileKeys(
        'default',
        { sandbox: { apiKey: 'sk_test_expired', expiresAt: past } },
        { mode: 'sandbox', activeProject: undefined },
      );
      setProfileKeys(
        'war-room',
        { sandbox: { apiKey: 'sk_test_live' } },
        { mode: 'sandbox', activeProject: { id: 'p1', slug: 'war-room' } },
      );
      // Active is 'mail' (no key), default's key is expired → skip to war-room's.
      setActiveProject({ id: 'p9', slug: 'mail' });
      expect(resolveOrgKey()).toBe('sk_test_live');
    });

    it('returns undefined when no profile has a key at all (genuinely logged out)', () => {
      setActiveProject({ id: 'p9', slug: 'mail' });
      expect(resolveOrgKey()).toBeUndefined();
    });

    it('an explicit ABLO_API_KEY always wins', () => {
      setProfileKeys('default', { sandbox: { apiKey: 'sk_test_default' } }, { mode: 'sandbox', activeProject: undefined });
      process.env.ABLO_API_KEY = 'sk_test_env';
      expect(resolveOrgKey()).toBe('sk_test_env');
    });
  });

  describe('resolveManagementKey', () => {
    it('prefers the dedicated override and never treats ABLO_API_KEY as management', () => {
      setProfileKeys(
        'default',
        { management: { apiKey: 'mk_stored' } },
        { mode: 'sandbox', activeProject: undefined },
      );
      process.env.ABLO_API_KEY = 'sk_test_runtime';
      expect(resolveManagementKey()).toBe('mk_stored');
      process.env.ABLO_MANAGEMENT_KEY = 'mk_ci';
      expect(resolveManagementKey()).toBe('mk_ci');
    });

    it('falls back across project profiles and skips expired management credentials', () => {
      setProfileKeys(
        'default',
        {
          management: {
            apiKey: 'mk_expired',
            expiresAt: new Date(Date.now() - 1_000).toISOString(),
          },
        },
        { mode: 'sandbox', activeProject: undefined },
      );
      setProfileKeys(
        'orders',
        { management: { apiKey: 'mk_orders' } },
        { mode: 'sandbox', activeProject: { id: 'p_orders', slug: 'orders' } },
      );
      setActiveProject({ id: 'p_mail', slug: 'mail' });
      expect(resolveManagementKey()).toBeUndefined();
      expect(resolveOrgManagementKey()).toBe('mk_orders');
    });
  });

  describe('resolveRuntimeApiKey (application/runtime lookup)', () => {
    it('resolves env → .env.local → .env → stored, naming the source at each step', () => {
      setKey('sandbox', { apiKey: 'sk_test_stored' });
      writeFileSync(join(dir, '.env'), 'ABLO_API_KEY=sk_test_dotenv\n');
      writeFileSync(join(dir, '.env.local'), 'ABLO_API_KEY=sk_test_envlocal\n');
      process.env.ABLO_API_KEY = 'sk_test_envvar';

      expect(resolveRuntimeApiKey()).toEqual({ key: 'sk_test_envvar', source: 'env' });

      delete process.env.ABLO_API_KEY;
      expect(resolveRuntimeApiKey()).toEqual({ key: 'sk_test_envlocal', source: '.env.local' });

      rmSync(join(dir, '.env.local'));
      expect(resolveRuntimeApiKey()).toEqual({ key: 'sk_test_dotenv', source: '.env' });

      rmSync(join(dir, '.env'));
      expect(resolveRuntimeApiKey()).toEqual({ key: 'sk_test_stored', source: 'stored' });

      clearCredential();
      expect(resolveRuntimeApiKey()).toEqual({ key: undefined, source: null });
    });

    it('honors the legacy-slot override for stored fallback compatibility', () => {
      writeConfig({
        mode: 'production',
        profiles: { default: { sandbox: { apiKey: 'sk_test_a' }, production: { apiKey: 'sk_live_b' } } },
      });
      expect(resolveRuntimeApiKey('sandbox')).toEqual({ key: 'sk_test_a', source: 'stored' });
      expect(resolveRuntimeApiKey()).toEqual({ key: 'sk_live_b', source: 'stored' });
    });

    it('an explicit cwd routes the file lookups (test seam)', () => {
      const other = mkdtempSync(join(tmpdir(), 'ablo-proj-'));
      try {
        writeFileSync(join(other, '.env.local'), 'ABLO_API_KEY=sk_test_other\n');
        expect(resolveRuntimeApiKey(undefined, other)).toEqual({
          key: 'sk_test_other',
          source: '.env.local',
        });
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    });
  });

  it('clearCredential removes both files', () => {
    setKey('sandbox', { apiKey: 'sk_test_a' });
    expect(clearCredential()).toBe(true);
    expect(readConfig()).toBeNull();
    expect(existsSync(join(dir, 'credentials.json'))).toBe(false);
    expect(clearCredential()).toBe(false);
  });
});
