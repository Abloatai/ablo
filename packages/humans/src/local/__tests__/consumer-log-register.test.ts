/**
 * Consumer-register guard for default-visible logs.
 *
 * `@abloatai/ablo`'s default logger (createConsoleLogger) is gated at `warn`,
 * so `logger.warn` / `logger.error` are what a CONSUMER sees out of the box.
 * Those lines must speak the app developer's language — not the engine's. See
 * docs/plans/sync-engine-consumer-log-dx.md for the full style guide.
 *
 * This is the structural belt that keeps the style guide enforceable: it scans
 * every `logger.warn(` / `logger.error(` call whose first argument is a string
 * LITERAL and fails if that literal carries an internal `[Module]` sub-tag or a
 * known engine noun. The maintainer register (`logger.debug` / `logger.info`,
 * off by default) is NOT scanned — internal vocabulary is fine there.
 *
 * Dynamic first args (a variable, a `format*()` call, a bare template with no
 * offending word) can't be checked statically and are skipped — the guard is a
 * denylist tripwire for the common regression (paste an internal warn), not a
 * proof of full compliance.
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..');

// Files whose console/logging IS the product surface, or that define the logger
// itself — not library-consumer runtime logs.
const EXCLUDE_DIRS = ['cli', 'testing', '__tests__'];

// Internal nouns that must never appear in a default-visible (warn/error) line.
// These are engine implementation names a consumer can neither import nor act
// on. Matched case-insensitively against the message literal.
const ENGINE_NOUNS = [
  'MutationQueue',
  'ConnectionManager',
  'BaseSyncedStore',
  'SyncWebSocket',
  'NetworkProbe',
  'StoreManager',
  'DatabaseManager',
  'InstanceCache',
  'processDeltaBatch',
  'applyDeltaBatchToPool',
  'delta batch',
  'disposed model',
  'rolling back',
  'permanent error',
  'syncClient.initialize',
  'SyncClient.',
];

// `[Something]` sub-tag at the start of a message — the logger already adds the
// one namespace a consumer needs (`[Ablo]`); a second bracket tag is forensic.
const MODULE_TAG = /^\s*\[[A-Za-z][\w.]*\]/;

/** Recursively collect *.ts source files, skipping tests/cli/testing. */
function collectSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (EXCLUDE_DIRS.includes(entry)) continue;
      out.push(...collectSources(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts') && !entry.includes('.test.')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Find every `logger.warn(` / `logger.error(` (or `.logger.warn(` via context)
 * whose FIRST argument is a string/template literal, and return that literal's
 * inner text. Multiline calls are handled; non-literal first args are skipped.
 */
function defaultVisibleLiterals(source: string): string[] {
  const literals: string[] = [];
  // `logger` then `.warn(`/`.error(` then optional whitespace/newline then a
  // quote (', ", or `) capturing up to the matching closing quote of that kind.
  const re = /\blogger\s*\.\s*(?:warn|error)\s*\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const literal = m[2];
    if (literal !== undefined) literals.push(literal);
  }
  return literals;
}

describe('consumer-register guard for default-visible logs', () => {
  const files = collectSources(SRC);

  it('finds source files to scan (guard is actually running)', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('no logger.warn/error message carries a [Module] sub-tag', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const lit of defaultVisibleLiterals(src)) {
        if (MODULE_TAG.test(lit)) {
          offenders.push(`${file.replace(SRC, 'src')}: "${lit.slice(0, 60)}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no logger.warn/error message contains an internal engine noun', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const lit of defaultVisibleLiterals(src)) {
        const lower = lit.toLowerCase();
        const hit = ENGINE_NOUNS.find((n) => lower.includes(n.toLowerCase()));
        if (hit) {
          offenders.push(`${file.replace(SRC, 'src')}: "${hit}" in "${lit.slice(0, 60)}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
