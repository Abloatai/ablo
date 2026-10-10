# Dependency security maintenance

Audit both the root lockfile and `docs/ablo/package-lock.json`, plus manifests
outside those workspaces. Next.js in
`packages/cli/evals/fixtures/scattered-task-writes/package.json` belongs to an
evaluation fixture, not the Ablo platform server or published SDK.

## Temporary constraints

<!-- Ponytail: the esbuild override covers 0.27.x consumers only and is verified
against the current tsup build. Remove it when tsup supports a patched esbuild
range, then regenerate the lockfile and rerun the CLI build and quickstart. -->

The root `esbuild@^0.27.0` override selects 0.28.1 because tsup 8.5.1 still
requires `^0.27.0`, whose available releases have no fix for
[GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr).
The advisory concerns the Windows development server; the checked-in tsup
configuration builds the CLI rather than serving a directory. The override
leaves the CLI's separate 0.25.x dependency unchanged. Build tooling remains
in scope even when deployed SDK code does not exercise the vulnerable path.

The docs manifest already pins transitive dependencies through overrides.
`@astrojs/node` 11.1.3 supports the existing Astro 7.2.8 version. `devalue` needs
5.9.3, not just 5.9.2, to cover
[shared-memory serialization](https://github.com/advisories/GHSA-j22f-vq7h-c4qm)
and the other advisories patched in that release. Recheck registry advisories
before choosing versions; historical scanner recommendations can lag.

Blume generates a config that imports `@astrojs/mdx` directly from the docs
project. Declare that integration explicitly so a clean install works even
when npm nests Blume's transitive copy. Its version remains 7.0.3.

The checked-in docs config defaults to static output without a server adapter.
Confirm that in the build report rather than inferring production exposure
from a lockfile's runtime classification. Blume also brings HTTP, MCP,
rendering and build dependencies; those remain worth patching. A local build
does not prove what is currently deployed.

The CLI uses ts-morph 28, whose maintained glob implementation removes the
vulnerable braces dependency rather than overriding it to a nonexistent patch.
The existing upgrade-rewrite checks verify the AST API remains compatible.

The docs override selects http-cache-semantics 4.3.0 for
[GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp).
The docs also constrain KaTeX, proxy-addr, postcss-selector-parser, smol-toml
and source-map-js to verified patched releases. A fresh advisory check is
required even when an earlier audit was clean. Blume remains pinned to the
existing 1.0.4 generator: newer releases require a separate js-yaml 5 migration
and fail with the current js-yaml 4 override.

## Remaining finding

The October 6 root audit still reports
[GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)
in sprintf-js 1.1.3, reached through Jest reporting/configuration dependencies.
No patched sprintf-js release was published when checked. The affected path is
development tooling; CI input exposure and treatment require review. No risk
acceptance, scanner dismissal or zero-findings claim is recorded.

## Verification

Use Node 24 and the checked-in lockfiles (`lobby setup` runs both installs):

```sh
npm ci
npm ci --prefix docs/ablo
npm audit --package-lock-only
npm audit --package-lock-only --prefix docs/ablo
npm audit --package-lock-only --prefix examples/account-multiplayer
npm run build
npm run typecheck
npm test
npm run test:browser-bundle --workspace=@abloatai/ablo
npm run test:quickstart --workspace=@abloatai/cli
npm run build --prefix docs/ablo
```

Resolve and audit the evaluation fixture in a temporary directory rather than
adding its dependencies to the SDK workspace. Run the additional packaging
checks in `packages/ablo/scripts/verify-release-workspace.sh` before publication.
Do not enable the quickstart's live push tier for dependency verification.

A clean audit describes the checked source tree and advisory data at scan
time. An unmerged PR does not prove production remediation or closure in an
external compliance scanner.
