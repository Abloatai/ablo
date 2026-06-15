/**
 * `ablo upgrade` — codemod that migrates a consumer's code to the current
 * (0.9.x) API. The single highest-leverage thing for stability perception: a
 * working integration on an old version gets rewritten instead of broken.
 *
 * SAFE BY DEFAULT: previews the changes (dry-run). Pass `--write` to apply.
 *
 * Auto-rewrites (mechanical, high-confidence):
 *   - positional model verbs → one options object:
 *       update(id, data, opts?) → update({ id, data, ...opts })
 *       create(data, opts?)     → create({ data, ...opts })
 *       delete(id, opts?)       → delete({ id, ...opts })
 *       retrieve(id, opts?)     → retrieve({ id, ...opts })
 *   - load()  → retrieve({ id }) (when filtering by id) / list({ where })
 *   - withSync(X) → observer(X)  (withSync was a no-op alias of observer)
 *
 * Reports for manual review (structural — too risky to auto-rewrite):
 *   - drizzleDataSource(db, tables) → (db, schema)
 *   - <AbloProvider schema|teamIds|authEndpoint=...>  → build a client, pass client={ablo}
 *   - ablo.claims.* → ablo.<model>.claim.*
 *   - callback claim(id, async (row) => …) → `await using claim = await …claim({ id })`
 *
 * Usage:
 *   npx ablo upgrade                 # preview (dry-run), default globs
 *   npx ablo upgrade --write         # apply
 *   npx ablo upgrade "app/**" "src/**" # custom path(s) / globs
 */

import pc from 'picocolors';
import { Project, Node, SyntaxKind } from 'ts-morph';
import type { CallExpression, ObjectLiteralExpression, SourceFile } from 'ts-morph';

const DEFAULT_GLOBS = ['app/**/*.{ts,tsx}', 'src/**/*.{ts,tsx}', 'ablo/**/*.{ts,tsx}', 'lib/**/*.{ts,tsx}'];
const VERB_ARGS: Record<string, readonly string[]> = {
  // verb → the positional parameter names, in order, that become object keys
  update: ['id', 'data'],
  create: ['data'],
  delete: ['id'],
  retrieve: ['id'],
};
const ABLO_REACT = new Set(['@abloatai/ablo/react', '@abloatai/ablo/react']);

interface Edit {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly before: string;
  readonly after: string;
}
interface Manual {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly snippet: string;
  readonly hint: string;
}

