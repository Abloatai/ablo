/**
 * Local credential store for the Ablo CLI — AWS-shaped: two files, and the
 * config file holds NO secrets.
 *
 *   config.json       non-secret settings: the active environment (mode).
 *                     Safe to open, print, or let an agent read.
 *   credentials.json  the sk_ keys, one per environment. 0600, never printed.
 *
 * (Same split as `~/.aws/config` vs `~/.aws/credentials` — tooling that
 * inspects "the config" never sees a secret.)
 *
 * Sandbox/production: a key per environment plus the active one, so
 * `ablo mode sandbox|production` toggles which key `dev` / `push` use — the
 * Stripe dashboard-toggle mental model. Key PREFIXES stay `sk_test_` /
 * `sk_live_` (a wire contract the server validates); only the human-facing
 * vocabulary is sandbox/production. `ABLO_API_KEY` in the environment always
 * wins (CI).
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

/** A stored key for one environment. `organizationId`/`expiresAt` come from
 *  the device-login flow; `--api-key` login sets only `apiKey`. */
export interface KeyEntry {
  apiKey: string;
  organizationId?: string;
  /** ISO-8601 absolute expiry, when the issuing flow sets one. */
  expiresAt?: string;
}

/** The ACTIVE project (`ablo projects use`) — a non-secret targeting
 *  preference, stored in config.json like `mode`. Absent = the org-default
 *  project. */
export interface ActiveProject {
  id: string;
  slug: string;
}

export interface StoredConfig {
  mode: Mode;
  /** Active project for project-scoped operations (key mints pick it up in
   *  the dashboard/CLI; push/status display it). */
  activeProject?: ActiveProject;
  sandbox?: KeyEntry;
  production?: KeyEntry;
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

/** Pull key entries out of the stored credential shape. */
function extractEntries(obj: Record<string, unknown>): Pick<StoredConfig, 'sandbox' | 'production'> {
  const sandbox = asKeyEntry(obj.sandbox);
  const production = asKeyEntry(obj.production);
  if (sandbox || production) {
    return { ...(sandbox ? { sandbox } : {}), ...(production ? { production } : {}) };
  }
  const flat = asKeyEntry(obj); // legacy: { apiKey, ... } at the top level
  return flat ? { sandbox: flat } : {};
}

/**
 * Read the stored config, or null if none / unreadable / malformed. Reads the
 * two-file layout; transparently MIGRATES any single-file layout with keys
 * inside config.json by rewriting into the split files.
 */
export function readConfig(): StoredConfig | null {
  const cfgObj = readJson(configPath());
  const credObj = readJson(credentialsPath());

  const mode = normalizeStoredMode(cfgObj?.mode) ?? normalizeStoredMode(credObj?.mode);
  const activeProject = asActiveProject(cfgObj?.activeProject);
  const cfgEntries = cfgObj ? extractEntries(cfgObj) : {};
  const entries = {
    ...cfgEntries,
    ...(credObj ? extractEntries(credObj) : {}), // credentials file wins
  };

  if (!mode && !entries.sandbox && !entries.production) return null;
  const config: StoredConfig = {
    mode: mode ?? 'sandbox',
    ...(activeProject ? { activeProject } : {}),
    ...entries,
  };

  // Secrets found inside config.json (the old combined layout) → split now,
  // so the non-secret file stops carrying keys.
  if (cfgEntries.sandbox || cfgEntries.production) writeConfig(config);
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
  const credentials = {
    ...(cfg.sandbox ? { sandbox: cfg.sandbox } : {}),
    ...(cfg.production ? { production: cfg.production } : {}),
  };
  writeFileSync(credentialsPath(), `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  return credentialsPath();
}

/** Store a key for one environment, preserving the other one's key. */
export function setKey(mode: Mode, entry: KeyEntry): string {
  const cfg = readConfig() ?? { mode };
  cfg[mode] = entry;
  return writeConfig(cfg);
}

/** Set the active environment. */
export function setMode(mode: Mode): string {
  const cfg = readConfig() ?? { mode };
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
  const cfg = readConfig() ?? { mode: 'sandbox' as Mode };
  if (project) cfg.activeProject = project;
  else delete cfg.activeProject;
  return writeConfig(cfg);
}

export function getKeyEntry(mode: Mode): KeyEntry | undefined {
  return readConfig()?.[mode];
}

/** Infer the environment a key belongs to from its prefix. */
export function modeFromKey(key: string): Mode | undefined {
  if (/^(sk|rk)_test_/.test(key)) return 'sandbox';
  if (/^(sk|rk)_live_/.test(key)) return 'production';
  return undefined;
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
 * overrides always win), else the stored key for the active environment (or
 * the `modeOverride`, e.g. `dev` which is always sandbox). A key past its
 * `expiresAt` is treated as absent so the caller prompts a fresh `ablo login`.
 */
export function resolveApiKey(modeOverride?: Mode): string | undefined {
  if (process.env.ABLO_API_KEY) return process.env.ABLO_API_KEY;
  const cfg = readConfig();
  if (!cfg) return undefined;
  const entry = cfg[modeOverride ?? cfg.mode];
  if (!entry) return undefined;
  if (entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now()) return undefined;
  return entry.apiKey;
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
 * stored credential. The active mode is honored even when no credential is
 * stored for it, so a production-mode push fails asking for a production
 * key instead of silently running the sandbox flow. (Pre-fix, only the env
 * var was consulted: `ablo login` + `ablo mode production` + `npx ablo push`
 * still landed in the sandbox flow and demanded `sk_test_`.)
 */
export function resolvePushPlan(): PushPlan {
  const envKey = process.env.ABLO_API_KEY;
  if (envKey) return { flow: modeFromKey(envKey) ?? getMode(), apiKey: envKey, source: 'env' };
  const mode = getMode();
  const apiKey = resolveApiKey(mode);
  return { flow: mode, apiKey, source: apiKey ? 'stored' : null };
}
