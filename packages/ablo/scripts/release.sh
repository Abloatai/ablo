#!/usr/bin/env bash
#
# THE one and only way to release @abloatai/ablo (the public mirror of
# packages/ablo). One command, no remembering the ritual, no second path.
#
#   1. add a changeset describing the release:   npx changeset
#      (or drop a file in .changeset/ — "@abloatai/ablo": patch|minor|major)
#   2. run this:                                  bash packages/ablo/scripts/release.sh
#
# What it does, in order (fails loudly and stops at the first problem):
#   1. Preflight — clean/up-to-date main, gh auth, a clean mirror, an Ablo
#      changeset, and no unannounced public-surface removal.
#   2. `changeset version` — bumps packages/ablo version + CHANGELOG,
#      then re-snapshots the public surface at the new version.
#   3. Commits the public workspace packages + .changeset + surface snapshot
#      (any WIP in charts/apps/other packages is left untouched and unpushed).
#   4. sync-mirror.sh — builds the public snapshot, overlays it into ../ablo-mirror.
#   5. Pushes the mirror → its release.yml publishes to npm (version-gated).
#   6. Watches that run; ABORTS if the build/publish fails (no silent half-release).
#   7. Verifies npm dist-tag == the new version (retries through CDN lag).
#   8. publish-release.sh — creates the v<version> GitHub Release from the CHANGELOG.
#   9. Pushes the monorepo (the release commit only).
#
# IMPORTANT: the snapshot copies the five public workspace package trees as-is.
# Whatever is modified or untracked under packages/ablo, transaction, humans,
# agent, and cli is what ships. Get those packages into the exact release state
# before running.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONOREPO_ROOT="$(cd "$PKG_DIR/../.." && pwd)"
MIRROR_DIR="${MIRROR_DIR:-$MONOREPO_ROOT/../ablo-mirror}"
MIRROR_REPO="Abloatai/ablo"

cd "$MONOREPO_ROOT"

# ── 1. Preflight ───────────────────────────────────────────────────────────
command -v gh  >/dev/null 2>&1 || { echo "error: gh not installed" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "error: gh not authenticated (gh auth login)" >&2; exit 1; }

if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: release requires a clean monorepo worktree" >&2
  git status --short >&2
  exit 1
fi
if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "error: release must run from monorepo main" >&2
  exit 1
fi
git fetch origin main --quiet
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  echo "error: local main must exactly match origin/main before release" >&2
  exit 1
fi
if [[ ! -d "$MIRROR_DIR/.git" ]]; then
  echo ">>> cloning $MIRROR_REPO into $MIRROR_DIR"
  git clone --quiet "https://github.com/$MIRROR_REPO.git" "$MIRROR_DIR"
fi
if [[ -n "$(git -C "$MIRROR_DIR" status --porcelain)" ]]; then
  echo "error: mirror clone has uncommitted changes: $MIRROR_DIR" >&2
  git -C "$MIRROR_DIR" status --short >&2
  exit 1
fi

CHANGESET_STATUS="$(mktemp)"
trap 'rm -f "$CHANGESET_STATUS"' EXIT
npx changeset status --output "$CHANGESET_STATUS"
if ! node -e "
  const fs = require('node:fs');
  const status = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  process.exit(status.releases.some((release) => release.name === '@abloatai/ablo') ? 0 : 1);
" "$CHANGESET_STATUS"; then
  echo "error: no changeset releases @abloatai/ablo" >&2
  echo "       describe the release first: npx changeset" >&2
  exit 1
fi
# A name that shipped last release must still be here, or be here as a
# `@deprecated` alias. The guard prints how to alias it, or how to record a
# break the CHANGELOG announces. Cheaper to hear now than after npm.
node scripts/typesafety/check-public-surface.mjs

OLD_VERSION="$(node -p "require('$PKG_DIR/package.json').version")"

# ── 2. Version bump ────────────────────────────────────────────────────────
npx changeset version
NEW_VERSION="$(node -p "require('$PKG_DIR/package.json').version")"
[ "$NEW_VERSION" != "$OLD_VERSION" ] || { echo "error: version did not change ($OLD_VERSION) — was the changeset for @abloatai/ablo?" >&2; exit 1; }
echo ">>> releasing @abloatai/ablo@$NEW_VERSION  (was $OLD_VERSION)"

# The standalone workspace owns its own lockfile. Versioning changes workspace
# package manifests, so refresh the public lock before building the mirror.
bash "$SCRIPT_DIR/refresh-public-lock.sh"

# The snapshot advances only with the version, which is what makes "one release
# of overlap" need no dates: a name recorded deprecated here may be deleted in
# the release after this one, and not before.
node scripts/typesafety/check-public-surface.mjs --update

# ── 3. Commit the public workspace + changeset bookkeeping ──────────────────
git add packages/ablo packages/transaction packages/humans packages/agent \
  packages/cli docs/ablo .changeset .public-ablo package-lock.json \
  scripts/typesafety/public-surface-baseline.json
git commit -q -m "release(ablo): $NEW_VERSION"
echo ">>> committed public workspace release state"

# ── 4. Build snapshot + overlay into the mirror clone ──────────────────────
bash "$SCRIPT_DIR/sync-mirror.sh"
MIRROR_SHA="$(git -C "$MIRROR_DIR" rev-parse HEAD)"

# ── 5. Push the mirror → release.yml publishes ─────────────────────────────
git -C "$MIRROR_DIR" push origin main

# ── 6. Watch the publish run; abort on failure ─────────────────────────────
echo ">>> waiting for release.yml to publish @abloatai/ablo@${NEW_VERSION}..."
RID=""
for i in 1 2 3 4 5 6; do
  RID="$(gh run list -R "$MIRROR_REPO" --workflow=release.yml \
    --commit "$MIRROR_SHA" -L1 --json databaseId -q '.[0].databaseId')"
  [[ -n "$RID" ]] && break
  echo "    release run not visible yet ($i/6)"
  sleep 5
done
if [[ -z "$RID" ]]; then
  echo "error: no release.yml run found for mirror commit $MIRROR_SHA" >&2
  exit 1
fi
if ! gh run watch "$RID" -R "$MIRROR_REPO" --exit-status >/dev/null; then
  echo "error: release.yml run $RID FAILED — npm publish did NOT happen." >&2
  echo "       inspect: gh run view $RID -R $MIRROR_REPO --log-failed" >&2
  exit 1
fi

# ── 7. Verify npm (dist-tag is authoritative; retry through CDN lag) ────────
for i in 1 2 3 4 5 6; do
  LATEST="$(npm view "@abloatai/ablo" dist-tags.latest 2>/dev/null || true)"
  [ "$LATEST" = "$NEW_VERSION" ] && { echo ">>> npm latest = $NEW_VERSION"; break; }
  echo "    npm latest=${LATEST}, waiting for ${NEW_VERSION}... ($i/6)"; sleep 5
done
if [[ "$LATEST" != "$NEW_VERSION" ]]; then
  echo "error: npm latest stayed at ${LATEST:-<missing>}; expected $NEW_VERSION" >&2
  exit 1
fi

# ── 8. GitHub Release (notes sliced from CHANGELOG) ────────────────────────
bash "$SCRIPT_DIR/publish-release.sh" "$NEW_VERSION"

# ── 9. Push the monorepo (release commit only) ─────────────────────────────
git push origin main

echo ""
echo ">>> DONE: @abloatai/ablo@$NEW_VERSION"
echo "    npm:     https://www.npmjs.com/package/@abloatai/ablo"
echo "    release: https://github.com/$MIRROR_REPO/releases/tag/v$NEW_VERSION"
