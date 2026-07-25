/**
 * Programmatic access to the documentation this package ships.
 *
 * The docs travel in the npm tarball beside the code they describe, so a reader
 * that resolves them through here is reading the pages for the version actually
 * installed — not whatever the website is serving today. That is the whole
 * point of the subpath: a published version is frozen, its docs are frozen with
 * it, and the canonical `get` contract cannot drift behind a pinned dependency.
 */

export {
  readDocsCatalog,
  findDoc,
  parseDocHeader,
  suggestSlugs,
  type DocEntry,
  type DocKind,
} from './catalog.js';
