/**
 * prepack: strip the `@ablo/source` custom export condition from package.json
 * so it never ships to npm.
 *
 * Why: the condition points every subpath at `./src/*.ts` for in-repo
 * consumers (tsconfig `customConditions` / vitest `resolve.conditions`). If it
 * ships in the tarball, any consumer toolchain that happens to activate the
 * condition resolves TypeScript source that (a) may be excluded from the
 * package and (b) is not meant to be consumed — the documented failure class
 * for custom source conditions (see the packaging research: colinhacks' "live
 * types" pattern; publishers on npm must strip via prepack because npm does
 * not apply `publishConfig.exports` the way pnpm does).
 *
 * Mechanics: saves a byte-identical backup next to package.json, rewrites
 * `exports` without any `@ablo/source` keys. `postpack`
 * (restore-source-condition.mjs) restores the backup, so the dev tree keeps
 * the condition. The backup file matches nothing in `files`, so it cannot
 * itself end up in the tarball.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const packageDir = process.cwd();
const packageJsonPath = join(packageDir, 'package.json');
const backupPath = join(packageDir, 'package.json.prepack-backup');

const CONDITION = '@ablo/source';

if (existsSync(backupPath)) {
  // A previous pack crashed between prepack and postpack. The backup is the
  // pristine dev file — refuse to overwrite it with a possibly-stripped tree.
  console.error(
    `[strip-source-condition] ${backupPath} already exists — a previous pack ` +
      'did not restore. Run `node scripts/restore-source-condition.mjs` first.'
  );
  process.exit(1);
}

const raw = readFileSync(packageJsonPath, 'utf8');

/** @param {unknown} node */
const stripCondition = (node) => {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return node;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === CONDITION) continue;
    out[key] = stripCondition(value);
  }
  return out;
};

/** @type {Record<string, unknown>} */
const pkg = JSON.parse(raw);
pkg.exports = stripCondition(pkg.exports);

writeFileSync(backupPath, raw);
writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
// stderr: `npm pack --json` owns stdout (pack-check.mjs parses it)
console.error(`[strip-source-condition] removed '${CONDITION}' from exports for packing`);
