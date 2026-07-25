import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && (entry.name === 'node_modules' || entry.name === 'dist')) {
      return [];
    }
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}

const sourceFiles = walk(sourceRoot).filter((file) => /\.[cm]?[jt]sx?$/.test(file));
const violations = [];
const importPattern =
  /import\s+([^;]+?)\sfrom\s+['"](@ablo\/sync-engine(?:\/[^'"]+)?)['"]/g;

for (const file of sourceFiles) {
  const source = fs.readFileSync(file, 'utf8');

  for (const match of source.matchAll(importPattern)) {
    const packagePath = match[2];
    violations.push(
      `${path.relative(process.cwd(), file)}: depends on deprecated ${packagePath}`,
    );
  }
}

if (violations.length > 0) {
  console.error('humans boundary violations:');
  console.error(violations.join('\n'));
  process.exit(1);
}

console.log(
  `humans boundary clean (${sourceFiles.length} source files, no deprecated engine imports)`,
);
