#!/usr/bin/env bash
#
# Create a customer-facing GitHub Release (with notes) on the public mirror
# (github.com/Abloatai/ablo) for a published @abloatai/ablo version.
#
# WHY: we publish @abloatai/ablo inline (manual `npm publish`), not via CI, so
# tagging + release notes have to be part of that manual ritual rather than a
# workflow hook. This slices the matching section out of the package CHANGELOG
# and posts it as the release body, tagging the mirror's current `main` — which
# the sync-engine-mirror workflow has already synced to this version's snapshot.
#
# RITUAL (run after the changes for a version have landed on main + mirrored):
#   1. npm publish the @abloatai/ablo tarball (existing inline step)
#   2. packages/sync-engine/scripts/publish-release.sh [version]
#
# `version` defaults to the current packages/sync-engine/package.json version.
# Tag convention: v<version> (e.g. v0.6.0).
#
# Requires: `gh` authenticated with write access to Abloatai/ablo.
set -euo pipefail

MIRROR_REPO="Abloatai/ablo"
PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHANGELOG="$PKG_DIR/CHANGELOG.md"

VERSION="${1:-$(node -p "require('$PKG_DIR/package.json').version")}"
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

# Don't double-create a release for a tag that already exists.
if gh release view "$TAG" --repo "$MIRROR_REPO" >/dev/null 2>&1; then
  echo "error: release $TAG already exists on $MIRROR_REPO" >&2
  exit 1
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
  --target main \
  --title "$TAG" \
  --notes-file -

echo "Done: https://github.com/$MIRROR_REPO/releases/tag/$TAG"
