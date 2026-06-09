/**
 * Local credential store for the Ablo CLI.
 *
 * Stripe-style test/live: the file holds a key per mode plus the active mode,
 * so `ablo mode test|live` toggles which key `dev` / `push` use — the
 * same mental model as Stripe's dashboard toggle, made possible by Ablo's
 * sandbox data isolation. `ABLO_API_KEY` in the environment always wins (CI).
 *
 * Path: `$ABLO_CONFIG_DIR` → `$XDG_CONFIG_HOME/ablo` → `~/.config/ablo`.
 * The file is written `0600` (owner read/write only); the dir `0700`.
 *
 * v1 stores plaintext, like Stripe. An OS-keychain backend
 * (`@napi-rs/keyring`) is a later hardening.
 */

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';

export type Mode = 'test' | 'live';

/** A stored key for one mode. `organizationId`/`expiresAt` come from the
 *  device-login flow; `--api-key` login sets only `apiKey`. */
export interface KeyEntry {
  apiKey: string;
  organizationId?: string;
  /** ISO-8601 absolute expiry, when the issuing flow sets one. */
  expiresAt?: string;
}

export interface StoredConfig {
  mode: Mode;
  test?: KeyEntry;
  live?: KeyEntry;
}

export function configDir(): string {
  if (process.env.ABLO_CONFIG_DIR) return process.env.ABLO_CONFIG_DIR;
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, 'ablo') : join(homedir(), '.config', 'ablo');
}

export function configPath(): string {
  return join(configDir(), 'config.json');
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

/** Read the stored config, or null if none / unreadable / malformed. */
export function readConfig(): StoredConfig | null {
  const path = configPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;

    // Current shape: { mode, test?, live? }.
    if (obj.mode === 'test' || obj.mode === 'live') {
      return {
        mode: obj.mode,
        ...(asKeyEntry(obj.test) ? { test: asKeyEntry(obj.test) } : {}),
        ...(asKeyEntry(obj.live) ? { live: asKeyEntry(obj.live) } : {}),
      };
    }

    // Legacy flat shape: { apiKey, organizationId?, expiresAt? } → test slot.
    const legacy = asKeyEntry(obj);
    if (legacy) return { mode: 'test', test: legacy };
    return null;
  } catch {
    return null;
  }
}

/** Persist the whole config, creating the dir with locked-down perms. */
export function writeConfig(cfg: StoredConfig): string {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = configPath();
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  return path;
}

/** Store a key for one mode, preserving the other mode's key. */
export function setKey(mode: Mode, entry: KeyEntry): string {
  const cfg = readConfig() ?? { mode };
  cfg[mode] = entry;
  return writeConfig(cfg);
}

/** Set the active mode. */
export function setMode(mode: Mode): string {
  const cfg = readConfig() ?? { mode };
  cfg.mode = mode;
  return writeConfig(cfg);
}

export function getMode(): Mode {
  return readConfig()?.mode ?? 'test';
}

export function getKeyEntry(mode: Mode): KeyEntry | undefined {
  return readConfig()?.[mode];
}

/** Infer the mode a key belongs to from its prefix. */
export function modeFromKey(key: string): Mode | undefined {
  if (/^(sk|rk)_test_/.test(key)) return 'test';
  if (/^(sk|rk)_live_/.test(key)) return 'live';
  return undefined;
}

/** Remove the stored config. Returns true if a file was deleted. */
export function clearCredential(): boolean {
  const path = configPath();
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

/**
 * The key the CLI should authenticate with: `ABLO_API_KEY` (CI / one-off
 * overrides always win), else the stored key for the active mode (or the
 * `modeOverride`, e.g. `dev` which is always test). A key past its `expiresAt`
 * is treated as absent so the caller prompts a fresh `ablo login`.
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
