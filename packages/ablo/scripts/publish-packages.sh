#!/usr/bin/env bash
#
# Publish the public package group from a built public workspace. This is the
# ONE definition of what publishing does; run from the workspace root.
#
#   bash packages/ablo/scripts/publish-packages.sh            # CI: with provenance
#   bash packages/ablo/scripts/publish-packages.sh --local    # browser/security-key auth
#   bash packages/ablo/scripts/publish-packages.sh --local --otp 123456
#
# The mirror's release.yml calls this, and so does `release.sh publish-local`
# when GitHub Actions cannot run. Both paths therefore agree on publish order,
# on which packages are skipped, and on every precondition below. When this
# lived only inside release.yml, each outage rediscovered those preconditions
# one failed publish at a time.
#
# Order is dependency order: a consumer must never resolve before its
# dependency exists on the registry.
set -euo pipefail

PACKAGE_ORDER=(transaction humans agent cli ablo tsconfig)
PUBLIC_NAMES=(@abloatai/transaction @abloatai/humans @abloatai/cli @abloatai/ablo)
MIRROR_REPO="Abloatai/ablo"

PROVENANCE=1
OTP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --local) PROVENANCE=0; shift ;;
    --otp) OTP="$2"; shift 2 ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Identify the workspace by name, not by shape. The monorepo also has a
# package.json and a packages/ablo, so a shape check passes there and would
# publish the unreviewed monorepo tree instead of the built public snapshot.
WORKSPACE="$(node -p "require('./package.json').name" 2>/dev/null || true)"
if [ "$WORKSPACE" != "ablo-public-workspace" ]; then
  echo "error: run this from the root of the built public workspace" >&2
  echo "       found '${WORKSPACE:-no package.json}', expected 'ablo-public-workspace'" >&2
  echo "       publishing anywhere else ships a tree nobody reviewed." >&2
  exit 1
fi

VERSION="$(node -p "require('./packages/ablo/package.json').version")"

# ── Preconditions ───────────────────────────────────────────────────────
# Each of these failed a real release in a way that pointed somewhere else.

# Trusted publishing does not create an npm session: npm exchanges GitHub's
# short-lived OIDC identity only when `npm publish` runs, and `npm whoami` cannot
# test that relationship. Assert that Actions exposed the identity endpoint;
# npm will then validate each package's configured trust at the publish boundary.
# The local recovery path still needs an interactive npm session.
if [ "$PROVENANCE" = "1" ]; then
  if [ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] || [ -z "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]; then
    echo "error: GitHub Actions did not provide an OIDC identity" >&2
    echo "       release.yml needs permissions: id-token: write." >&2
    exit 1
  fi
elif ! npm whoami >/dev/null 2>&1; then
  echo "error: not authenticated to the npm registry" >&2
  echo "       run \`npm login\`, complete its browser/security-key challenge," >&2
  echo "       then run the manual release again." >&2
  exit 1
fi

# `prepack` builds each package with tsc from the workspace's own node_modules.
# sync-mirror overlays with `rsync --delete`, so a re-synced mirror can have no
# install at all and the first publish dies with `sh: tsc: command not found`
# after its own `clean` has already removed dist.
if [ ! -x node_modules/.bin/tsc ]; then
  echo ">>> installing workspace dependencies (no tsc found)"
  npm ci
fi

# @abloatai/cli's prepublishOnly refuses to ship without this. It is a public
# ingestion DSN that the build embeds, not a credential, which is why it lives
# in a repository variable and can be read back here.
if [ -z "${ABLO_CLI_SENTRY_DSN:-}" ]; then
  if command -v gh >/dev/null 2>&1; then
    echo ">>> resolving ABLO_CLI_SENTRY_DSN from $MIRROR_REPO"
    ABLO_CLI_SENTRY_DSN="$(gh variable list -R "$MIRROR_REPO" \
      --json name,value -q '.[] | select(.name=="ABLO_CLI_SENTRY_DSN") | .value' 2>/dev/null || true)"
    export ABLO_CLI_SENTRY_DSN
  fi
fi
if [ -z "${ABLO_CLI_SENTRY_DSN:-}" ]; then
  echo "error: ABLO_CLI_SENTRY_DSN is unset and could not be resolved" >&2
  echo "       read it with: gh variable list -R $MIRROR_REPO" >&2
  echo "       @abloatai/cli refuses to publish without it." >&2
  exit 1
fi

# Provenance needs an OIDC token from a supported CI provider. Locally npm fails
# with 'Automatic provenance generation not supported for provider: null', and
# dropping the flag is not enough: publishConfig.provenance is true in three of
# the four packages. npm >=9 gives CLI flags precedence over publishConfig, so
# --no-provenance is what actually turns it off.
if [ "$PROVENANCE" = "1" ]; then
  PROVENANCE_FLAG="--provenance"
else
  PROVENANCE_FLAG="--no-provenance"
  echo ">>> publishing WITHOUT provenance — this version will carry no npm"
  echo "    attestation, and it cannot be added after the fact."
fi

# ── Publish ─────────────────────────────────────────────────────────────
# Skipping versions already on the registry makes this resumable, which matters
# when a 2FA code expires partway through.
for package_name in "${PACKAGE_ORDER[@]}"; do
  dir="packages/$package_name"
  name=$(node -p "require('./$dir/package.json').name")
  version=$(node -p "require('./$dir/package.json').version")
  private=$(node -p "require('./$dir/package.json').private === true")
  [ "$private" = "true" ] && continue
  if npm view "$name@$version" version >/dev/null 2>&1; then
    echo "$name@$version already published"
  else
    echo ">>> publishing $name@$version"
    if [ -n "$OTP" ]; then
      (cd "$dir" && npm publish --access public "$PROVENANCE_FLAG" --otp "$OTP")
    else
      (cd "$dir" && npm publish --access public "$PROVENANCE_FLAG")
    fi
  fi
done

# ── Verify ──────────────────────────────────────────────────────────────
# The registry read path is CDN-cached, so the package published last is the one
# most likely to read back as the previous version. A single read here reports a
# false failure on a release that actually succeeded.
echo ""
echo ">>> verifying npm"
for name in "${PUBLIC_NAMES[@]}"; do
  published=""
  for attempt in 1 2 3 4 5 6; do
    published="$(npm view "$name@$VERSION" version 2>/dev/null || true)"
    [ "$published" = "$VERSION" ] && break
    echo "    $name=${published:-<missing>}, waiting for $VERSION ($attempt/6)"
    sleep 5
  done
  if [ "$published" != "$VERSION" ]; then
    echo "error: $name did not reach $VERSION on npm" >&2
    exit 1
  fi
  echo "    $name $VERSION"
done

echo ""
echo ">>> published @abloatai/ablo@$VERSION"
