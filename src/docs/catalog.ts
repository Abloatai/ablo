/**
 * The catalog of documentation this package ships.
 *
 * One definition of *which docs exist*, read from the files themselves. Every
 * reader — `ablo docs`, the public `/api/docs/*` routes, the MCP docs tools —
 * resolves through here rather than keeping its own list, because a
 * hand-maintained index of a directory is a copy that drifts the moment a page
 * is added and nothing fails when it does. Before this module the public web
 * allowlist had fallen 21 pages behind the corpus, including `coordination`.
 *
 * Title and description are DERIVED from each file's own convention: an H1,
 * then a one-paragraph blockquote stating what the page is for. That blockquote
 * is the description everywhere it is needed — the site frontmatter lifts the
 * same line — so a page states its own promise exactly once, in the source that
 * ships in the npm tarball and still reads correctly as plain markdown.
 *
 * The published set mirrors the tarball's `files` globs (`docs/*.md`,
 * `docs/examples/*.md`, plus the three root files). Anything else under `docs/`
 * — `docs/internal/**` above all — is neither shipped nor catalogued, and that
 * exclusion is the only thing keeping internal notes off the public routes now
 * that they read from here.
 */

import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

/** Where a page sits in the corpus, and how a reader should group it. */
export type DocKind = 'guide' | 'example' | 'package';

/** One documentation page, as shipped. */
export interface DocEntry {
  /** Stable reference: `quickstart`, `examples/nextjs`, `agents`. */
  readonly slug: string;
  /** Human-readable title — the file's H1, or curated for the root files. */
  readonly title: string;
  /** One line stating what the page is for — the file's promise blockquote. */
  readonly description: string;
  readonly kind: DocKind;
  /** Absolute path on disk. */
  readonly path: string;
  readonly mime: string;
}

const MARKDOWN_MIME = 'text/markdown; charset=utf-8';
const TEXT_MIME = 'text/plain; charset=utf-8';

/**
 * The three files that document the package itself rather than a topic. They
 * live at the package root, not under `docs/`, and none follows the H1 +
 * blockquote convention — `llms.txt` opens with a prose paragraph and
 * `README.md` with a banner — so their titles and descriptions are curated
 * here, the one place that knows they are a different kind of artifact.
 *
 * Their slug is their filename, because the filename IS how these are referred
 * to everywhere (`AGENTS.md` is an ecosystem convention, not a topic name) and
 * because a bare word would collide: `docs/agents.md` is a published guide that
 * the docs index cross-links as `agents`, and whichever of the two won that
 * name would silently shadow the other. Friendlier spellings are aliases below.
 */
const PACKAGE_FILES: ReadonlyArray<{
  readonly filename: string;
  readonly title: string;
  readonly description: string;
  readonly mime: string;
}> = [
  {
    filename: 'AGENTS.md',
    title: 'AGENTS.md',
    description:
      'The playbook a coding agent follows to install and drive Ablo without hanging on a prompt.',
    mime: MARKDOWN_MIME,
  },
  {
    filename: 'README.md',
    title: 'README',
    description: 'Package overview — what Ablo is and the shape of the API.',
    mime: MARKDOWN_MIME,
  },
  {
    filename: 'llms.txt',
    title: 'llms.txt',
    description: 'The curated single-file index of the whole API, for machine readers.',
    mime: TEXT_MIME,
  },
];

/**
 * Curated redirects for references that are not a slug: the friendly spellings
 * of the root files, plus the renames the public URLs carried before this
 * module existed, kept so old links and any agent working from a cached page
 * still resolve. Identity mappings are NOT listed — a slug resolves to itself
 * by derivation, and restating the other 30 here would rebuild the
 * hand-maintained list this module exists to delete.
 */
const SLUG_ALIASES: Readonly<Record<string, string>> = {
  readme: 'README.md',
  overview: 'README.md',
  llms: 'llms.txt',
  storage: 'data-sources',
  'docs/storage.md': 'data-sources',
};

/**
 * Read the catalog from a package root — the directory holding `docs/` and the
 * three root files.
 *
 * The root is a parameter rather than resolved here because each reader knows
 * it differently and they are genuinely different facts: the CLI resolves it
 * against its own bundle inside `node_modules`, while the web app resolves it
 * against the monorepo checkout. Nothing is cached; callers that serve many
 * requests should memoize the returned array.
 */
