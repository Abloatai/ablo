#!/usr/bin/env bash
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
eval "$(sed -n '/^verify_npm_versions()/,/^}/p' "$TEST_DIR/../../release.sh")"
PUBLIC_PACKAGES=("@abloatai/ablo")
pack_calls=0

npm() {
  if [[ "$1" = view ]]; then echo '0.64.3'; return; fi
  [[ "$1" = pack && "$*" = *--cache* && "$*" = *--ignore-scripts* ]] || return 2
  pack_calls=$((pack_calls + 1))
  [[ "${MISSING:-false}" != true && "$pack_calls" -gt 1 ]]
}
sleep() { :; }

# Metadata is visible immediately, but the first tarball request fails.
verify_npm_versions 0.64.3 >/dev/null
[[ "$pack_calls" = 2 ]]
if (MISSING=true verify_npm_versions 0.64.3) >/dev/null 2>&1; then
  echo 'error: visible metadata with a missing tarball was accepted' >&2
  exit 1
fi
echo 'Published download verification retries transient failures and rejects missing tarballs.'
