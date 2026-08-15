#!/usr/bin/env bash
#
# The only Ablo release entrypoint. Releases have an explicit review boundary:
#
#   bash packages/ablo/scripts/release.sh prepare
#   # Review ../ablo-mirror/packages/ablo/README.md and CHANGELOG.md.
#   bash packages/ablo/scripts/release.sh publish
#   bash packages/ablo/scripts/release.sh publish-manual
#
# `prepare` versions and validates the exact public mirror without pushing it.
# `publish` resumes that reviewed state, pushes once, waits for GitHub, verifies
# every public npm package, creates the GitHub Release, and pushes the monorepo.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONOREPO_ROOT="$(cd "$PKG_DIR/../.." && pwd)"
MIRROR_DIR="${MIRROR_DIR:-$MONOREPO_ROOT/../ablo-mirror}"
MIRROR_REPO="Abloatai/ablo"
PUBLIC_PACKAGES=(
  "@abloatai/transaction"
  "@abloatai/humans"
  "@abloatai/cli"
  "@abloatai/ablo"
)

usage() {
  cat <<'EOF'
Usage:
  bash packages/ablo/scripts/release.sh prepare
  bash packages/ablo/scripts/release.sh publish
  bash packages/ablo/scripts/release.sh publish-manual
  bash packages/ablo/scripts/release.sh publish-local [otp]

prepare  Version, commit, build, and fully validate the public mirror locally.
         Nothing is pushed. Review the rendered README and release notes.

publish  Publish the already-prepared state through GitHub Actions, verify npm,
         create the GitHub Release, and push the monorepo release commit.

publish-manual
         Same outcome without GitHub Actions. Run it in an interactive terminal;
         npm may ask you to press Enter, authenticate in the browser, and touch
         your security key. No numeric OTP is required. A manual publish carries
         no npm provenance attestation, and one cannot be added afterwards.

publish-local [otp]
         Compatibility alias for publish-manual. The optional numeric OTP is
         retained for maintainers who use an authenticator app.
EOF
}

require_clean_main() {
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "error: release requires a clean monorepo worktree" >&2
    git status --short >&2
    exit 1
  fi
  if [[ "$(git branch --show-current)" != "main" ]]; then
    echo "error: release must run from monorepo main" >&2
    exit 1
  fi
}

ensure_mirror() {
  if [[ ! -d "$MIRROR_DIR/.git" ]]; then
    echo ">>> cloning $MIRROR_REPO into $MIRROR_DIR"
    git clone --quiet "https://github.com/$MIRROR_REPO.git" "$MIRROR_DIR"
  fi
  if [[ -n "$(git -C "$MIRROR_DIR" status --porcelain)" ]]; then
    echo "error: mirror clone has uncommitted changes: $MIRROR_DIR" >&2
    git -C "$MIRROR_DIR" status --short >&2
    exit 1
  fi
}

release_version() {
  node -p "require('$PKG_DIR/package.json').version"
}

find_release_run() {
  local mirror_sha="$1"
  local run_id=""
  for attempt in 1 2 3 4 5 6; do
    run_id="$(release_run_for_commit "$mirror_sha")"
    [[ -n "$run_id" ]] && break
    echo "    release run not visible yet ($attempt/6)" >&2
    sleep 5
  done
  printf '%s' "$run_id"
}

release_run_for_commit() {
  local mirror_sha="$1"
  gh run list -R "$MIRROR_REPO" --workflow=release.yml \
    --commit "$mirror_sha" -L1 --json databaseId -q '.[0].databaseId'
}

verify_npm_versions() {
  local version="$1"
  local package_name
  local published
  for package_name in "${PUBLIC_PACKAGES[@]}"; do
    published=""
    for attempt in 1 2 3 4 5 6; do
      published="$(npm view "$package_name@$version" version 2>/dev/null || true)"
      [[ "$published" = "$version" ]] && break
      echo "    $package_name=${published:-<missing>}, waiting for $version ($attempt/6)"
      sleep 5
    done
    if [[ "$published" != "$version" ]]; then
      echo "error: $package_name@$version was not visible on npm" >&2
      exit 1
    fi
    echo ">>> verified $package_name@$version"
  done
}

