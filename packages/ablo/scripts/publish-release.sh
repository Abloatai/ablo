#!/usr/bin/env bash
#
# Create a customer-facing GitHub Release (with notes) on the public mirror
# (github.com/Abloatai/ablo) for a published @abloatai/ablo version.
#
# The public mirror workflow publishes npm packages first. This script then
# slices the matching section from the package CHANGELOG and creates the GitHub
# release against that already-published mirror commit.
#
# RITUAL (normally called by release.sh after the mirror workflow succeeds):
#   1. confirm the mirror workflow published @abloatai/ablo
#   2. packages/ablo/scripts/publish-release.sh [version] [target]
#
# `version` defaults to the current packages/ablo/package.json version.
# `target` defaults to the public repository's current `main`. Pass the exact
# mirror commit when backfilling an older release.
# Tag convention: v<version> (e.g. v0.6.0).
#
# Requires: `gh` authenticated with write access to Abloatai/ablo.
set -euo pipefail

MIRROR_REPO="Abloatai/ablo"
PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHANGELOG="$PKG_DIR/CHANGELOG.md"

VERSION="${1:-$(node -p "require('$PKG_DIR/package.json').version")}"
TARGET="${2:-main}"
TAG="v$VERSION"

# Extract the `## <VERSION>` section, up to (not including) the next `## ` heading.
NOTES="$(awk -v ver="## $VERSION" '
  $0 == ver { grab = 1; next }
  /^## / && grab { exit }
  grab { print }
' "$CHANGELOG")"

if [ -z "${NOTES//[$'\n\t ']/}" ]; then
  echo "error: no CHANGELOG section found for '## $VERSION' in $CHANGELOG" >&2
  echo "       (did the version land in the changelog yet?)" >&2
  exit 1
fi

# Release creation is idempotent so a publish interrupted after this point can
# be resumed safely.
if gh release view "$TAG" --repo "$MIRROR_REPO" >/dev/null 2>&1; then
  echo "Release $TAG already exists on $MIRROR_REPO."
  echo "Done: https://github.com/$MIRROR_REPO/releases/tag/$TAG"
  exit 0
fi

# Sanity: warn (don't block) if the version isn't on npm yet — release notes for
# an unpublished version are usually premature.
if command -v npm >/dev/null 2>&1; then
  PUBLISHED="$(npm view "@abloatai/ablo@$VERSION" version 2>/dev/null || true)"
  if [ "$PUBLISHED" != "$VERSION" ]; then
    echo "warning: @abloatai/ablo@$VERSION is not on npm yet — usually you npm publish first." >&2
  fi
fi

echo "Creating release $TAG on $MIRROR_REPO (notes sliced from CHANGELOG)..."
printf '%s\n' "$NOTES" | gh release create "$TAG" \
  --repo "$MIRROR_REPO" \
  --target "$TARGET" \
  --title "$TAG" \
  --notes-file -

echo "Done: https://github.com/$MIRROR_REPO/releases/tag/$TAG"
