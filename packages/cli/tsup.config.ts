import { defineConfig } from 'tsup';

const embeddedDsn = process.env.ABLO_CLI_SENTRY_DSN ?? '';
const embeddedRelease =
  process.env.ABLO_CLI_RELEASE ?? `@abloatai/cli@${process.env.npm_package_version ?? 'development'}`;
const embeddedVersion = process.env.npm_package_version ?? 'development';

/**
 * Bundles the `ablo` CLI into a single self-contained `dist/cli.cjs` — this
 * package's `bin`. The goal is a Stripe-style self-contained executable:
 * every CLI-owned tool is inlined so the published runtime `dependencies`
 * stay lean, and the SDK package ships no CLI bundle at all.
 *
 * Externalized (NOT bundled) — resolved at runtime from the right place:
 *   - `@abloatai/transaction` / `@abloatai/ablo` (+ subpaths): the SDK. The
 *     mirror rewrites the former to the latter; at runtime it resolves from
 *     the project being worked in (or this package's own dependency), so
 *     bundling it would duplicate the engine into cli.cjs.
 *   - `@abloatai/transaction` (+ subpaths): external here as a declared
 *     dependency; the mirror snapshot flattens it into the source tree, so
 *     the published bundle inlines it.
 *   - `@prisma/client`, `drizzle-orm` (+ subpaths): the customer's ORM. `ablo
 *     pull --prisma` / `pull drizzle` run inside the customer's project and
 *     must load THEIR generated client / schema from THEIR node_modules.
 *
 * Everything else (`@clack/prompts`, `picocolors`, `postgres`, `ts-morph`)
 * is inlined into cli.cjs.
 */
export default defineConfig({
  entry: { cli: 'src/index.ts' },
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
  // Bundling split = the package.json split (tsup's default): runtime
  // `dependencies` stay EXTERNAL (resolved from the installed package),
  // `devDependencies` (@clack/prompts, picocolors, postgres, ts-morph, …)
  // get INLINED into cli.cjs so the published dependency list stays lean.
  //
  // Do NOT bring back `noExternal: [/.*/]` — it OVERRIDES `external` for any
  // resolvable specifier (the prisma/drizzle entries below only ever worked
  // because they aren't installed here). It force-inlined jiti, whose
  // `lazyTransform` requires `../dist/babel.cjs` relative to its own install
  // dir at runtime — unrelocatable by design — so `ablo dev`/`push` crashed
  // with MODULE_NOT_FOUND on every fresh project. jiti is a declared runtime
  // dependency instead, the way every jiti consumer (Nuxt, Tailwind) ships it.
  external: [
    /^@ablo\/transaction(\/.*)?$/,
    /^@abloatai\/ablo(\/.*)?$/,
    /^@prisma\/client(\/.*)?$/,
    /^drizzle-orm(\/.*)?$/,
  ],
  // No banner shebang: src/index.ts already starts with `#!/usr/bin/env
  // node`, which esbuild hoists to the top of the bundle. Adding a banner too
  // produces a duplicate shebang on line 2 (a syntax error).
  clean: true, // tsup is the only writer of this package's dist/
  dts: false,
  sourcemap: false,
  // REQUIRED: jiti (inlined above, used by `loadSchema` to import the user's
  // TS schema) reads `import.meta.url` internally. In a CJS bundle without
  // shims that expression compiles to `undefined`, and jiti's lazyTransform
  // crashes with `createRequire(undefined)` — `ablo dev`/`push` die on every
  // fresh project. `shims: true` injects a `__filename`-based shim.
  shims: true,
  // Sentry DSNs are ingestion coordinates, not credentials. Embedding the
  // public DSN is how browser and desktop SDKs ship enabled telemetry. The
  // prepublishOnly gate refuses to publish when the release job omitted it.
  define: {
    'process.env.ABLO_CLI_EMBEDDED_SENTRY_DSN': JSON.stringify(embeddedDsn),
    'process.env.ABLO_CLI_EMBEDDED_RELEASE': JSON.stringify(embeddedRelease),
    'process.env.ABLO_CLI_EMBEDDED_VERSION': JSON.stringify(embeddedVersion),
  },
});
