// Jest's resolver does not follow custom export conditions, so a suite that
// must run against this package's TypeScript source needs its subpath map
// spelled out. `package.json` already states that map once, under the
// `@ablo/source` condition; this module projects it into jest's
// `moduleNameMapper` shape rather than restating it.
//
// A hand-listed copy is what this replaces. It went stale the moment a subpath
// moved and nothing failed until a suite could not resolve an import — the
// three configs that carried the list had already drifted apart from each
// other before any of them broke.
//
// Targets are absolute and resolved from this file, so a caller says only that
// it wants the map. Nothing outside this package restates where its source
// lives, and moving the package moves the map with it.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { name, exports: subpaths } = require('./package.json');
const packageRoot = dirname(fileURLToPath(import.meta.url));

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Projects the package's `@ablo/source` exports into jest module-name mappings.
 *
 * @returns {Record<string, string>} mappings, exact subpaths before patterns.
 */
export function transactionSourceModuleMapper() {
  const exact = {};
  const patterns = {};

  for (const [subpath, conditions] of Object.entries(subpaths)) {
    const source = conditions['@ablo/source'];
    if (typeof source !== 'string') continue;

    // './claims/*' -> '/claims/*'; '.' addresses the package root.
    const specifier = subpath === '.' ? '' : subpath.slice(1);
    // './src/claims/*.ts' -> '/abs/packages/transaction/src/claims/*.ts'
    const target = resolve(packageRoot, source);
    const star = specifier.indexOf('*');

    if (star === -1) {
      exact[`^${escapeRegExp(name + specifier)}$`] = target;
      continue;
    }

    const head = escapeRegExp(name + specifier.slice(0, star));
    const tail = escapeRegExp(specifier.slice(star + 1));
    patterns[`^${head}(.*)${tail}$`] = target.replace('*', '$1');
  }

  return { ...exact, ...patterns };
}
