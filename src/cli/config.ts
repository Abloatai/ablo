/**
 * Local credential store for the Ablo CLI — AWS-shaped: two files, and the
 * config file holds NO secrets.
 *
 *   config.json       non-secret settings: the active environment (mode) and
 *                     the active project. Safe to open, print, or let an agent
 *                     read.
 *   credentials.json  the keys, keyed by project then environment. 0600,
 *                     never printed.
 *
 * (Same split as `~/.aws/config` vs `~/.aws/credentials` — tooling that
 * inspects "the config" never sees a secret.)
 *
 * Per-project profiles (Stripe's `config.toml` model): keys live under a
 * project PROFILE (`default`, or a project slug), and within a profile under
 * `sandbox` / `production`. `ablo projects use <slug>` selects the active
 * profile; `ablo login --project <slug>` mints a pair into it. Selecting a
 * project never re-scopes an existing key — a key's project is fixed at mint,
 * so each project keeps its own credential and the active project always
 * resolves the matching one (or none, which is a precise error, never a
 * silent push to the wrong project).
 *
 * Key PREFIXES stay `sk_test_` / `sk_live_` / `rk_live_` (a wire contract the
 * server validates); only the human-facing vocabulary is sandbox/production.
 * `ablo mode sandbox|production` toggles which key within the active profile
 * `dev` / `push` use. `ABLO_API_KEY` in the environment always wins (CI).
 *
 * Path: `$ABLO_CONFIG_DIR` → `$XDG_CONFIG_HOME/ablo` → `~/.config/ablo`.
 * `credentials.json` is written `0600` (owner read/write only); the dir `0700`.
 *
 * v1 stores plaintext, like the AWS CLI. An OS-keychain backend
 * (`@napi-rs/keyring`) is a later hardening.
 */

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';

export type Mode = 'sandbox' | 'production';

/** The reserved profile name for the org-default project (no `activeProject`).
 *  Mirrors Stripe's `default` config profile. */
export const DEFAULT_PROFILE = 'default';

/** A stored key for one environment. `organizationId`/`expiresAt` come from
 *  the device-login flow; `--api-key` login sets only `apiKey`. */
export interface KeyEntry {
  apiKey: string;
  organizationId?: string;
  /** ISO-8601 absolute expiry, when the issuing flow sets one. */
  expiresAt?: string;
}

/** The key pair for one project profile. */
export interface ProfileKeys {
  sandbox?: KeyEntry;
  production?: KeyEntry;
}

/** The ACTIVE project (`ablo projects use`) — a non-secret targeting
 *  preference, stored in config.json like `mode`. Absent = the org-default
 *  project (the `default` profile). */
export interface ActiveProject {
  id: string;
  slug: string;
}

export interface StoredConfig {
  mode: Mode;
  /** Active project for project-scoped operations. Its slug names the active
   *  credential profile; absent = the `default` profile. */
  activeProject?: ActiveProject;
  /** Keys per project profile (`default` or a project slug). */
  profiles: Record<string, ProfileKeys>;
}

export function configDir(): string {
  if (process.env.ABLO_CONFIG_DIR) return process.env.ABLO_CONFIG_DIR;
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, 'ablo') : join(homedir(), '.config', 'ablo');
}

/** The non-secret settings file. */
export function configPath(): string {
  return join(configDir(), 'config.json');
}

/** The secrets file — keys only, 0600. */
export function credentialsPath(): string {
  return join(configDir(), 'credentials.json');
}

/** The active profile name for a config: the active project's slug, or
 *  `default`. */
export function activeProfileName(cfg: Pick<StoredConfig, 'activeProject'>): string {
  return cfg.activeProject?.slug ?? DEFAULT_PROFILE;
}

function asKeyEntry(value: unknown): KeyEntry | undefined {
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { apiKey?: unknown }).apiKey === 'string'
  ) {
    return value as KeyEntry;
  }
  return undefined;
}

function asProfileKeys(value: unknown): ProfileKeys | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const sandbox = asKeyEntry(v.sandbox);
  const production = asKeyEntry(v.production);
  if (!sandbox && !production) return undefined;
  return { ...(sandbox ? { sandbox } : {}), ...(production ? { production } : {}) };
}

