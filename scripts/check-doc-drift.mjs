#!/usr/bin/env node
import ts from 'typescript';
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

// Everything the MCP server hands an agent as fact. api-surface.ts belongs here
// for the reason the whole list does: it is prose about the API that no compiler
// reads. It described `get`/`getAll`/`getCount` — removed in 0.35.0 — on the line
// directly BELOW an import of `PUBLIC_MODEL_VERBS`, the machine-checked list that
// no longer contains them. The names were derived and the sentence around them
// was not, so the sentence went stale alone, in the one place we tell agents to
// trust.
const mcpPublicSources = [
  'apps/sync-web/src/lib/mcp-ablo/api-surface.ts',
  'apps/sync-web/src/lib/mcp-ablo/instructions.ts',
  'apps/sync-web/src/lib/mcp-ablo/prompts.ts',
  'apps/sync-web/src/lib/mcp-ablo/tools/docs-tools.ts',
  'apps/sync-web/src/lib/mcp-ablo/tools/scaffold-tool.ts',
  'apps/sync-web/src/lib/mcp-ablo/tools/validate-tool.ts',
].map((path) => resolve(repoRoot, path));

// The synchronous read verbs 0.35.0 moved under `local` — `get(id)` became
// `local.retrieve(id)`, `getAll`/`getCount` became `local.list`/`local.count`.
// A reader who copies the old spelling gets a TypeError, not a type error, so
// the docs are the only place this can be caught.
//
// Matched WITHOUT a leading dot on purpose: the stalest copy in the tree writes
// them bare, in a sentence — `\`get(id)\` / \`getAll(...)\` / \`getCount(...)\``
// — and a `\.get\(` pattern walks straight past it. A quoted first argument is
// excluded instead, because that is a dictionary or header lookup
// (`headers.get("webhook-id")` in the Python examples) and never an Ablo read:
// the removed verbs took a positional id or one options object.
const REMOVED_READ_VERBS = /\b(get|getAll|getCount)\(\s*[^'"\s)]/;

// The frozen 2026-07 baseline: files that still teach the removed verbs, with
// the number of lines each. This is audit finding #32 and it is a later step —
// the count is here so that step's size is knowable and cannot grow meanwhile.
// Shrink it, never grow it; delete the entry when the file reaches zero.
const REMOVED_READ_VERB_BASELINE = {
  'AGENTS.md': 1,
  'docs/integration-guide.md': 3,
  'apps/sync-web/src/lib/mcp-ablo/api-surface.ts': 1,
  'apps/sync-web/src/lib/mcp-ablo/instructions.ts': 1,
};

/**
 * An MCP source's OWN import statements are code, not a template it hands an
 * agent. api-surface.ts imports `@abloatai/ablo` precisely so the verb list
 * it publishes is derived from the machine-checked one rather than retyped —
 * the behaviour this whole file exists to encourage — while scaffold-tool.ts
 * emits `import … from '…'` INSIDE template literals, which is exactly what the
 * published-specifier rule must keep policing.
 *
 * The two are told apart by parsing, not by pattern: only a real
 * import/export declaration is blanked. Text inside a template literal is never
 * one, so every scaffolded import survives untouched. A line-shaped heuristic
 * cannot make this distinction — both spellings sit at column 0.
 */
function withoutOwnImports(text) {
  const source = ts.createSourceFile('mcp.ts', text, ts.ScriptTarget.Latest, true);
  /** @type {{ start: number, end: number }[]} */
  const ranges = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    if (!statement.moduleSpecifier) continue;
    ranges.push({ start: statement.getStart(source), end: statement.getEnd() });
  }
  let out = text;
  for (const { start, end } of ranges.reverse()) {
    out = out.slice(0, start) + ' '.repeat(end - start) + out.slice(end);
  }
  return out;
}

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

/**
 * A claim's params must not spell the old `action` field.
 *
 * `action` is NOT banned outright: it is a required field of
 * `commitOperationBodySchema`, where it always appears beside `model`. That pair
 * is the discriminator — the lookahead lets a legitimate commit operation
 * through and still catches `action` used as a claim param. (Enforce the
 * property, not the syntax the last violation happened to take.)
 */
const CLAIM_ACTION_PATTERN = /\baction\s*:(?![^\n]*\bmodel\s*:)|claim\(\{[^}\n]*\baction\b/;

function linesMatching(text, pattern) {
  return text
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => pattern.test(line));
}

/**
 * Report every line teaching a removed read verb BEYOND the frozen count for
 * this file. Counting rather than allowlisting line numbers keeps the guard
 * alive inside a file that is already on the list: edit `api-surface.ts` and
 * add a second stale sentence and it fails, which is the failure mode that
 * produced this rule in the first place.
 */
function checkRemovedReadVerbs(file, key, text) {
  const hits = linesMatching(text, REMOVED_READ_VERBS);
  const allowed = REMOVED_READ_VERB_BASELINE[key] ?? 0;
  for (const { number, line } of hits.slice(allowed)) {
    add(
      file,
      `line ${number}: \`get\`/\`getAll\`/\`getCount\` were removed in 0.35.0 — ` +
        `use \`local.retrieve\`/\`local.list\`/\`local.count\` (${line.trim()})`,
    );
  }
  if (hits.length < allowed) {
    add(
      file,
      `${allowed - hits.length} removed-read-verb line(s) are gone — lower this file's ` +
        'entry in REMOVED_READ_VERB_BASELINE so the gain is locked in',
    );
  }
}

/**
 * The session-settings page names two lists that live in code: the settings the
 * engine reserves for itself, and the closed set of identities a mapping may
 * name. Prose cannot derive them, so this reads both out of the schema module
 * and checks the page mentions each one.
 *
 * It guards the direction that actually goes wrong. A source added to
 * `SessionSettingSource` is a new thing a schema may map, and a page that does
 * not list it is a feature nobody can find; a setting added to
 * `RESERVED_SESSION_SETTINGS` is a mapping that begins failing at authoring
 * time, and a page that still implies it is allowed sends the reader looking
 * for a bug in their own schema.
 */
function checkSessionSettingsPage() {
  const page = resolve(packageRoot, 'docs/session-settings.md');
  const schemaModule = resolve(repoRoot, 'packages/transaction/src/schema/schema.ts');
  const source = readFileSync(schemaModule, 'utf8');
  const text = readFileSync(page, 'utf8');

  const reservedBlock = /RESERVED_SESSION_SETTINGS[^=]*=\s*\[([\s\S]*?)\]/.exec(source);
  const sourceUnion = /export type SessionSettingSource =([\s\S]*?);/.exec(source);
  if (!reservedBlock || !sourceUnion) {
    add(page, 'could not read RESERVED_SESSION_SETTINGS / SessionSettingSource from schema.ts');
    return;
  }

  const names = (block) => [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const setting of names(reservedBlock[1])) {
    if (!text.includes(setting)) {
      add(page, `reserved session setting \`${setting}\` is not mentioned`);
    }
  }
  for (const identity of names(sourceUnion[1])) {
    if (!text.includes(identity)) {
      add(page, `mappable identity \`${identity}\` is not mentioned`);
    }
  }
}

checkSessionSettingsPage();

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
    for (const { number, line } of linesMatching(text, CLAIM_ACTION_PATTERN)) {
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
  // The migration note's job is to name what was removed, next to what replaced it.
  if (!isMigration) checkRemovedReadVerbs(file, rel, text);
}

for (const file of mcpPublicSources) {
  const text = readFileSync(file, 'utf8');
  const templates = withoutOwnImports(text);
  if (templates.includes('npm install @abloatai/ablo')) {
    add(file, 'MCP scaffolds must install @abloatai/ablo');
  }
  if (
    templates.includes("from '@abloatai/ablo'") ||
    templates.includes('from "@abloatai/ablo"')
  ) {
    add(file, 'MCP public templates must import @abloatai/ablo');
  }
  if (text.includes('npx ablo push --no-watch')) {
    add(file, 'MCP public guidance must not use invalid `push --no-watch`');
  }
  if (CLAIM_ACTION_PATTERN.test(text)) {
    add(file, 'MCP public claim examples must use `reason`, not `action`');
  }
  if (/\bwait\s*:\s*(true|false)\b/.test(text)) {
    add(file, 'MCP public claim examples must use `queue`, not boolean `wait`');
  }
  checkRemovedReadVerbs(file, relative(repoRoot, file), text);
}

if (violations.length) {
  console.error(`Found ${violations.length} doc drift violation(s):\n`);
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}

console.log('[docs] public docs and MCP scaffolds pass drift guards');
