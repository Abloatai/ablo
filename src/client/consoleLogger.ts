/**
 * The default `[Ablo]` console logger and its level resolution.
 *
 * These helpers are exported so any entry point that needs a default logger can
 * reuse the same level gating rather than hand-rolling a console wrapper.
 */

import type { SyncLogger } from '../interfaces/index.js';

// ── Default console logger ────────────────────────────────────────────────

/**
 * Level threshold for the default console logger.
 *
 * The SDK emits a `debug` line per model and per property during schema
 * registration (see `ModelRegistry`), plus assorted lifecycle chatter. That
 * is verbose by design but carries no actionable signal for app consumers, so
 * the default threshold is `warn` — `debug`/`info` are dropped unless a
 * consumer opts in.
 *
 * Opt back in with `ABLO_LOG_LEVEL=debug` (or `info`/`warn`/`error`/`silent`).
 * Passing a custom `logger` to `Ablo({ logger })` bypasses this entirely.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
const LOG_LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

/**
 * Resolve the effective level. Precedence: explicit `logLevel` option →
 * `debug: true` (⇒ debug) → `ABLO_LOG_LEVEL` env → default `warn`. `debug: false`
 * / omitted just means "don't raise the level" — it falls through to env/default
 * rather than force-silencing an ops-set env override.
 */
export function resolveLogLevel(opts?: { debug?: boolean; logLevel?: LogLevel }): LogLevel {
  if (opts?.logLevel && opts.logLevel in LOG_LEVEL_RANK) return opts.logLevel;
  if (opts?.debug === true) return 'debug';
  // `globalThis.process` guard keeps this safe in browser/edge runtimes that
  // have no `process` binding — there we fall through to the default.
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.ABLO_LOG_LEVEL;
  const normalized = raw?.toLowerCase();
  if (normalized && normalized in LOG_LEVEL_RANK) return normalized as LogLevel;
  return 'warn';
}

/**
 * Builds the default logger, gated at `level` and prefixed `[Ablo]` so its lines
 * stand out in a console full of other tools' output.
 */
export function createConsoleLogger(level: LogLevel): SyncLogger {
  const threshold = LOG_LEVEL_RANK[level];
  const emit = (lvl: LogLevel, fn: (...args: unknown[]) => void, args: unknown[]) => {
    if (typeof console === 'undefined' || LOG_LEVEL_RANK[lvl] < threshold) return;
    fn('[Ablo]', ...args);
  };
  return {
    debug: (...args: unknown[]) => { emit('debug', console.debug, args); },
    info: (...args: unknown[]) => { emit('info', console.info, args); },
    warn: (...args: unknown[]) => { emit('warn', console.warn, args); },
    error: (...args: unknown[]) => { emit('error', console.error, args); },
  };
}
