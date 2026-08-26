#!/usr/bin/env node
import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const repoRoot = resolve(packageRoot, '..', '..');

const publicDocRoots = [
  'README.md',
  'CODEMAP.md',
  'AGENTS.md',
  'llms.txt',
  'docs',
].map((path) => resolve(packageRoot, path));

// Everything the MCP server hands an agent as fact. api-surface.ts belongs here
// for the reason the whole list does: it is prose about the API that no compiler
// reads. It once described positional `get`/`getAll`/`getCount` — removed in
// 0.35.0 — on the line
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
// `get(id)` became `local.get(id)`, while `getAll`/`getCount` became
// `local.list`/`local.count`.
// A reader who copies the old spelling gets a TypeError, not a type error, so
// the docs are the only place this can be caught.
//
// Matched WITHOUT a leading dot on purpose: the stalest copy in the tree writes
// them bare, in a sentence — `\`get(id)\` / \`getAll(...)\` / \`getCount(...)\``
// — and a `\.get\(` pattern walks straight past it. A quoted first argument is
// excluded instead, because that is a dictionary or header lookup
// (`headers.get("webhook-id")` in the Python examples) and never an Ablo read:
// the removed verbs took a positional id or one options object.
const REMOVED_READ_VERBS =
  /\b(?:getAll|getCount)\(\s*[^'"\s)]|(?<!local\.)\bget\(\s*(?!\{)[^'"\s)]/;

// The frozen 2026-07 baseline: files that still teach the removed verbs, with
// the number of lines each. This is audit finding #32 and it is a later step —
// the count is here so that step's size is knowable and cannot grow meanwhile.
// Shrink it, never grow it; delete the entry when the file reaches zero.
const REMOVED_READ_VERB_BASELINE = {};

/**
 * An MCP source's OWN import statements are code, not a template it hands an
 * agent. api-surface.ts imports `@ablo/ablo` precisely so the verb list
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

/**
 * The engine's base fields, read out of the module that defines them.
 *
 * Every rule below that names a base field derives it from here. The three
 * copies this replaces — the MCP schema linter, the CLI adopt rule, and the
 * regex that used to sit in this very file — all still said `id`, `createdAt`,
 * `updatedAt`, `organizationId`, `createdBy` five releases after 0.52.0 cut the
 * list to `id`. The copy in THIS file was the worst of them: it forbade doc
 * examples from declaring `createdAt`, which by then was the correct thing to
 * do, so the gate against drift was itself enforcing the drift.
 */
function engineBaseFields() {
  const source = readFileSync(
    resolve(repoRoot, 'packages/transaction/src/schema/schema.ts'),
    'utf8',
  );
  const literal = /export const BASE_FIELDS = \[([\s\S]*?)\] as const;/.exec(source);
  if (!literal) throw new Error('could not read BASE_FIELDS from schema/schema.ts');
  return [...literal[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

const BASE_FIELDS = engineBaseFields();

/**
 * The tenancy value is server-owned like a base field but is not one: it comes
 * from a model's `policy`, not its field list. Prose may legitimately group it
 * with `id`, so it is tolerated wherever a base field is.
 *
 * Read from `DEFAULT_ORG_COLUMN` in both spellings a doc may use, rather than
 * typed out here. A gate written against hand-written copies should not open
 * with one.
 */
function tenancyNames() {
  const source = readFileSync(
    resolve(repoRoot, 'packages/transaction/src/schema/tenancy.ts'),
    'utf8',
  );
  const literal = /export const DEFAULT_ORG_COLUMN = '([^']+)';/.exec(source);
  if (!literal) throw new Error('could not read DEFAULT_ORG_COLUMN from schema/tenancy.ts');
  const column = literal[1];
  const camel = column.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  return [column, camel];
}

const TENANCY_NAMES = tenancyNames();

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
      `line ${number}: positional \`get\`/\`getAll\`/\`getCount\` were removed in 0.35.0 — ` +
        `use \`get({ id })\` to observe, \`read({ id })\` for decision input, or \`local.get(id)\` for snapshots (${line.trim()})`,
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

/**
 * The coordination reference must document every member of the claim target —
 * the wire's `claimTargetSchema` is the shape, and the doc's parameter table is
 * where a developer learns it exists. For months the table said
 * `{ model, id, field? }` while the wire carried `path`, `range`, and `fields`,
 * so sub-row exclusion — enforced the whole time — was undiscoverable, and the
 * one mentioned key was described as a badge hint. The keys are read out of the
 * schema so a key added there is a doc failure here, not a capability that
 * ships dark. `model` and `id` are exempt: the call form supplies them
 * (`ablo.<model>.claim({ id })`), so the doc documents them as the call, not as
 * options.
 */
function checkClaimTargetCoverage() {
  const page = resolve(packageRoot, 'docs/coordination.md');
  const schemaModule = resolve(repoRoot, 'packages/transaction/src/claims/contract.ts');
  const source = readFileSync(schemaModule, 'utf8');
  const text = readFileSync(page, 'utf8');

  const literal = /export const claimTargetSchema = z\.object\(\{([\s\S]*?)\}\);/.exec(source);
  if (!literal) {
    add(page, 'could not read claimTargetSchema from claims/contract.ts');
    return;
  }

  const suppliedByCall = new Set(['model', 'id']);
  const keys = [...literal[1].matchAll(/^\s*([A-Za-z_]\w*):/gm)]
    .map((m) => m[1])
    .filter((key) => !suppliedByCall.has(key));
  for (const key of keys) {
    if (!text.includes(`options.${key}`)) {
      add(page, `claim target key \`${key}\` (wire claimTargetSchema) is not documented as \`options.${key}\``);
    }
  }
}

/** A model example redeclaring a field the SDK supplies. Derived, not restated. */
const redeclaresBaseField = new RegExp(`\\b(${BASE_FIELDS.join('|')}):\\s*z\\.`);

/**
 * Prose that tells a reader which fields they need not declare must name only
 * fields the engine actually supplies.
 *
 * The shape caught here is the one that shipped in five places at once: a
 * comma-separated run of names including `id`, inside a sentence about them
 * being reserved, provided, supplied, or not to be declared. `createdAt` in
 * such a run is not a wording problem — it is an instruction to delete a
 * field, after which `ablo migrate` provisions no column and the row has no
 * such value at all. Naming those fields OUTSIDE a reserved claim is fine and
 * is what the docs should do, so only the claim shape is policed.
 */
const RESERVED_CLAIM =
  /reserved|automatic|supplie[sd]|provide[sd]|inject|do not declare|don't declare|never declare/i;
const CLAIM_TOKEN = String.raw`\\?\`?[A-Za-z_]\w*\\?\`?`;
const CLAIM_LIST = new RegExp(`(?:${CLAIM_TOKEN}\\s*,\\s*)+(?:(?:and|or)\\s+)?${CLAIM_TOKEN}`, 'g');

function checkBaseFieldClaims(file, text) {
  const allowed = new Set([...BASE_FIELDS, ...TENANCY_NAMES]);
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!RESERVED_CLAIM.test(line)) continue;
    const named = new Set();
    for (const run of line.matchAll(CLAIM_LIST)) {
      const names = [...run[0].matchAll(/\b([A-Za-z_]\w*)\b/g)]
        .map((m) => m[1])
        .filter((n) => n !== 'and' && n !== 'or');
      if (!names.includes('id')) continue;
      for (const n of names) if (!allowed.has(n)) named.add(n);
    }
    if (named.size) {
      add(
        file,
        `line ${i + 1}: names ${[...named].map((n) => `\`${n}\``).join(', ')} as supplied by the SDK; ` +
          `base fields are ${BASE_FIELDS.map((n) => `\`${n}\``).join(', ')} — audit fields are declared by the author`,
      );
    }
  }
}

/**
 * Every export the MCP api-surface descriptor names must actually exist.
 *
 * That file derives its VERB names from a machine-checked manifest and says so
 * in its own preamble, then hand-writes the export list eight lines below —
 * where `InferModel`, a type the SDK has never exported under that name on
 * this path, sat being handed to agents as fact. Same defect, different
 * syntax, which is why this checks the property rather than the shape: resolve
 * each subpath to the source module it really resolves to, collect what it
 * really exports, and compare.
 */
function packageDirsByName() {
  const dirs = new Map();
  const root = resolve(repoRoot, 'packages');
  for (const name of readdirSync(root)) {
    const manifest = join(root, name, 'package.json');
    try {
      dirs.set(JSON.parse(readFileSync(manifest, 'utf8')).name, join(root, name));
    } catch {
      /* not a package */
    }
  }
  return dirs;
}

const PACKAGE_DIRS = packageDirsByName();

/** A bare specifier → the `.ts` its `@ablo/source` condition points at, or null. */
function resolveSourceEntry(specifier) {
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const dir = PACKAGE_DIRS.get(name);
  if (!dir) return null;
  const sub = specifier.slice(name.length);
  const key = sub === '' ? '.' : `.${sub}`;
  const exports = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).exports ?? {};
  const entry = exports[key]?.['@ablo/source'];
  return entry ? resolve(dir, entry) : null;
}

/**
 * The names a module exports, following `export *` into the workspace.
 *
 * Returns null when any `export *` leads somewhere unresolvable (an external
 * package), because a partial list would report a real export as a phantom.
 */
function collectExports(file, seen = new Set()) {
  if (seen.has(file)) return new Set();
  seen.add(file);
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const names = new Set();
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) names.add(element.name.text);
        continue;
      }
      // `export * from '…'` — follow it, or give up rather than guess.
      const spec = statement.moduleSpecifier?.text;
      if (!spec) continue;
      const target = spec.startsWith('.')
        ? resolve(dirname(file), spec.replace(/\.js$/, '.ts'))
        : resolveSourceEntry(spec);
      if (!target) return null;
      const nested = collectExports(target, seen);
      if (!nested) return null;
      for (const name of nested) names.add(name);
      continue;
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) names.add(decl.name.text);
      }
    } else if (statement.name && ts.isIdentifier(statement.name)) {
      names.add(statement.name.text);
    }
  }
  return names;
}

function checkApiSurfaceExports() {
  const file = resolve(repoRoot, 'apps/sync-web/src/lib/mcp-ablo/api-surface.ts');
  const text = readFileSync(file, 'utf8');
  const marks = [...text.matchAll(/\[(?:PUBLIC_ABLO_PACKAGE|publicAbloSubpath\('([^']+)'\))\]:/g)];
  if (!marks.length) {
    add(file, 'could not read API_SURFACES subpath blocks');
    return;
  }
  for (let i = 0; i < marks.length; i++) {
    const sub = marks[i][1];
    const segment = text.slice(marks[i].index, marks[i + 1]?.index ?? text.length);
    const specifier = sub ? `@abloatai/ablo/${sub}` : '@abloatai/ablo';
    const entry = resolveSourceEntry(specifier);
    if (!entry) {
      add(file, `subpath \`${specifier}\` has no @ablo/source entry in packages/ablo/package.json`);
      continue;
    }
    const real = collectExports(entry);
    if (!real) continue; // an `export *` we cannot follow; do not guess
    for (const claimed of segment.matchAll(/name: '([A-Za-z0-9_]+)'/g)) {
      if (!real.has(claimed[1])) {
        add(file, `\`${specifier}\` does not export \`${claimed[1]}\` — the descriptor names it anyway`);
      }
    }
  }
}

