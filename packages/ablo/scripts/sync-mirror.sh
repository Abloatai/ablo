#!/usr/bin/env bash
#
# Sync the built public snapshot into your local github.com/Abloatai/ablo clone,
# in ONE step. Builds the snapshot to a throwaway dir, then overlays it onto the
# clone without touching its `.git`. The generated `.github/release.yml` is part
# of the snapshot, so the verified workspace and its publishing workflow move
# together.
#
# It does NOT push. Pushing is the one deliberate, reversible-by-you action:
#   bash packages/ablo/scripts/sync-mirror.sh
#   (cd ../ablo-mirror && git push origin main)   # release.yml publishes if the version is new
#
# The clone location defaults to a sibling `../ablo-mirror`; override with
# `MIRROR_DIR=/path/to/clone bash …/sync-mirror.sh`.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONOREPO_ROOT="$(cd "$PKG_DIR/../.." && pwd)"
MIRROR_DIR="${MIRROR_DIR:-$MONOREPO_ROOT/../ablo-mirror}"

if [ ! -d "$MIRROR_DIR/.git" ]; then
  echo "error: no git clone at $MIRROR_DIR" >&2
  echo "       clone the mirror there first:  git clone https://github.com/Abloatai/ablo.git \"$MIRROR_DIR\"" >&2
  echo "       (or set MIRROR_DIR=/path/to/your/clone)" >&2
  exit 1
fi
if [[ -n "$(git -C "$MIRROR_DIR" status --porcelain)" ]]; then
  echo "error: refusing to overwrite a dirty mirror clone: $MIRROR_DIR" >&2
  git -C "$MIRROR_DIR" status --short >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 1. Build the public workspace into a throwaway dir (never the clone — the
#    builder replaces its output directory, which would destroy the clone).
bash "$SCRIPT_DIR/build-workspace-mirror.sh" "$TMP/snapshot"

# 2. Reset the clone to the published main, then overlay the snapshot. `--delete`
#    drops files no longer in the workspace; `.git` alone stays untouched.
git -C "$MIRROR_DIR" fetch origin main --quiet
git -C "$MIRROR_DIR" checkout main --quiet 2>/dev/null || git -C "$MIRROR_DIR" checkout -B main origin/main --quiet
git -C "$MIRROR_DIR" reset --hard origin/main --quiet
rsync -a --delete --exclude '.git' "$TMP/snapshot/" "$MIRROR_DIR/"

# 3. Commit if anything changed. The version gate lives in the mirror's
#    release.yml, so a normal commit publishes only when the version is new.
VERSION="$(node -p "require('$PKG_DIR/package.json').version")"
git -C "$MIRROR_DIR" add -A
if git -C "$MIRROR_DIR" diff --cached --quiet; then
  echo "Mirror already matches @abloatai/ablo@$VERSION — nothing to sync."
  exit 0
fi
git -C "$MIRROR_DIR" commit -m "release: @abloatai/ablo@$VERSION" --quiet

echo "Synced @abloatai/ablo@$VERSION into $MIRROR_DIR"
echo "To publish:  (cd \"$MIRROR_DIR\" && git push origin main)"
