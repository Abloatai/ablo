/**
 * The docs catalog is read by three surfaces — `ablo docs`, the public
 * `/api/docs/*` routes, and the MCP docs tools — so these assert the properties
 * those surfaces depend on against the REAL package directory, not a fixture.
 * A fixture would pin the parser to itself and let the corpus drift away from
 * it, which is the failure this module was written to end.
 */

import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readDocsCatalog, findDoc, parseDocHeader, suggestSlugs } from '@abloatai/transaction/docs/catalog';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('docs catalog', () => {
  it('catalogs every shipped guide, example, and root file', async () => {
    const catalog = await readDocsCatalog(PACKAGE_ROOT);

    expect(catalog.filter((e) => e.kind === 'guide').length).toBeGreaterThan(20);
    expect(catalog.filter((e) => e.kind === 'example').length).toBeGreaterThan(4);
    expect(catalog.filter((e) => e.kind === 'package').map((e) => e.slug).sort()).toEqual([
      'AGENTS.md',
      'README.md',
      'llms.txt',
    ]);
  });

  // The public routes serve whatever this returns, so an internal note reaching
  // the catalog is a disclosure, not a cosmetic bug.
  it('excludes docs/internal — the only guard keeping internal notes off the public routes', async () => {
    const catalog = await readDocsCatalog(PACKAGE_ROOT);

    expect(catalog.some((e) => e.path.includes(`docs${sep}internal`))).toBe(false);
    expect(findDoc(catalog, 'structure')).toBeNull();
    expect(findDoc(catalog, 'docs/internal/structure.md')).toBeNull();
  });

  // `docs/agents.md` (a published guide) and `AGENTS.md` (the install playbook)
  // both want the name "agents". Whichever lost would be silently unreachable.
  it('gives every page a unique slug', async () => {
    const catalog = await readDocsCatalog(PACKAGE_ROOT);
    const slugs = catalog.map((e) => e.slug);

    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('derives title and description from each page rather than a maintained list', async () => {
    const catalog = await readDocsCatalog(PACKAGE_ROOT);
    const coordination = findDoc(catalog, 'coordination');

    expect(coordination?.title).toBe('Coordination Reference');
    expect(coordination?.description).toMatch(/^Claim mechanics/);
    expect(catalog.filter((e) => e.kind !== 'package').every((e) => e.description !== '')).toBe(
      true
    );
  });

  describe('findDoc', () => {
    it('resolves slugs, aliases, and path forms to the same pages the URLs promised', async () => {
      const catalog = await readDocsCatalog(PACKAGE_ROOT);
      const slugOf = (ref: string): string | null => findDoc(catalog, ref)?.slug ?? null;

      expect(slugOf('coordination')).toBe('coordination');
      expect(slugOf('examples/nextjs')).toBe('examples/nextjs');
      expect(slugOf('docs/coordination.md')).toBe('coordination');
      expect(slugOf('storage')).toBe('data-sources'); // pre-catalog rename
      expect(slugOf('overview')).toBe('README.md');
      expect(slugOf('readme')).toBe('README.md');
      expect(slugOf('llms')).toBe('llms.txt');
    });

    it('keeps the guide and the install playbook apart', async () => {
      const catalog = await readDocsCatalog(PACKAGE_ROOT);

      expect(findDoc(catalog, 'agents')?.kind).toBe('guide');
      expect(findDoc(catalog, 'docs/agents.md')?.kind).toBe('guide');
      expect(findDoc(catalog, 'AGENTS.md')?.kind).toBe('package');
      expect(findDoc(catalog, 'agents.md')?.kind).toBe('package');
    });

    it('returns null for an unknown reference instead of throwing', async () => {
      const catalog = await readDocsCatalog(PACKAGE_ROOT);

      expect(findDoc(catalog, 'nope')).toBeNull();
      expect(findDoc(catalog, '')).toBeNull();
    });
  });

  it('reports an empty catalog rather than throwing when there are no docs', async () => {
    await expect(readDocsCatalog(resolve(PACKAGE_ROOT, 'does-not-exist'))).resolves.toEqual([]);
  });

  describe('parseDocHeader', () => {
    it('lifts the H1 and the promise blockquote', () => {
      expect(parseDocHeader('# Title\n\n> The promise.\n\nBody.\n')).toEqual({
        title: 'Title',
        description: 'The promise.',
      });
    });

    it('joins a multi-line promise into one line', () => {
      expect(parseDocHeader('# T\n\n> One\n> two.\n\nBody.\n').description).toBe('One two.');
    });

    it('reports what a page has when it lacks the convention', () => {
      expect(parseDocHeader('Just prose.\n')).toEqual({ title: null, description: '' });
      expect(parseDocHeader('# Only a title\n\nBody.\n').description).toBe('');
    });

    // A blockquote further down the page is not the page's promise.
    it('ignores a blockquote that does not directly follow the H1', () => {
      expect(parseDocHeader('# T\n\nProse first.\n\n> A pull quote.\n').description).toBe('');
    });
  });

  describe('suggestSlugs', () => {
    it('names the intended page after a typo', async () => {
      const catalog = await readDocsCatalog(PACKAGE_ROOT);

      expect(suggestSlugs(catalog, 'coordinaton')).toContain('coordination');
      expect(suggestSlugs(catalog, 'quickstar')).toContain('quickstart');
    });

    it('stays quiet when nothing is close', async () => {
      const catalog = await readDocsCatalog(PACKAGE_ROOT);

      expect(suggestSlugs(catalog, 'zzzzzz')).toEqual([]);
    });
  });
});
