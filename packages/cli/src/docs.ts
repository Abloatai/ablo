/**
 * `ablo docs` — read the documentation for the version you installed.
 *
 * A docs URL always describes the newest release; a binary describes the
 * release it shipped in. That gap is not theoretical here: `get`/`getAll`/
 * `getCount` were removed in 0.35.0, so an agent working in a project pinned to
 * an earlier version reads `retrieve` on the website and writes a call its
 * installed package does not have. The pages this command prints travel in the
 * same tarball as the code, so they cannot drift from it, and they need no
 * network — the sandboxes and CI runners where agents increasingly work often
 * have none.
 *
 * Which pages exist is derived by the shared catalog rather than listed here,
 * so adding a doc makes it appear with no edit to this file.
 */

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { createRequire } from 'module';
import { join, resolve } from 'path';
import pc from 'picocolors';
import { readDocsCatalog, findDoc, suggestSlugs, type DocEntry, type DocKind } from '@abloatai/transaction/docs';
import { terminalWidth } from './terminalWidth';
import { brand } from './theme';

export const DOCS_USAGE = `
  ${brand('ablo docs')} ${pc.dim('— the documentation for the version you installed')}

    npx ablo docs                    List every page, with what it covers
    npx ablo docs <page>             Print one page as markdown
    npx ablo docs --json             The page list, machine-readable

  ${pc.dim('These pages ship inside the package, so they match your installed')}
  ${pc.dim('version and work with no network.')}
`;

/**
 * The root of the SDK install whose pages we print — the directory holding
 * `docs/` and the package's own `package.json`.
 *
 * Resolved from the project the command runs in first, so the pages are the
 * ones for the version THAT project installed — the whole promise of this
 * command. The CLI's own dependency answers when there is no project around
 * (a bare `npx ablo docs` in an empty directory).
 */
function packageRoot(): string | null {
  const contexts = [join(process.cwd(), 'package.json'), __filename];
  const markers = [
    // The SDK entry is <root>/dist/index.js.
    { request: '@abloatai/ablo', levels: 2 },
    // Compatibility markers for installs that expose the docs catalog itself.
    { request: '@abloatai/ablo/docs', levels: 3 },
    { request: '@abloatai/transaction/docs', levels: 3 },
  ] as const;
  for (const context of contexts) {
    const req = createRequire(context);
    for (const marker of markers) {
      try {
        const entry = req.resolve(marker.request);
        const root = resolve(entry, ...Array.from({ length: marker.levels }, () => '..'));
        // A transaction-only install has a docs catalog API but not the SDK's
        // shipped pages. Do not mistake its README for a complete catalog.
        if (existsSync(resolve(root, 'docs'))) return root;
      } catch {
        // Not resolvable from this context — try the next.
      }
    }
  }
  return null;
}

async function installedVersion(root: string): Promise<string | null> {
  try {
    const raw = await readFile(resolve(root, 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
      const { version } = parsed;
      return typeof version === 'string' ? version : null;
    }
    return null;
  } catch {
    return null;
  }
}

const GROUP_HEADINGS: readonly { kind: DocKind; heading: string }[] = [
  { kind: 'guide', heading: 'Guides' },
  { kind: 'example', heading: 'Examples' },
  { kind: 'package', heading: 'This package' },
];

export async function docs(args: readonly string[] = []): Promise<void> {
  const asJson = args.includes('--json');
  const reference = args.find((arg) => !arg.startsWith('-'));

  const root = packageRoot();
  const catalog = root === null ? [] : await readDocsCatalog(root);
  if (root === null || catalog.length === 0) {
    console.error(`  ${pc.red('✗')} No documentation found beside this install.`);
    console.error(
      pc.dim(
        root === null
          ? `    Install ${pc.bold('@abloatai/ablo')} in this project, or read the same pages at https://abloatai.com/docs.`
          : `    Expected it at ${pc.bold(resolve(root, 'docs'))}. Reinstall the package, or read the same pages at https://abloatai.com/docs.`,
      ),
    );
    process.exitCode = 1;
    return;
  }

  if (reference !== undefined) {
    await printPage(catalog, root, reference, asJson);
    return;
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          version: await installedVersion(root),
          pages: catalog.map(({ slug, title, description, kind }) => ({
            slug,
            title,
            description,
            kind,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  await printIndex(catalog, root);
}

async function printPage(
  catalog: readonly DocEntry[],
  root: string,
  reference: string,
  asJson: boolean,
): Promise<void> {
  const page = findDoc(catalog, reference);
  if (!page) {
    console.error(`  ${pc.red('✗')} No page called ${pc.bold(reference)}.`);
    const near = suggestSlugs(catalog, reference);
    if (near.length > 0) {
      console.error(pc.dim(`    Closest: ${near.map((slug) => pc.bold(slug)).join(', ')}`));
    }
    console.error(pc.dim(`    Run ${pc.bold('npx ablo docs')} for the full list.`));
    process.exitCode = 1;
    return;
  }

  const body = await readFile(page.path, 'utf8');

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          version: await installedVersion(root),
          slug: page.slug,
          title: page.title,
          description: page.description,
          kind: page.kind,
          body,
        },
        null,
        2,
      ),
    );
    return;
  }

  // Raw markdown, unstyled: the reader is usually an agent piping this
  // somewhere, and ANSI escapes in the middle of a code fence are noise it has
  // to strip before it can use the page.
  console.log(body);
}

async function printIndex(catalog: readonly DocEntry[], root: string): Promise<void> {
  const version = await installedVersion(root);
  console.log();
  console.log(
    `  ${brand('ablo')} ${pc.dim(version ? `docs for the version you installed (${version})` : 'docs for the version you installed')}`,
  );
  console.log();

  const width = Math.max(...catalog.map((entry) => entry.slug.length));
  const available = Math.max(40, terminalWidth(100) - width - 8);

  for (const { kind, heading } of GROUP_HEADINGS) {
    const pages = catalog.filter((entry) => entry.kind === kind);
    if (pages.length === 0) continue;
    console.log(`  ${pc.bold(heading)}`);
    for (const page of pages) {
      const summary = page.description || page.title;
      console.log(`    ${page.slug.padEnd(width)}  ${pc.dim(truncate(summary, available))}`);
    }
    console.log();
  }

  console.log(pc.dim(`  Read one with ${pc.bold('npx ablo docs <page>')} — prints markdown, no network needed.`));
  console.log();
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1).trimEnd()}…`;
}
