#!/usr/bin/env bash
# Build the WORKSPACE public mirror of github.com/Abloatai/ablo: one repo that
# publishes BOTH @abloatai/ablo (the SDK) and @abloatai/cli (the CLI) from an
# npm workspace — the Better Auth shape (core + cli in one public repo).
#
# It COMPOSES the two single-package builders rather than re-deriving their
# flatten/rewrite logic:
#   packages/sync-engine/scripts/build-public-mirror.sh  -> packages/ablo
#   packages/cli/scripts/build-cli-mirror.sh             -> packages/cli
# then relocates the Blume docs SITE to the repo root and writes the private
# workspace root. One flattener, two builders, one assembler.
#
# Layout produced (at <out>):
#   package.json          private root — { "workspaces": ["packages/*"] }, never published
#   .gitignore
#   docs/ablo/            the Blume docs SITE (repo-level; CI builds & deploys it)
#   packages/ablo/        the SDK  (@abloatai/ablo — was the mirror repo root)
#   packages/cli/         the CLI  (@abloatai/cli)
#
# Usage:
#   ./build-workspace-mirror.sh [output-dir]
# Env (passed through to the CLI builder):
#   CLI_VERSION, SDK_DEP_RANGE  — see build-cli-mirror.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"                 # packages/sync-engine
MONOREPO_ROOT="$(cd "$PKG_DIR/../.." && pwd)"
CLI_BUILDER="$MONOREPO_ROOT/packages/cli/scripts/build-cli-mirror.sh"
SDK_BUILDER="$SCRIPT_DIR/build-public-mirror.sh"
OUTPUT_DIR="${1:-$(mktemp -d)/ablo-mirror-workspace}"

PUBLIC_REPO_URL="git+https://github.com/Abloatai/ablo.git"

for b in "$SDK_BUILDER" "$CLI_BUILDER"; do
  [[ -f "$b" ]] || { echo "error: missing builder $b" >&2; exit 1; }
done

# One clean-tree guard for the whole publishable surface. The sub-builders copy
# tracked files from DISK, so an uncommitted change under any of these would
# ship to npm while staying uncommitted. (build-cli-mirror.sh re-checks its own
# two; this also covers packages/sync-engine, which the SDK builder does not.)
DIRTY="$(git -C "$MONOREPO_ROOT" status --porcelain -- packages/sync-engine packages/cli packages/transaction | grep -v '^??' || true)"
if [[ -n "$DIRTY" && "${ALLOW_DIRTY:-}" != "1" ]]; then
  echo "error: refusing to build a publish snapshot from a dirty tree." >&2
  echo "       these uncommitted tracked changes would ship to npm unreproducibly:" >&2
  echo "$DIRTY" | sed 's/^/         /' >&2
  echo "       commit or stash them, or set ALLOW_DIRTY=1 to override deliberately." >&2
  exit 1
fi

# Guard the output dir the way the sub-builders guard theirs.
if [[ "$OUTPUT_DIR" == "/" || "$OUTPUT_DIR" == "$HOME" || -z "$OUTPUT_DIR" ]]; then
  echo "Refusing to clean suspicious output dir: $OUTPUT_DIR" >&2
  exit 1
fi
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR/packages"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo ">>> building the SDK package into packages/ablo ..."
# The SDK builder wipes its own output and has no dirty-tree guard, so we've
# already guarded above; ALLOW_DIRTY keeps it from second-guessing a tree we
# vouched for.
bash "$SDK_BUILDER" "$STAGE/ablo" >/dev/null
mv "$STAGE/ablo" "$OUTPUT_DIR/packages/ablo"

echo ">>> building the CLI package into packages/cli ..."
ALLOW_DIRTY=1 CLI_VERSION="${CLI_VERSION:-}" SDK_DEP_RANGE="${SDK_DEP_RANGE:-}" \
  bash "$CLI_BUILDER" "$STAGE/cli" >/dev/null
mv "$STAGE/cli" "$OUTPUT_DIR/packages/cli"

