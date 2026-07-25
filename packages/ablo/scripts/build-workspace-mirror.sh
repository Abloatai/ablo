#!/usr/bin/env bash
# Build the standalone github.com/Abloatai/ablo workspace.
#
# The public repository deliberately preserves the monorepo ownership map:
#   packages/ablo         branded SDK users install
#   packages/transaction  authoritative HTTP/contracts core
#   packages/humans       reactive/WebSocket materializer
#   packages/agent        agent behavior
#   packages/cli          scaffolding and operations
#   packages/tsconfig     private shared compiler configuration
#
# No source flattening or generated compatibility package is involved.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONOREPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OUTPUT_DIR="${1:-$(mktemp -d)/ablo-public-workspace}"
PACKAGES=(transaction humans agent ablo cli tsconfig)

if [[ "$OUTPUT_DIR" == "/" || "$OUTPUT_DIR" == "$HOME" || -z "$OUTPUT_DIR" ]]; then
  echo "Refusing to clean suspicious output dir: $OUTPUT_DIR" >&2
  exit 1
fi

DIRTY="$(git -C "$MONOREPO_ROOT" status --porcelain -- \
  packages/ablo packages/transaction packages/humans packages/agent packages/cli \
  docs/ablo | grep -v '^??' || true)"
if [[ -n "$DIRTY" && "${ALLOW_DIRTY:-}" != "1" ]]; then
  echo "error: refusing to build a public snapshot from a dirty tree" >&2
  echo "$DIRTY" | sed 's/^/  /' >&2
  echo "Commit the release state or set ALLOW_DIRTY=1 for local validation." >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR/packages" "$OUTPUT_DIR/docs"