checkSessionSettingsPage();
checkClaimTargetCoverage();
checkApiSurfaceExports();

const docs = publicDocRoots.flatMap((path) => walk(path));
for (const file of docs) {
  const rel = relative(packageRoot, file);
  const text = readFileSync(file, 'utf8');
  const isMigration = rel === 'docs/migration.md';
  const isCli = rel === 'docs/cli.md';

  if (text.includes('@ablo/ablo')) {
    add(file, 'public docs must use @abloatai/ablo, not @ablo/ablo');
  }
  if (text.includes('npx ablo push --no-watch')) {
    add(file, '`push --no-watch` is invalid; use `npx ablo push` or `npx ablo dev --no-watch`');
  }
  if (!isMigration) {
    for (const { number, line } of linesMatching(text, redeclaresBaseField)) {
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
  if (!isMigration) {
    checkRemovedReadVerbs(file, rel, text);
    checkBaseFieldClaims(file, text);
  }
}

for (const file of mcpPublicSources) {
  const text = readFileSync(file, 'utf8');
  const templates = withoutOwnImports(text);
  if (templates.includes('npm install @ablo/ablo')) {
    add(file, 'MCP scaffolds must install @abloatai/ablo');
  }
  if (
    templates.includes("from '@ablo/ablo'") ||
    templates.includes('from "@ablo/ablo"')
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
  checkBaseFieldClaims(file, text);
}

if (violations.length) {
  console.error(`Found ${violations.length} doc drift violation(s):\n`);
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}

console.log('[docs] public docs and MCP scaffolds pass drift guards');
