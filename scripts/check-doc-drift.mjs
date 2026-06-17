#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const repoRoot = resolve(packageRoot, '..', '..');

const publicDocRoots = [
  'README.md',
  'AGENTS.md',
  'llms.txt',
  'docs',
].map((path) => resolve(packageRoot, path));

const mcpPublicSources = [
  'apps/sync-web/src/lib/mcp-ablo/instructions.ts',
  'apps/sync-web/src/lib/mcp-ablo/prompts.ts',
  'apps/sync-web/src/lib/mcp-ablo/tools/docs-tools.ts',
  'apps/sync-web/src/lib/mcp-ablo/tools/scaffold-tool.ts',
  'apps/sync-web/src/lib/mcp-ablo/tools/validate-tool.ts',
].map((path) => resolve(repoRoot, path));

const violations = [];

function add(file, message) {
  violations.push(`${relative(repoRoot, file)}: ${message}`);
}

function walk(path, out = []) {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      if (child.includes('/docs/internal/')) continue;
      walk(child, out);
    }
  } else if (/\.(md|txt)$/.test(path)) {
    out.push(path);
  }
  return out;
}

function linesMatching(text, pattern) {
  return text
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => pattern.test(line));
}

const docs = publicDocRoots.flatMap((path) => walk(path));
for (const file of docs) {
  const rel = relative(packageRoot, file);
  const text = readFileSync(file, 'utf8');
  const isMigration = rel === 'docs/migration.md';
  const isCli = rel === 'docs/cli.md';

  if (text.includes('@abloatai/ablo')) {
    add(file, 'public docs must use @abloatai/ablo, not @abloatai/ablo');
  }
  if (text.includes('npx ablo push --no-watch')) {
    add(file, '`push --no-watch` is invalid; use `npx ablo push` or `npx ablo dev --no-watch`');
  }
  if (!isMigration) {
    for (const { number, line } of linesMatching(
      text,
      /\b(id|createdAt|updatedAt|organizationId|createdBy):\s*z\./,
    )) {
      add(file, `line ${number}: model examples must not redeclare SDK system fields (${line.trim()})`);
    }
    for (const { number, line } of linesMatching(text, /\baction\s*:|claim\(\{[^}\n]*\baction\b/)) {
      add(file, `line ${number}: claim examples must use \`reason\`, not \`action\` (${line.trim()})`);
    }
    for (const { number, line } of linesMatching(text, /\bwait\s*:\s*(true|false)\b/)) {
      add(file, `line ${number}: claim examples must use \`queue\`, not boolean \`wait\` (${line.trim()})`);
    }
  }
  if (!isCli && text.includes('bare `npx ablo push` watches forever')) {
    add(file, '`npx ablo push` is one-shot; do not document it as a watcher');
  }
  if (text.includes("ifClaimed: 'return' | 'wait' | 'fail'")) {
    add(file, "`ifClaimed: 'wait'` does not exist; reads use 'return' or 'fail'");
  }
}

for (const file of mcpPublicSources) {
  const text = readFileSync(file, 'utf8');
  if (text.includes('npm install @abloatai/ablo')) {
    add(file, 'MCP scaffolds must install @abloatai/ablo');
  }
  if (text.includes("from '@abloatai/ablo'") || text.includes('from "@abloatai/ablo"')) {
    add(file, 'MCP public templates must import @abloatai/ablo');
  }
  if (text.includes('npx ablo push --no-watch')) {
    add(file, 'MCP public guidance must not use invalid `push --no-watch`');
  }
  if (/\baction\s*:|claim\(\{[^}\n]*\baction\b/.test(text)) {
    add(file, 'MCP public claim examples must use `reason`, not `action`');
  }
  if (/\bwait\s*:\s*(true|false)\b/.test(text)) {
    add(file, 'MCP public claim examples must use `queue`, not boolean `wait`');
  }
}

if (violations.length) {
  console.error(`Found ${violations.length} doc drift violation(s):\n`);
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}

console.log('[docs] public docs and MCP scaffolds pass drift guards');
