#!/usr/bin/env bash
#
# Verify the registry-owned half of Ablo's public release boundary. GitHub can
# prove that it minted an OIDC identity, but only npm can say whether every
# package trusts that repository and workflow. Keep this check before the
# mirror push: a missing package mapping otherwise fails only after the full
# release verification and the first attempted publish.
set -euo pipefail

EXPECTED_REPOSITORY="abloatai/ablo"
EXPECTED_WORKFLOW="release.yml"
NPM_BIN="${NPM_BIN:-npm}"
PUBLIC_PACKAGES=(
  "@abloatai/transaction"
  "@abloatai/humans"
  "@abloatai/cli"
  "@abloatai/ablo"
)

if ! "$NPM_BIN" trust --help >/dev/null 2>&1; then
  echo "error: npm 11.15.0 or newer is required to inspect trusted publishers" >&2
  exit 1
fi

# npm protects trust reads with 2FA. Let its first command own the terminal so
# it can open the browser when the five-minute authorization window is absent;
# the captured audit below then runs inside that window. Non-interactive callers
# must arrive with an already-authorized npm session.
if [[ -t 0 && -t 1 ]]; then
  echo ">>> authenticating npm trust inspection"
  "$NPM_BIN" trust list "${PUBLIC_PACKAGES[0]}"
fi

failed=0
for package_name in "${PUBLIC_PACKAGES[@]}"; do
  if ! trust="$("$NPM_BIN" trust list "$package_name" 2>&1)"; then
    echo "error: could not inspect the trusted publisher for $package_name" >&2
    printf '%s\n' "$trust" >&2
    failed=1
    continue
  fi

  normalized="$(printf '%s\n' "$trust" | tr '[:upper:]' '[:lower:]')"
  if ! grep -Fqx "type: github" <<<"$normalized" ||
     ! grep -Fqx "file: $EXPECTED_WORKFLOW" <<<"$normalized" ||
     ! grep -Fqx "repository: $EXPECTED_REPOSITORY" <<<"$normalized" ||
     ! grep -Eq '^permissions: (publish(, stage publish)?|stage publish, publish)$' <<<"$normalized"; then
    echo "error: $package_name does not trust $EXPECTED_REPOSITORY/$EXPECTED_WORKFLOW for publishing" >&2
    printf '%s\n' "$trust" >&2
    echo "       repair with:" >&2
    echo "       npm trust github $package_name --repo Abloatai/ablo --file release.yml --allow-publish --allow-stage-publish --yes" >&2
    failed=1
    continue
  fi

  echo ">>> verified trusted publisher for $package_name"
done

exit "$failed"
