import { defineConfig } from 'tsup';

/**
 * Bundles the `ablo` CLI into a single self-contained `dist/cli.js` — the
 * `bin` of the published `@abloatai/ablo` package. The goal is a Stripe-style
 * self-contained executable: every CLI-owned dependency is inlined so the
 * published package's runtime `dependencies` stay empty and a pure-library
 * consumer (`import Ablo from '@abloatai/ablo'`) never pulls in `ts-morph`,
 * `@clack/prompts`, etc.
 *
 * Externalized (NOT bundled) — resolved at runtime from the right place:
 *   - `@abloatai/ablo` / `@abloatai/ablo` (+ subpaths): the package's own
 *     code. The mirror rewrites the former to the latter; both resolve to the
 *     installed package itself (Node package self-reference), so bundling them
 *     would just duplicate the engine into cli.js.
 *   - `@prisma/client`, `drizzle-orm` (+ subpaths): the customer's ORM. `ablo
 *     pull --prisma` / `pull drizzle` run inside the customer's project and
 *     must load THEIR generated client / schema from THEIR node_modules.
 *
 * Everything else (`@clack/prompts`, `picocolors`, `postgres`, `ts-morph`,
 * `jiti`) is inlined into cli.js.
 */
export default defineConfig({
  entry: { cli: 'src/cli/index.ts' },
  // CJS, not ESM. ts-morph bundles a CommonJS `typescript` that does dynamic
  // `require("fs")` at runtime — esbuild's ESM output can't satisfy that
  // ("Dynamic require of X is not supported"). A CJS bundle handles it
  // natively, and Node >=24 (the package's `engines`) can `require()` the
  // externalized ESM SDK (@abloatai/ablo) without ERR_REQUIRE_ESM. Output is
  // `dist/cli.cjs` — a `.cjs` file is unambiguously CommonJS even though the
  // package is `"type": "module"`.
  format: ['cjs'],
  outDir: 'dist',
  target: 'node24',
  platform: 'node',
  // Inline everything by default; only the specifiers below stay external.
  noExternal: [/.*/],
  external: [
    /^@ablo\/sync-engine(\/.*)?$/,
    /^@abloatai\/ablo(\/.*)?$/,
    /^@prisma\/client(\/.*)?$/,
    /^drizzle-orm(\/.*)?$/,
  ],
  // No banner shebang: src/cli/index.ts already starts with `#!/usr/bin/env
  // node`, which esbuild hoists to the top of the bundle. Adding a banner too
  // produces a duplicate shebang on line 2 (a syntax error).
  clean: false, // the lib `tsc` build owns dist/; don't wipe it
  dts: false,
  sourcemap: false,
  shims: false,
});
