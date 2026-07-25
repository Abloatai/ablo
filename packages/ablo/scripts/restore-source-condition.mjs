/**
 * postpack: restore the pristine package.json saved by prepack
 * (strip-source-condition.mjs), bringing the `@ablo/source` export condition
 * back to the dev tree after the tarball is written.
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const packageDir = process.cwd();
const packageJsonPath = join(packageDir, 'package.json');
const backupPath = join(packageDir, 'package.json.prepack-backup');

if (!existsSync(backupPath)) {
  console.error(
    '[restore-source-condition] no package.json.prepack-backup found — ' +
      'nothing to restore (was prepack skipped?)'
  );
  process.exit(1);
}

writeFileSync(packageJsonPath, readFileSync(backupPath, 'utf8'));
rmSync(backupPath);
// stderr: `npm pack --json` owns stdout (pack-check.mjs parses it)
console.error("[restore-source-condition] restored '@ablo/source' exports condition");
