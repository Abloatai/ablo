/**
 * The Ablo CLI's local credential store, split across two files so that the
 * config file never holds a secret:
 *
 *   config.json       Non-secret settings: the active environment (mode) and the
 *                     active project. Safe to open, print, or let a tool read.
 *   credentials.json  The API keys, organized by project and then environment.
 *                     Written with `0600` permissions and never printed.
 *
 * This mirrors the `~/.aws/config` and `~/.aws/credentials` split, so anything
 * that inspects the config never encounters a secret.
 *
 * Keys are organized into per-project profiles. A profile is named `default`
 * (the organization-default project) or a project slug, and within it a key is
 * held under `sandbox` and `production`. `ablo projects use <slug>` selects the
 * active profile; `ablo login --project <slug>` mints a key pair into it.
 * Selecting a project never re-scopes an existing key — a key's project is fixed
 * when it is minted — so each project keeps its own credential and the active
 * project always resolves the matching one, or none, which surfaces as a precise
 * error rather than a silent push to the wrong project.
 *
 * Key prefixes stay `sk_test_`, `sk_live_`, and `rk_live_` — a wire contract the
 * server validates — while the human-facing vocabulary is sandbox and production.
 * `ablo mode sandbox|production` toggles which key within the active profile
 * `dev` and `push` use. An `ABLO_API_KEY` set in the environment always wins,
 * which is how a continuous-integration run supplies a key.
 *
 * The store's location resolves from `$ABLO_CONFIG_DIR`, then
 * `$XDG_CONFIG_HOME/ablo`, then `~/.config/ablo`. `credentials.json` is written
 * `0600` (owner read/write only) inside a `0700` directory. Keys are stored in
 * plaintext.
 */

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { readProjectApiKey, type ApiKeySource } from './dbRole';
import type { Environment } from '../environment.js';

// The same type as the engine's canonical `Environment`. The CLI keeps the name
// `Mode` for its user-facing surface (`ablo mode`, key profiles), but the two are
// one type and cannot drift apart.
export type Mode = Environment;

/** The reserved profile name for the organization-default project, used when no
 *  active project is set. */
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

/** The active project, set by `ablo projects use`. A non-secret targeting
 *  preference stored in config.json alongside `mode`. Absent means the
 *  organization-default project (the `default` profile). */
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
 * Reads the stored config, returning null when none exists or it is unreadable
 * or malformed. It reads the current profile layout and transparently upgrades
 * older on-disk layouts: a single combined config.json that held keys inline, and
 * the earlier `{ sandbox, production }` pair in either file, both fold into the
 * active profile, after which the two split files are rewritten.
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

/** Store a key for one environment in the active profile, preserving the rest. */
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

/** The stored key for `mode` in the active profile. */
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
 * The key the CLI authenticates with: `ABLO_API_KEY` always wins, so continuous
 * integration and one-off overrides take precedence; otherwise the active
 * profile's key for the active environment, or for `modeOverride` when given
 * (`dev`, for instance, is always sandbox). A key past its `expiresAt` is treated
 * as absent, so the caller prompts for a fresh `ablo login`.
 */
export function resolveApiKey(modeOverride?: Mode): string | undefined {
  // Strict data-path preset: the active project's key only, no env-file scan.
  return resolveKey({ purpose: 'data', mode: modeOverride }).key;
}

/**
 * Resolves a key for an *organization-level* CLI operation — listing, creating,
 * renaming, or switching the active project — where any valid key for the
 * organization returns the same answer, and which project the key is scoped to
 * doesn't change the result. Unlike {@link resolveApiKey}, which reads only the
 * active project's profile so a data-touching command can never silently act
 * through the wrong project, this prefers the active profile but falls back to
 * the `default` profile and then any profile that still holds an unexpired key.
 *
 * This is what lets `ablo projects use` switch *away* from a project you never
 * minted a key for: selecting a keyless project must not lock you out of the
 * one command that undoes the selection. Data commands keep the strict resolver,
 * so this permissive fallback never routes a write to an unintended project.
 */
export function resolveOrgKey(modeOverride?: Mode): string | undefined {
  return resolveKey({ purpose: 'org-read', mode: modeOverride }).key;
}

/**
 * Reports whether the active project has a stored key. This guard turns
 * "you switched projects but never minted a key for this one" into a precise
 * error instead of a silent push to the wrong project, or to none.
 *
 * `ok` is false only when the active profile has no key while other profiles do
 * — the genuine mismatch. A user who isn't logged in at all (with `available`
 * empty) is left to the normal "run `ablo login`" path. An explicit
 * `ABLO_API_KEY` is the escape hatch for continuous integration: it acts in
 * whatever project it was minted for, which its prefix can't reveal, so it is
 * never blocked.
 */