# The SDK builder emits the Blume docs SITE at <pkg>/docs/ablo, but in the
# monorepo it is a REPO-level artifact (lives at the monorepo root, not inside
# packages/sync-engine). Lift it back to the repo root so CI's `cd docs/ablo`
# path is unchanged. The SDK's own markdown docs (docs/*.md, in its npm files
# allowlist) stay under packages/ablo.
if [[ -d "$OUTPUT_DIR/packages/ablo/docs/ablo" ]]; then
  mkdir -p "$OUTPUT_DIR/docs"
  mv "$OUTPUT_DIR/packages/ablo/docs/ablo" "$OUTPUT_DIR/docs/ablo"
fi

# Stamp repository.directory on each package so npm's source link points at the
# exact workspace folder (the SDK builder set url but no directory; the CLI
# builder likewise).
PUBLIC_REPO_URL="$PUBLIC_REPO_URL" node --input-type=module -e "
  import fs from 'node:fs';
  for (const [rel, dir] of [['packages/ablo', 'packages/ablo'], ['packages/cli', 'packages/cli']]) {
    const p = '$OUTPUT_DIR/' + rel + '/package.json';
    const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
    pkg.repository = { type: 'git', url: process.env.PUBLIC_REPO_URL, directory: dir };
    fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
  }
"

# The private workspace root. Not published (private: true); it exists only so a
# single `npm install` resolves both packages and links cli -> ablo locally.
cat > "$OUTPUT_DIR/package.json" <<'EOF'
{
  "name": "ablo-public-mirror",
  "version": "0.0.0",
  "private": true,
  "description": "Public mirror of @abloatai/ablo and @abloatai/cli — the ablo state API and its CLI.",
  "license": "Apache-2.0",
  "workspaces": [
    "packages/*"
  ],
  "scripts": {
    "build": "npm run build --workspaces --if-present"
  }
}
EOF

cat > "$OUTPUT_DIR/.gitignore" <<'EOF'
node_modules/
dist/
*.log
.DS_Store
.npmrc
EOF

# The provenance-signed release workflow. Published from GitHub Actions with
# `--provenance` + OIDC (id-token: write), it publishes every packages/* whose
# version isn't yet on npm — the version gate makes re-pushes idempotent. This
# is emitted for the FIRST cutover; ongoing `sync-mirror.sh` overlays exclude
# `.github`, so once it's in the mirror it is hand-maintained there.
mkdir -p "$OUTPUT_DIR/.github/workflows"
cat > "$OUTPUT_DIR/.github/workflows/release.yml" <<'EOF'
name: Release
# Publishes every packages/* whose version isn't yet on npm, signed with provenance.
on:
  push:
    branches: [main]
  workflow_dispatch:
concurrency:
  group: publish-${{ github.ref }}
  cancel-in-progress: false
permissions:
  contents: read
  id-token: write   # npm provenance via OIDC
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          registry-url: 'https://registry.npmjs.org'
      - run: npm install
      - run: npm run build
      - run: npm run pack:check --workspaces --if-present
      - name: Publish new versions
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
          NPM_CONFIG_PROVENANCE: 'true'
        run: |
          set -euo pipefail
          for dir in packages/*/; do
            [ -f "${dir}package.json" ] || continue
            name=$(node -p "require('./${dir}package.json').name")
            version=$(node -p "require('./${dir}package.json').version")
            private=$(node -p "require('./${dir}package.json').private === true")
            [ "$private" = "true" ] && { echo "skip private $name"; continue; }
            if npm view "$name@$version" version >/dev/null 2>&1; then
              echo "$name@$version already on npm — skip"
            else
              echo "publishing $name@$version"
              ( cd "$dir" && npm publish --access public --provenance )
            fi
          done
EOF

ABLO_V="$(node -p "require('$OUTPUT_DIR/packages/ablo/package.json').version")"
CLI_V="$(node -p "require('$OUTPUT_DIR/packages/cli/package.json').version")"
echo ""
echo "Workspace mirror built in $OUTPUT_DIR"
echo "  packages/ablo : @abloatai/ablo@$ABLO_V"
echo "  packages/cli  : @abloatai/cli@$CLI_V"
echo "  files         : $(find "$OUTPUT_DIR" -type f -not -path '*/node_modules/*' | wc -l | tr -d ' ')"
echo ""
echo "Verify, then the mirror CI publishes each package whose version is new:"
echo "  cd $OUTPUT_DIR && npm install && npm run build"
echo "  node packages/cli/dist/cli.cjs --help"