copy_tree() {
  local source_prefix="$1"
  local destination_prefix="$2"
  git -C "$MONOREPO_ROOT" ls-files --cached --others --exclude-standard "$source_prefix" |
    while IFS= read -r source; do
      [[ -z "$source" ]] && continue
      [[ ! -f "$MONOREPO_ROOT/$source" ]] && continue
      case "$source" in
        */node_modules/*|*/dist/*|*/.turbo/*|*.tgz|*.log) continue ;;
      esac
      local relative_path="${source#"$source_prefix"/}"
      local destination="$OUTPUT_DIR/$destination_prefix/$relative_path"
      mkdir -p "$(dirname "$destination")"
      cp "$MONOREPO_ROOT/$source" "$destination"
    done
}

for package_name in "${PACKAGES[@]}"; do
  copy_tree "packages/$package_name" "packages/$package_name"
done
copy_tree "docs/ablo" "docs/ablo"

# Repository-level branding belongs at the public workspace root as well as in
# the npm package. This is a monorepo landing page, not a flattened source tree.
cp "$OUTPUT_DIR/packages/ablo/README.md" "$OUTPUT_DIR/README.md"
cp "$OUTPUT_DIR/packages/ablo/CHANGELOG.md" "$OUTPUT_DIR/CHANGELOG.md"
cp "$OUTPUT_DIR/packages/ablo/LICENSE" "$OUTPUT_DIR/LICENSE"
cp "$OUTPUT_DIR/packages/ablo/NOTICE" "$OUTPUT_DIR/NOTICE"
mkdir -p "$OUTPUT_DIR/assets"
cp "$OUTPUT_DIR/packages/ablo/assets/banner.png" "$OUTPUT_DIR/assets/banner.png"

cat > "$OUTPUT_DIR/package.json" <<'EOF'
{
  "name": "ablo-public-workspace",
  "version": "0.0.0",
  "private": true,
  "description": "Public source for the Ablo SDK, live client, agent runtime, and CLI.",
  "license": "Apache-2.0",
  "workspaces": ["packages/*"],
  "scripts": {
    "build": "npm run build --workspace=@abloatai/transaction && npm run build --workspace=@abloatai/humans && npm run build --workspace=@ablo/agent && npm run build --workspace=@abloatai/cli && npm run build --workspace=@abloatai/ablo",
    "typecheck": "npm run typecheck --workspace=@abloatai/transaction && npm run typecheck --workspace=@abloatai/humans && npm run typecheck --workspace=@ablo/agent && npm run typecheck --workspace=@abloatai/cli && npm run typecheck --workspace=@abloatai/ablo",
    "test": "npm test --workspaces --if-present"
  }
}
EOF

PUBLIC_LOCKFILE="$MONOREPO_ROOT/.public-ablo/package-lock.json"
if [[ ! -f "$PUBLIC_LOCKFILE" ]]; then
  echo "error: missing public workspace lockfile: $PUBLIC_LOCKFILE" >&2
  echo "       run packages/ablo/scripts/refresh-public-lock.sh" >&2
  exit 1
fi
cp "$PUBLIC_LOCKFILE" "$OUTPUT_DIR/package-lock.json"

cat > "$OUTPUT_DIR/.gitignore" <<'EOF'
node_modules/
dist/
.turbo/
*.log
.DS_Store
.npmrc
EOF

mkdir -p "$OUTPUT_DIR/.github/workflows"
cat > "$OUTPUT_DIR/.github/workflows/release.yml" <<'EOF'
name: Release
on:
  push:
    branches: [main]
  workflow_dispatch:
concurrency:
  group: publish-${{ github.ref }}
  cancel-in-progress: false
permissions:
  contents: read
  id-token: write
jobs:
  verify-and-publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 24.18.0
          registry-url: https://registry.npmjs.org
          cache: npm
      - run: npm ci
      - name: Verify release workspace
        run: bash packages/ablo/scripts/verify-release-workspace.sh
      - name: Publish unpublished package versions
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
          NPM_CONFIG_PROVENANCE: "true"
        run: |
          set -euo pipefail
          for package_name in transaction humans agent cli ablo tsconfig; do
            dir="packages/$package_name"
            name=$(node -p "require('./$dir/package.json').name")
            version=$(node -p "require('./$dir/package.json').version")
            private=$(node -p "require('./$dir/package.json').private === true")
            [ "$private" = "true" ] && continue
            if npm view "$name@$version" version >/dev/null 2>&1; then
              echo "$name@$version already published"
            else
              (cd "$dir" && npm publish --access public --provenance)
            fi
          done
EOF

cat > "$OUTPUT_DIR/.github/workflows/deploy-docs.yml" <<'EOF'
name: Deploy docs
on:
  push:
    branches: [main]
    paths: ["docs/ablo/**"]
  workflow_dispatch:
concurrency:
  group: deploy-docs
  cancel-in-progress: true
permissions:
  contents: read
jobs:
  deploy:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: docs/ablo
    env:
      VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
      VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
      VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 24.18.0
          cache: npm
          cache-dependency-path: docs/ablo/package-lock.json
      - name: Deployment not configured
        if: env.VERCEL_TOKEN == '' || env.VERCEL_ORG_ID == '' || env.VERCEL_PROJECT_ID == ''
        run: echo "::warning::Docs deployment is waiting for the Vercel repository secrets."
      - if: env.VERCEL_TOKEN != '' && env.VERCEL_ORG_ID != '' && env.VERCEL_PROJECT_ID != ''
        run: npm install --global vercel@latest
      - if: env.VERCEL_TOKEN != '' && env.VERCEL_ORG_ID != '' && env.VERCEL_PROJECT_ID != ''
        run: vercel pull --yes --environment=production --token="$VERCEL_TOKEN"
      - if: env.VERCEL_TOKEN != '' && env.VERCEL_ORG_ID != '' && env.VERCEL_PROJECT_ID != ''
        run: vercel build --prod --token="$VERCEL_TOKEN"
      - if: env.VERCEL_TOKEN != '' && env.VERCEL_ORG_ID != '' && env.VERCEL_PROJECT_ID != ''
        run: vercel deploy --prebuilt --prod --token="$VERCEL_TOKEN"
EOF

echo "Public Ablo workspace built in $OUTPUT_DIR"
for package_name in "${PACKAGES[@]}"; do
  node -e "const p=require('$OUTPUT_DIR/packages/$package_name/package.json'); console.log('  '+p.name+'@'+p.version)"
done