/** Parse the `profiles` map, keeping only profiles that hold a real key. */
function asProfileMap(value: unknown): Record<string, ProfileKeys> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, ProfileKeys> = {};
  for (const [name, v] of Object.entries(value as Record<string, unknown>)) {
    const keys = asProfileKeys(v);
    if (keys) out[name] = keys;
  }
  return out;
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asActiveProject(value: unknown): ActiveProject | undefined {
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { slug?: unknown }).slug === 'string'
  ) {
    const v = value as { id: string; slug: string };
    return { id: v.id, slug: v.slug };
  }
  return undefined;
}

function normalizeStoredMode(value: unknown): Mode | undefined {
  if (value === 'sandbox' || value === 'production') return value;
  return undefined;
}

/** Pull a legacy flat/top-level key pair out of a stored object (pre-profiles
 *  layout: `{ sandbox, production }`, or the oldest `{ apiKey }`). */
function extractLegacyEntries(obj: Record<string, unknown>): ProfileKeys {
  const sandbox = asKeyEntry(obj.sandbox);
  const production = asKeyEntry(obj.production);
  if (sandbox || production) {
    return { ...(sandbox ? { sandbox } : {}), ...(production ? { production } : {}) };
  }
  const flat = asKeyEntry(obj); // legacy: { apiKey, ... } at the top level
  return flat ? { sandbox: flat } : {};
}

function hasKey(keys: ProfileKeys | undefined): boolean {
  return !!(keys?.sandbox || keys?.production);
}

/**
 * Read the stored config, or null if none / unreadable / malformed. Reads the
 * `profiles` layout and transparently MIGRATES older layouts: a single-file
 * config.json with keys inside it, and the pre-profiles `{ sandbox, production }`
 * pair (in either file) — both fold into the ACTIVE profile, then the split
 * files are rewritten.
 */
export function readConfig(): StoredConfig | null {
  const cfgObj = readJson(configPath());
  const credObj = readJson(credentialsPath());

  const mode = normalizeStoredMode(cfgObj?.mode) ?? normalizeStoredMode(credObj?.mode);
  const activeProject = asActiveProject(cfgObj?.activeProject);
  const activeName = activeProject?.slug ?? DEFAULT_PROFILE;

  const profiles: Record<string, ProfileKeys> = {
    ...asProfileMap(credObj?.profiles),
    ...asProfileMap(cfgObj?.profiles),
  };

  // Older layouts kept a single key pair at the top level (no per-project
  // profiles). Fold it into the active profile so an upgrade keeps working.
  const legacyCfg = cfgObj ? extractLegacyEntries(cfgObj) : {};
  const legacyCred = credObj ? extractLegacyEntries(credObj) : {};
  const legacy: ProfileKeys = { ...legacyCfg, ...legacyCred };
  const migratedLegacy = hasKey(legacy) && !hasKey(profiles[activeName]);
  if (migratedLegacy) profiles[activeName] = legacy;

  const anyKey = Object.values(profiles).some(hasKey);
  if (!mode && !anyKey) return null;

  const config: StoredConfig = {
    mode: mode ?? 'sandbox',
    ...(activeProject ? { activeProject } : {}),
    profiles,
  };

  // Rewrite the split files when we changed the on-disk shape: secrets found
  // inside config.json (old combined layout), or a legacy top-level pair we
  // just folded into the profile map.
  const secretsInConfig = hasKey(legacyCfg);
  if (secretsInConfig || migratedLegacy) writeConfig(config);
  return config;
}