prepare_release() {
  require_clean_main
  ensure_mirror

  echo ">>> prepare 1/5: checking branch, origin, auth, and changeset"
  command -v gh >/dev/null 2>&1 || { echo "error: gh not installed" >&2; exit 1; }
  gh auth status >/dev/null 2>&1 || { echo "error: gh not authenticated" >&2; exit 1; }
  git fetch origin main --quiet
  if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
    echo "error: local main must exactly match origin/main before prepare" >&2
    exit 1
  fi

  local changeset_status
  changeset_status="$(mktemp)"
  npx changeset status --output "$changeset_status"
  if ! node -e "
    const fs = require('node:fs');
    const status = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    process.exit(status.releases.some((release) => release.name === '@abloatai/ablo') ? 0 : 1);
  " "$changeset_status"; then
    rm -f "$changeset_status"
    echo "error: no changeset releases @abloatai/ablo" >&2
    exit 1
  fi
  rm -f "$changeset_status"
  node scripts/typesafety/check-public-surface.mjs

  echo ">>> prepare 2/5: versioning the fixed public package group"
  local old_version
  local new_version
  old_version="$(release_version)"
  npx changeset version
  new_version="$(release_version)"
  if [[ "$new_version" = "$old_version" ]]; then
    echo "error: version did not change from $old_version" >&2
    exit 1
  fi
  node "$SCRIPT_DIR/finalize-release-notes.mjs" "$new_version"
  # Derive the published docs from the changelog this release just finalised.
  # Must follow finalize-release-notes, which writes the version's body; the
  # generator reads CHANGELOG.md and emits docs/ablo/docs/changelog/<version>.mdx.
  # Nothing called it, so the docs site silently stopped at 0.44.0 while three
  # further releases shipped — the derived-doc rule holds only if the derivation
  # actually runs, and the release is the one moment it is guaranteed to matter.
  npm run build:docs --workspace=@abloatai/ablo
  npm run generate:openapi --workspace=@abloatai/ablo
  bash "$SCRIPT_DIR/refresh-public-lock.sh"
  node scripts/typesafety/check-public-surface.mjs --update

  echo ">>> prepare 3/5: committing the release candidate"
  git add packages/ablo packages/transaction packages/humans packages/agent \
    packages/cli docs/ablo .changeset .public-ablo package-lock.json \
    scripts/typesafety/public-surface-baseline.json
  git commit -q -m "release(ablo): $new_version"

  echo ">>> prepare 4/5: building the exact public mirror"
  bash "$SCRIPT_DIR/sync-mirror.sh"

  echo ">>> prepare 5/5: running the same verification used by GitHub"
  (
    cd "$MIRROR_DIR"
    npm ci
    bash packages/ablo/scripts/verify-release-workspace.sh
  )
  if [[ -n "$(git -C "$MIRROR_DIR" status --porcelain)" ]]; then
    echo "error: local release verification changed the mirror" >&2
    git -C "$MIRROR_DIR" status --short >&2
    exit 1
  fi

  echo ""
  echo ">>> PREPARED: @abloatai/ablo@$new_version"
  echo "    Nothing has been pushed."
  echo "    Review README:       $MIRROR_DIR/packages/ablo/README.md"
  echo "    Review release notes: $MIRROR_DIR/packages/ablo/CHANGELOG.md"
  echo ""
  echo "    Publish after review:"
  echo "    bash packages/ablo/scripts/release.sh publish"
}