export interface ProjectKeyGuard {
  ok: boolean;
  /** The active project's profile name (a slug, or `default`). */
  activeProfile: string;
  /** Profiles that hold a key, used for the remediation hint. */
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

/** Where the effective CLI credential came from: the process environment, a
 *  project env file the application's framework would load, or the stored
 *  `ablo login` credential. */
export type EffectiveKeySource = ApiKeySource | 'stored';

/** The credential the CLI would present, plus its provenance. `source` is
 *  `null` exactly when `key` is `undefined` (nothing resolved). */
export interface EffectiveApiKey {
  key: string | undefined;
  source: EffectiveKeySource | null;
}

/**
 * How to resolve a credential. Two axes, both orthogonal, so every resolution
 * the CLI needs is one preset of this policy rather than a separate function:
 *
 *  - `purpose` decides the STORED-key profile search. `'data'` reads only the
 *    active project's profile, so a command that touches rows can never silently
 *    act through a different project's key. `'org-read'` is for org-level
 *    operations (list/switch projects) where any of the org's keys returns the
 *    same answer: it prefers the active profile, then `default`, then any
 *    profile with an unexpired key — which is what keeps `ablo projects use`
 *    from stranding you on a project you never minted a key for.
 *  - `scanEnvFiles` decides whether an explicit key may come from the project
 *    env files a framework loads (`.env.local`, then `.env`), not just
 *    `ABLO_API_KEY` in the process. The push/dev/status chain sets it so the CLI
 *    presents the same key the app would; management commands leave it off.
 */
export interface KeyPolicy {
  purpose: 'data' | 'org-read';
  /** Environment slot to read; defaults to the active CLI mode. */
  mode?: Mode;
  /** Consult `.env.local`/`.env` for an explicit key (default: false). */
  scanEnvFiles?: boolean;
  /** cwd seam for the env-file lookup; commands use the process directory. */
  cwd?: string;
}

/**
 * The one credential resolver every CLI command routes through. It resolves in
 * two phases — an explicit key first, then the stored `ablo login` credential:
 *
 *   `ABLO_API_KEY` in the environment
 *     → `.env.local` → `.env`            (only when `scanEnvFiles`)
 *     → the stored key for the mode, searched by the `purpose` profile policy.
 *
 * Centralizing the env-check, expiry, and profile search here is deliberate: the
 * three preset entry points ({@link resolveApiKey}, {@link resolveOrgKey},
 * {@link resolveEffectiveApiKey}) are one-liners over this, so they can't drift
 * apart the way three hand-written copies did.
 */
export function resolveKey(policy: KeyPolicy): EffectiveApiKey {
  // Phase 1 — an explicit key. With env-file scanning on, `readProjectApiKey`
  // already checks `process.env` before the files, so the two branches don't
  // double-read; without it, only the process environment is consulted.
  if (policy.scanEnvFiles) {
    const fromProject = readProjectApiKey(policy.cwd);
    if (fromProject) return { key: fromProject.key, source: fromProject.source };
  } else if (process.env.ABLO_API_KEY) {
    return { key: process.env.ABLO_API_KEY, source: 'env' };
  }

  // Phase 2 — the stored login credential, searched per the purpose policy.
  const cfg = readConfig();
  if (!cfg) return { key: undefined, source: null };
  const mode = policy.mode ?? cfg.mode;
  const profiles =
    policy.purpose === 'org-read'
      ? // Active first (a scoped key is preferred when present), then the
        // org-default, then any remaining profile — deduplicated, order-preserving.
        [...new Set([activeProfileName(cfg), DEFAULT_PROFILE, ...Object.keys(cfg.profiles)])]
      : [activeProfileName(cfg)];
  for (const name of profiles) {
    const entry = cfg.profiles[name]?.[mode];
    if (!entry) continue;
    if (entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now()) continue;
    return { key: entry.apiKey, source: 'stored' };
  }
  return { key: undefined, source: null };
}

/**
 * The credential-resolution chain `push`, `dev`, `status`, and
 * {@link resolvePushPlan} share — the `'data'` preset of {@link resolveKey} with
 * env-file scanning on, so the key a diagnostic reports is the key a deploy
 * would present. `cwd` is a test seam; commands use the process directory.
 */
export function resolveEffectiveApiKey(modeOverride?: Mode, cwd?: string): EffectiveApiKey {
  return resolveKey({ purpose: 'data', mode: modeOverride, scanEnvFiles: true, cwd });
}

/** What `ablo push` would do right now: which environment it deploys to and
 *  the credential it would present. */
export interface PushPlan {
  /** `production` → the raw one-shot pusher; `sandbox` → the dev flow
   *  (role check, `.env.local` wiring, optional `--watch`). */
  flow: Mode;
  apiKey: string | undefined;
  /** Where the credential came from — `null` when none resolves. */
  source: EffectiveKeySource | null;
}

/**
 * Resolves the credential and flow `ablo push` uses, through the shared
 * {@link resolveEffectiveApiKey} chain: an explicit key — an environment variable
 * or a project env file, whose prefix names the environment — takes precedence
 * over the active mode's stored credential in the active project profile. The
 * active mode is honored even when no credential is stored for it, so a
 * production-mode push fails by asking for a production key rather than silently
 * running the sandbox flow.
 */
export function resolvePushPlan(): PushPlan {
  const { key, source } = resolveEffectiveApiKey();
  if (key != null && source != null && source !== 'stored') {
    // An explicit key (env var or project env file) wins — exactly what push
    // presents — and its prefix names the environment it deploys to.
    return { flow: modeFromKey(key) ?? getMode(), apiKey: key, source };
  }
  return { flow: getMode(), apiKey: key, source };
}