/** Identifiers in this file that name an Ablo client (so `<root>.<model>.<verb>` is safe to rewrite). */
function clientRoots(sf: SourceFile): Set<string> {
  const roots = new Set<string>(['ablo', 'sync']); // the scaffold's conventional names
  for (const decl of sf.getVariableDeclarations()) {
    const init = decl.getInitializer();
    if (!init) continue;
    const text = init.getText();
    // const x = Ablo({...})  |  const x = useAblo()  (zero-arg client, not a selector)
    if (/^Ablo\s*\(/.test(text) || /^useAblo\s*\(\s*\)/.test(text)) {
      roots.add(decl.getName());
    }
  }
  return roots;
}

/** The object-literal-properties text for a value that's being merged in as `...opts`. */
function spreadOpts(optsArg: Node | undefined): string {
  if (!optsArg) return '';
  if (Node.isObjectLiteralExpression(optsArg)) {
    // inline the literal's own properties: { a, b } → "a, b"
    const inner = optsArg.getProperties().map((p) => p.getText()).join(', ');
    return inner ? `, ${inner}` : '';
  }
  return `, ...${optsArg.getText()}`;
}

/** Does this object literal have a top-level property named `key`? */
function hasKey(obj: ObjectLiteralExpression, key: string): boolean {
  return obj.getProperties().some(
    (p) => (Node.isPropertyAssignment(p) || Node.isShorthandPropertyAssignment(p)) && p.getName() === key,
  );
}

/** Rewrite a positional model-verb call to the object-param form. Returns the new call text, or null to skip. */
function verbRewrite(call: CallExpression, verb: string): string | null {
  const params = VERB_ARGS[verb];
  if (!params) return null;
  const args = call.getArguments();
  if (args.length === 0) return null;
  const first = args[0];
  const calleeText = call.getExpression().getText(); // e.g. "ablo.tasks.update"

  if (verb === 'create') {
    // old: create(data, opts?) → new: create({ data, ...opts }). The OLD `data` is
    // itself an object literal, so detect already-migrated by an explicit `data` key.
    if (Node.isObjectLiteralExpression(first) && hasKey(first, 'data')) return null;
    return `${calleeText}({ data: ${first.getText()}${spreadOpts(args[1])} })`;
  }
  // update/delete/retrieve: the first positional was a bare `id` (never an object),
  // so an object-literal first arg means it's already migrated.
  if (Node.isObjectLiteralExpression(first)) return null;
  const keyed = params.map((key, i) => (args[i] ? `${key}: ${args[i].getText()}` : null)).filter(Boolean);
  return `${calleeText}({ ${keyed.join(', ')}${spreadOpts(args[params.length])} })`;
}

/** load({ where: { id } }) → retrieve({ id }); load({ where }) / load() → list(...). Returns new text or null. */
function loadRewrite(call: CallExpression): string | null {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return null;
  const base = callee.getExpression().getText(); // "ablo.tasks"
  const arg = call.getArguments()[0];
  if (arg && Node.isObjectLiteralExpression(arg)) {
    const where = arg.getProperty('where');
    if (where && Node.isPropertyAssignment(where)) {
      const whereVal = where.getInitializerOrThrow();
      if (Node.isObjectLiteralExpression(whereVal)) {
        const idProp = whereVal.getProperty('id');
        // load({ where: { id } }) with ONLY id → retrieve({ id })
        if (idProp && whereVal.getProperties().length === 1 && Node.isPropertyAssignment(idProp)) {
          return `${base}.retrieve({ id: ${idProp.getInitializerOrThrow().getText()} })`;
        }
      }
      return `${base}.list({ where: ${whereVal.getText()} })`;
    }
  }
  return `${base}.list(${arg ? arg.getText() : ''})`;
}

export async function upgrade(argv: readonly string[]): Promise<void> {
  const write = argv.includes('--write');
  const globs = argv.filter((a) => !a.startsWith('-'));
  const project = new Project({ skipAddingFilesFromTsConfig: true });
  project.addSourceFilesAtPaths(globs.length > 0 ? globs : DEFAULT_GLOBS);

  const files = project.getSourceFiles();
  if (files.length === 0) {
    console.log(pc.yellow('  No .ts/.tsx files found. Pass a glob, e.g. `ablo upgrade "src/**/*.tsx"`.'));
    return;
  }

  const edits: Edit[] = [];
  const manual: Manual[] = [];

  for (const sf of files) {
    const roots = clientRoots(sf);
    const file = sf.getFilePath();
    const record = (node: Node, rule: string, before: string, after: string): void => {
      edits.push({ file, line: node.getStartLineNumber(), rule, before, after });
    };
    const flag = (node: Node, rule: string, hint: string): void => {
      manual.push({ file, line: node.getStartLineNumber(), rule, snippet: node.getText().split('\n')[0].slice(0, 120), hint });
    };

    // ── withSync → observer ──────────────────────────────────────────────
    for (const imp of sf.getImportDeclarations()) {
      if (!ABLO_REACT.has(imp.getModuleSpecifierValue())) continue;
      const ws = imp.getNamedImports().find((n) => n.getName() === 'withSync');
      if (!ws) continue;
      ws.remove();
      if (imp.getNamedImports().length === 0 && !imp.getDefaultImport()) imp.remove();
      const hasObserver = sf.getImportDeclarations().some(
        (d) => d.getModuleSpecifierValue() === 'mobx-react-lite' && d.getNamedImports().some((n) => n.getName() === 'observer'),
      );
      if (!hasObserver) sf.addImportDeclaration({ moduleSpecifier: 'mobx-react-lite', namedImports: ['observer'] });
      for (const id of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
        if (id.getText() === 'withSync' && Node.isCallExpression(id.getParent())) {
          record(id, 'withSync→observer', 'withSync(...)', 'observer(...)');
          id.replaceWithText('observer');
        }
      }
    }

    // ── verbs + load (only on a tracked client root: <root>.<model>.<verb>) ──
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) continue;
      const method = callee.getName();
      const modelAccess = callee.getExpression();
      if (!Node.isPropertyAccessExpression(modelAccess)) continue; // need <root>.<model>.<method>
      const root = modelAccess.getExpression();
      if (!Node.isIdentifier(root) || !roots.has(root.getText())) continue;

      if (method in VERB_ARGS) {
        const next = verbRewrite(call, method);
        if (next) {
          record(call, `${method}→object-param`, call.getText().split('\n')[0].slice(0, 80), next.slice(0, 80));
          call.replaceWithText(next);
        }
      } else if (method === 'load') {
        const next = loadRewrite(call);
        if (next) {
          record(call, 'load→retrieve/list', call.getText().split('\n')[0].slice(0, 80), next.slice(0, 80));
          call.replaceWithText(next);
        }
      }
    }

    // ── manual-review flags (detect only) ────────────────────────────────
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const t = call.getExpression().getText();
      if (t === 'drizzleDataSource' && call.getArguments().length === 2 && !Node.isIdentifier(call.getArguments()[1])) {
        // (db, { tables }) shape — schema-driven form is (db, schema)
        flag(call, 'drizzleDataSource(db, tables)', 'now `drizzleDataSource(db, schema)` — pass your Ablo schema, drop the tables map.');
      }
      if (/\.claims\b/.test(t) && /^(ablo|sync)\b/.test(t)) {
        flag(call, 'ablo.claims.*', 'use `ablo.<model>.claim` (claim.state / claim.queue / `await using claim = await …claim({ id })`).');
      }
    }
    for (const jsx of sf.getDescendantsOfKind(SyntaxKind.JsxOpeningElement)) {
      if (jsx.getTagNameNode().getText() !== 'AbloProvider') continue;
      const stale = jsx.getAttributes().some((a) =>
        Node.isJsxAttribute(a) && ['schema', 'teamIds', 'authEndpoint', 'scope', 'apiKey'].includes(a.getNameNode().getText()),
      );
      if (stale) flag(jsx, '<AbloProvider> props', 'AbloProvider takes only `client` (+ userId/fallback/onError). Build `const ablo = Ablo({ schema, authEndpoint })` and pass `client={ablo}`.');
    }
  }

  // ── report ───────────────────────────────────────────────────────────
  const cwd = process.cwd();
  const rel = (f: string): string => f.replace(cwd + '/', '');
  console.log();
  if (edits.length === 0 && manual.length === 0) {
    console.log(pc.green('  ✓ Nothing to migrate — your code is already on the current API.'));
    return;
  }
  if (edits.length > 0) {
    console.log(pc.bold(`  ${write ? 'Applied' : 'Would apply'} ${edits.length} change${edits.length === 1 ? '' : 's'}:`));
    for (const e of edits) {
      console.log(`    ${pc.dim(`${rel(e.file)}:${e.line}`)}  ${pc.cyan(e.rule)}`);
      console.log(`      ${pc.red('-')} ${e.before}`);
      console.log(`      ${pc.green('+')} ${e.after}`);
    }
  }
  if (manual.length > 0) {
    console.log();
    console.log(pc.bold(pc.yellow(`  ${manual.length} spot${manual.length === 1 ? '' : 's'} need manual review (structural):`)));
    for (const m of manual) {
      console.log(`    ${pc.dim(`${rel(m.file)}:${m.line}`)}  ${pc.yellow(m.rule)}`);
      console.log(`      ${pc.dim(m.snippet)}`);
      console.log(`      → ${m.hint}`);
    }
  }
  console.log();
  if (write) {
    await project.save();
    console.log(pc.green(`  ✓ Wrote ${edits.length} change${edits.length === 1 ? '' : 's'}. Review the diff, run your typecheck.`));
  } else {
    console.log(pc.dim('  Dry run. Re-run with `--write` to apply the auto-fixes above (manual items are never auto-written).'));
  }
}