publish_release() {
  require_clean_main
  ensure_mirror

  echo ">>> publish 1/5: validating the prepared state"
  command -v gh >/dev/null 2>&1 || { echo "error: gh not installed" >&2; exit 1; }
  gh auth status >/dev/null 2>&1 || { echo "error: gh not authenticated" >&2; exit 1; }
  git fetch origin main --quiet
  git -C "$MIRROR_DIR" fetch origin main --quiet

  local behind
  local ahead
  read -r behind ahead < <(git rev-list --left-right --count origin/main...HEAD)
  if [[ "$behind" != "0" || "$ahead" = "0" ]]; then
    echo "error: publish requires a prepared local release commit ahead of origin/main" >&2
    exit 1
  fi

  local version
  local mirror_version
  local mirror_sha
  version="$(release_version)"
  mirror_version="$(node -p "require('$MIRROR_DIR/packages/ablo/package.json').version")"
  mirror_sha="$(git -C "$MIRROR_DIR" rev-parse HEAD)"
  if [[ "$mirror_version" != "$version" ]]; then
    echo "error: monorepo version $version and mirror version $mirror_version differ" >&2
    exit 1
  fi
  if [[ "$(git log -1 --format=%s)" != "release(ablo): $version" ]]; then
    echo "error: HEAD is not the prepared release commit for $version" >&2
    exit 1
  fi

  echo ">>> publish 2/5: pushing reviewed mirror $mirror_sha"
  if [[ "$(git -C "$MIRROR_DIR" rev-parse origin/main)" != "$mirror_sha" ]]; then
    git -C "$MIRROR_DIR" push origin main
  else
    echo "    mirror commit is already on origin"
  fi

  local already_published
  already_published="$(npm view "@abloatai/ablo@$version" version 2>/dev/null || true)"
  if [[ "$already_published" != "$version" ]]; then
    echo ">>> publish 3/5: waiting for GitHub verification and npm publishing"
    local run_id
    local conclusion
    run_id="$(release_run_for_commit "$mirror_sha")"
    if [[ -z "$run_id" ]]; then
      echo "    dispatching release workflow for reviewed mirror"
      gh workflow run release.yml -R "$MIRROR_REPO" --ref main
      run_id="$(find_release_run "$mirror_sha")"
    fi
    if [[ -z "$run_id" ]]; then
      echo "error: no release.yml run found for mirror commit $mirror_sha" >&2
      exit 1
    fi
    conclusion="$(gh run view "$run_id" -R "$MIRROR_REPO" --json conclusion -q .conclusion)"
    if [[ "$conclusion" = "failure" ]]; then
      echo "    resuming failed workflow $run_id"
      gh run rerun "$run_id" -R "$MIRROR_REPO" --failed
    elif [[ "$conclusion" = "cancelled" ]]; then
      echo "    resuming cancelled workflow $run_id"
      gh run rerun "$run_id" -R "$MIRROR_REPO"
    fi
    gh run watch "$run_id" -R "$MIRROR_REPO" --exit-status
  else
    echo ">>> publish 3/5: npm already contains @abloatai/ablo@$version"
  fi

  echo ">>> publish 4/5: verifying npm and creating the GitHub Release"
  verify_npm_versions "$version"
  bash "$SCRIPT_DIR/publish-release.sh" "$version" "$mirror_sha"

  echo ">>> publish 5/5: pushing the monorepo release commit"
  if [[ "$(git rev-parse origin/main)" != "$(git rev-parse HEAD)" ]]; then
    git push origin main
  else
    echo "    monorepo release commit is already on origin"
  fi

  echo ""
  echo ">>> DONE: @abloatai/ablo@$version"
  echo "    npm:     https://www.npmjs.com/package/@abloatai/ablo"
  echo "    release: https://github.com/$MIRROR_REPO/releases/tag/v$version"
}

# Does the mirror still equal a snapshot of the CURRENT tree? `prepare` builds the
# mirror at the moment it runs, so any commit landing afterwards leaves the public
# artifact stale while the monorepo looks perfectly correct. 0.49.0 came within one
# command of publishing that way: two later fixes touched published packages, so the
# prepared mirror held an SDK that differed from the server already in production.
#
# This replaces asking whether HEAD's subject reads `release(ablo): x.y.z`. That
# check is a proxy, and it fails in both directions: it blocks a legitimate publish
# once any commit lands on top, and it passes a stale mirror so long as the subject
# matches. The property worth enforcing is that what ships equals what was built.
require_mirror_matches_tip() {
  local tmp drift
  tmp="$(mktemp -d)"
  bash "$SCRIPT_DIR/build-workspace-mirror.sh" "$tmp/snapshot" >/dev/null
  drift="$(diff -rq \
    --exclude '.git' --exclude 'node_modules' --exclude 'dist' \
    --exclude '.turbo' --exclude '*.tgz' \
    "$tmp/snapshot" "$MIRROR_DIR" 2>&1 || true)"
  rm -rf "$tmp"
  if [[ -n "$drift" ]]; then
    echo "error: the mirror is not a snapshot of the current tree" >&2
    printf '%s\n' "$drift" | head -20 >&2
    echo "" >&2
    echo "       A path present only in the mirror is usually a file the verification" >&2
    echo "       run left behind, and deleting it is enough. Anything else means" >&2
    echo "       commits landed after the mirror was built, so publishing now would" >&2
    echo "       ship a public artifact missing them: re-run prepare." >&2
    exit 1
  fi
}