export async function readDocsCatalog(packageRoot: string): Promise<DocEntry[]> {
  const docsDir = join(packageRoot, 'docs');
  const entries: DocEntry[] = [];

  entries.push(...(await readDocsDirectory(docsDir, 'guide')));
  entries.push(...(await readDocsDirectory(join(docsDir, 'examples'), 'example')));

  for (const file of PACKAGE_FILES) {
    const path = join(packageRoot, file.filename);
    const body = await readFileOrNull(path);
    if (body === null) continue;
    entries.push({
      slug: file.filename,
      title: file.title,
      description: file.description,
      kind: 'package',
      path,
      mime: file.mime,
    });
  }

  return entries.sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Read one flat directory of markdown. Deliberately non-recursive: the shipped
 * set is `docs/*.md` plus `docs/examples/*.md`, so descending would catalogue
 * `docs/internal/**` — notes that are not in the tarball and must not reach a
 * public route.
 */
async function readDocsDirectory(dir: string, kind: DocKind): Promise<DocEntry[]> {
  let names: string[];
  try {
    const found = await readdir(dir, { withFileTypes: true });
    names = found.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name);
  } catch {
    return [];
  }

  const entries: DocEntry[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const body = await readFileOrNull(path);
    if (body === null) continue;
    const stem = basename(name, '.md');
    const { title, description } = parseDocHeader(body);
    entries.push({
      slug: kind === 'example' ? `examples/${stem}` : stem,
      title: title ?? stem,
      description,
      kind,
      path,
      mime: MARKDOWN_MIME,
    });
  }
  return entries;
}

/**
 * Pull a page's title and promise line out of its markdown.
 *
 * The convention every page follows: an H1, then a blockquote paragraph saying
 * what the page is for. A page missing either simply reports what it has — the
 * catalog never invents prose.
 */
export function parseDocHeader(body: string): {
  readonly title: string | null;
  readonly description: string;
} {
  const heading = body.match(/^#[ \t]+(.+?)[ \t]*$/m);
  const title = heading?.[1] ?? null;

  const afterHeading = heading?.index === undefined ? body : body.slice(heading.index + heading[0].length);
  const promise = afterHeading.match(/^\s*\n((?:>.*\n)+)/);
  const description =
    promise?.[1]
      ?.split('\n')
      .filter(Boolean)
      .map((line) => line.replace(/^>\s?/, ''))
      .join(' ')
      .trim() ?? '';

  return { title, description };
}

/**
 * Resolve a reference to a page. Accepts the slug (`coordination`), a curated
 * alias (`storage`), or a repo-relative path (`docs/coordination.md`,
 * `AGENTS.md`) — the three forms readers actually arrive with. Returns null
 * rather than throwing so a caller can render its own not-found.
 */
export function findDoc(catalog: readonly DocEntry[], reference: string): DocEntry | null {
  const trimmed = reference.trim();
  if (trimmed === '') return null;

  const direct = matchSlug(catalog, trimmed);
  if (direct) return direct;

  const aliased = SLUG_ALIASES[trimmed.toLowerCase()];
  if (aliased) {
    const target = matchSlug(catalog, aliased);
    if (target) return target;
  }

  // Path form: `docs/coordination.md`, `docs/examples/nextjs.md`, `llms.txt`.
  const asSlug = trimmed
    .replace(/^\.?\//, '')
    .replace(/^docs\//, '')
    .replace(/\.(md|txt)$/i, '');
  return matchSlug(catalog, asSlug);
}

function matchSlug(catalog: readonly DocEntry[], slug: string): DocEntry | null {
  const needle = slug.toLowerCase();
  return catalog.find((entry) => entry.slug.toLowerCase() === needle) ?? null;
}

/**
 * Slugs closest to a miss, for a "did you mean" line. Ranks by shared prefix,
 * then substring containment — enough to catch a typo or a half-remembered
 * name without pulling in a distance library.
 */
export function suggestSlugs(
  catalog: readonly DocEntry[],
  reference: string,
  limit = 3
): string[] {
  const needle = reference.trim().toLowerCase();
  if (needle === '') return [];

  return catalog
    .map((entry) => {
      const slug = entry.slug.toLowerCase();
      let score = 0;
      if (slug.includes(needle) || needle.includes(slug)) score += 10;
      score += sharedPrefixLength(slug, needle);
      return { slug: entry.slug, score };
    })
    .filter(({ score }) => score > 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ slug }) => slug);
}

function sharedPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i += 1;
  return i;
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}