/** Persist the whole config across the two files, with locked-down perms. */
export function writeConfig(cfg: StoredConfig): string {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    configPath(),
    `${JSON.stringify(
      { mode: cfg.mode, ...(cfg.activeProject ? { activeProject: cfg.activeProject } : {}) },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  // Only persist profiles that actually hold a key — keeps the file tidy and
  // never resurrects an emptied profile.
  const profiles: Record<string, ProfileKeys> = {};
  for (const [name, keys] of Object.entries(cfg.profiles)) {
    if (!hasKey(keys)) continue;
    profiles[name] = {
      ...(keys.sandbox ? { sandbox: keys.sandbox } : {}),
      ...(keys.production ? { production: keys.production } : {}),
    };
  }
  writeFileSync(credentialsPath(), `${JSON.stringify({ profiles }, null, 2)}\n`, { mode: 0o600 });
  return credentialsPath();
}

function emptyConfig(mode: Mode = 'sandbox'): StoredConfig {
  return { mode, profiles: {} };
}

/** Store a key for one environment in the ACTIVE profile, preserving the rest. */
export function setKey(mode: Mode, entry: KeyEntry): string {
  const cfg = readConfig() ?? emptyConfig(mode);
  const name = activeProfileName(cfg);
  cfg.profiles[name] = { ...cfg.profiles[name], [mode]: entry };
  return writeConfig(cfg);
}

/**
 * Store a freshly-minted key pair under a named project profile and (by
 * default) make that project active. Used by `ablo login [--project <slug>]`,
 * which mints a `sandbox` + `production` pair scoped to one project.
 */
export function setProfileKeys(
  profileName: string,
  keys: ProfileKeys,
  opts: { mode: Mode; activeProject: ActiveProject | undefined },
): string {
  const cfg = readConfig() ?? emptyConfig(opts.mode);
  cfg.mode = opts.mode;
  cfg.profiles[profileName] = {
    ...(keys.sandbox ? { sandbox: keys.sandbox } : {}),
    ...(keys.production ? { production: keys.production } : {}),
  };
  if (opts.activeProject) cfg.activeProject = opts.activeProject;
  else delete cfg.activeProject;
  return writeConfig(cfg);
}

/** Set the active environment. */
export function setMode(mode: Mode): string {
  const cfg = readConfig() ?? emptyConfig(mode);
  cfg.mode = mode;
  return writeConfig(cfg);
}

export function getMode(): Mode {
  return readConfig()?.mode ?? 'sandbox';
}

/** The active project, or undefined for the org-default. */
export function getActiveProject(): ActiveProject | undefined {
  return readConfig()?.activeProject;
}

/** Set (or with `undefined`, clear back to org-default) the active project. */
export function setActiveProject(project: ActiveProject | undefined): string {
  const cfg = readConfig() ?? emptyConfig('sandbox');
  if (project) cfg.activeProject = project;
  else delete cfg.activeProject;
  return writeConfig(cfg);
}

/** The stored key for `mode` in the ACTIVE profile. */
export function getKeyEntry(mode: Mode): KeyEntry | undefined {
  const cfg = readConfig();
  if (!cfg) return undefined;
  return cfg.profiles[activeProfileName(cfg)]?.[mode];
}

/** Infer the environment a key belongs to from its prefix. */
export function modeFromKey(key: string): Mode | undefined {
  if (/^(sk|rk)_test_/.test(key)) return 'sandbox';
  if (/^(sk|rk)_live_/.test(key)) return 'production';
  return undefined;
}

export interface KeyMismatchDiagnostic {
  code: 'key_mode_mismatch' | 'env_key_overrides_stored';
  message: string;
}

export interface EffectiveKeyDiagnostic {
  keyPrefix: string | null;
  keySource: 'env' | 'stored' | null;
  keyMode: Mode | null;
  storedKeyPrefix: string | null;
  keyMatchesActiveMode: boolean | null;
  keyMatchesStoredActiveKey: boolean | null;
  keyMismatch: KeyMismatchDiagnostic | null;
}

function prefix(key: string | undefined): string | null {
  return key ? key.slice(0, 12) : null;
}

export function describeEffectiveKey(
  activeMode: Mode,
  envKey: string | undefined,
  storedEntry: KeyEntry | undefined,
): EffectiveKeyDiagnostic {
  const effectiveKey = envKey ?? storedEntry?.apiKey;
  const keySource = envKey ? 'env' : storedEntry ? 'stored' : null;
  const keyMode = effectiveKey ? modeFromKey(effectiveKey) ?? null : null;
  const keyMatchesActiveMode = keyMode ? keyMode === activeMode : null;
  const keyMatchesStoredActiveKey =
    envKey && storedEntry?.apiKey ? envKey === storedEntry.apiKey : null;

  let keyMismatch: KeyMismatchDiagnostic | null = null;
  if (keyMode && keyMode !== activeMode) {
    const sourceLabel = envKey ? 'ABLO_API_KEY' : 'stored active key';
    keyMismatch = {
      code: 'key_mode_mismatch',
      message:
        `${sourceLabel} is a ${keyMode} key but the CLI mode is ${activeMode}. ` +
        `Requests use ${sourceLabel} (${prefix(effectiveKey)}...), not the active CLI mode.`,
    };
  } else if (envKey && storedEntry?.apiKey && envKey !== storedEntry.apiKey) {
    keyMismatch = {
      code: 'env_key_overrides_stored',
      message:
        `ABLO_API_KEY (${prefix(envKey)}...) overrides the stored ${activeMode} key ` +
        `(${prefix(storedEntry.apiKey)}...).`,
    };
  }

  return {
    keyPrefix: prefix(effectiveKey),
    keySource,
    keyMode,
    storedKeyPrefix: prefix(storedEntry?.apiKey),
    keyMatchesActiveMode,
    keyMatchesStoredActiveKey,
    keyMismatch,
  };
}

/**
 * Normalize a user-supplied mode word.
 */
export function normalizeMode(value: string | undefined): Mode | undefined {
  return normalizeStoredMode(value);
}

/** Remove the stored credential files. Returns true if anything was deleted. */
export function clearCredential(): boolean {
  let removed = false;
  for (const path of [configPath(), credentialsPath()]) {
    if (existsSync(path)) {
      rmSync(path);
      removed = true;
    }
  }
  return removed;
}

/**
 * The key the CLI should authenticate with: `ABLO_API_KEY` (CI / one-off
 * overrides always win), else the ACTIVE profile's key for the active
 * environment (or the `modeOverride`, e.g. `dev` which is always sandbox). A
 * key past its `expiresAt` is treated as absent so the caller prompts a fresh
 * `ablo login`.
 */
export function resolveApiKey(modeOverride?: Mode): string | undefined {
  if (process.env.ABLO_API_KEY) return process.env.ABLO_API_KEY;
  const cfg = readConfig();
  if (!cfg) return undefined;
  const entry = cfg.profiles[activeProfileName(cfg)]?.[modeOverride ?? cfg.mode];
  if (!entry) return undefined;
  if (entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now()) return undefined;
  return entry.apiKey;
}

/**
 * Whether the active project actually has a stored key — the guard that turns
 * "you switched projects but never minted a key for this one" into a precise
 * error instead of a silent push to the wrong (or no) project.
 *
 * `ok` is false ONLY when the active profile has no key yet other profiles do
 * (the genuine mismatch). A user who isn't logged in at all (`available`
 * empty) is left to the normal "run `ablo login`" path. An explicit
 * `ABLO_API_KEY` is the CI escape hatch — it acts in whatever project it was
 * minted for, which the prefix can't reveal, so it's never blocked.
 */
export interface ProjectKeyGuard {
  ok: boolean;
  /** The active project's profile name (a slug, or `default`). */
  activeProfile: string;
  /** Profiles that DO hold a key, for the remediation hint. */
  available: string[];
}

export function guardActiveProjectKey(): ProjectKeyGuard {
  if (process.env.ABLO_API_KEY) {
    return { ok: true, activeProfile: DEFAULT_PROFILE, available: [] };
  }
  const cfg = readConfig();
  const activeProfile = cfg ? activeProfileName(cfg) : DEFAULT_PROFILE;
  const profiles = cfg?.profiles ?? {};
  const available = Object.entries(profiles)
    .filter(([, keys]) => hasKey(keys))
    .map(([name]) => name);
  return { ok: hasKey(profiles[activeProfile]), activeProfile, available };
}

/** What `ablo push` would do right now: which environment it deploys to and
 *  the credential it would present. */
export interface PushPlan {
  /** `production` → the raw one-shot pusher; `sandbox` → the dev flow
   *  (role check, `.env.local` wiring, optional `--watch`). */
  flow: Mode;
  apiKey: string | undefined;
  /** Where the credential came from — `null` when none resolves. */
  source: 'env' | 'stored' | null;
}

/**
 * Resolve the credential + flow `ablo push` uses, in order: an explicit
 * `ABLO_API_KEY` (its prefix names the environment) → the ACTIVE mode's
 * stored credential (in the active project profile). The active mode is
 * honored even when no credential is stored for it, so a production-mode push
 * fails asking for a production key instead of silently running the sandbox
 * flow. (Pre-fix, only the env var was consulted: `ablo login` + `ablo mode
 * production` + `npx ablo push` still landed in the sandbox flow and demanded
 * `sk_test_`.)
 */
export function resolvePushPlan(): PushPlan {
  const envKey = process.env.ABLO_API_KEY;
  if (envKey) return { flow: modeFromKey(envKey) ?? getMode(), apiKey: envKey, source: 'env' };
  const mode = getMode();
  const apiKey = resolveApiKey(mode);
  return { flow: mode, apiKey, source: apiKey ? 'stored' : null };
}