publish_local() {
  local otp="${1:-}"
  require_clean_main
  ensure_mirror

  if [[ -z "$otp" && ! -t 0 ]]; then
    echo "error: manual publishing needs an interactive terminal" >&2
    echo "       npm opens a browser challenge for your security key." >&2
    echo "       run: bash packages/ablo/scripts/release.sh publish-manual" >&2
    exit 1
  fi

  echo ">>> publish-local 1/5: validating the prepared state"
  command -v gh >/dev/null 2>&1 || { echo "error: gh not installed" >&2; exit 1; }
  gh auth status >/dev/null 2>&1 || { echo "error: gh not authenticated" >&2; exit 1; }

  local version mirror_version mirror_sha
  version="$(release_version)"
  mirror_version="$(node -p "require('$MIRROR_DIR/packages/ablo/package.json').version")"
  if [[ "$mirror_version" != "$version" ]]; then
    echo "error: monorepo version $version and mirror version $mirror_version differ" >&2
    echo "       run prepare before publishing" >&2
    exit 1
  fi
  require_mirror_matches_tip
  echo "    mirror matches the current tree at $version"

  echo ">>> publish-local 2/5: pushing the reviewed mirror"
  git -C "$MIRROR_DIR" fetch origin main --quiet
  mirror_sha="$(git -C "$MIRROR_DIR" rev-parse HEAD)"
  if [[ "$(git -C "$MIRROR_DIR" rev-parse origin/main)" != "$mirror_sha" ]]; then
    git -C "$MIRROR_DIR" push origin main
  else
    echo "    mirror commit is already on origin"
  fi

  # Publishing runs INSIDE the mirror, against the same script release.yml runs,
  # so the local path cannot drift from the CI one.
  echo ">>> publish-local 3/5: publishing to npm from the mirror"
  if [[ -z "$otp" ]]; then
    echo "    npm may pause for each unpublished package. Press Enter to open"
    echo "    its authentication page, then approve with your security key."
  fi
  if [[ -n "$otp" ]]; then
    (cd "$MIRROR_DIR" && bash packages/ablo/scripts/publish-packages.sh --local --otp "$otp")
  else
    (cd "$MIRROR_DIR" && bash packages/ablo/scripts/publish-packages.sh --local)
  fi

  echo ">>> publish-local 4/5: creating the GitHub Release"
  verify_npm_versions "$version"
  bash "$SCRIPT_DIR/publish-release.sh" "$version" "$mirror_sha"

  echo ">>> publish-local 5/5: pushing the monorepo release commit"
  if [[ "$(git rev-parse origin/main)" != "$(git rev-parse HEAD)" ]]; then
    git push origin main
  else
    echo "    monorepo release commit is already on origin"
  fi

  echo ""
  echo ">>> DONE: @abloatai/ablo@$version (published locally, no provenance)"
  echo "    npm:     https://www.npmjs.com/package/@abloatai/ablo"
  echo "    release: https://github.com/$MIRROR_REPO/releases/tag/v$version"
}

cd "$MONOREPO_ROOT"

case "${1:-}" in
  prepare) prepare_release ;;
  publish) publish_release ;;
  publish-manual) publish_local ;;
  publish-local) publish_local "${2:-}" ;;
  -h|--help|help) usage ;;
  *)
    usage >&2
    exit 2
    ;;
esac
