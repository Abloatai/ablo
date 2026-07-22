// Moved to @ablo/transaction (ADR 0013 — the settlement core extraction).
// This shim re-exports it at the original path so in-package importers of
// `wire/index.js` keep working; rewire to `@ablo/transaction/wire`
// and delete this shim once the core package is fully wired.
//
// Line comments on purpose: tsc copies a leading JSDoc block into the
// published `.d.ts`, and this note names a package npm has never heard of.
export * from '../transaction/wire/index.js';
