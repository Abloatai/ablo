#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" = "trust" && "${2:-}" = "--help" ]]; then
  exit 0
fi

if [[ "${1:-}" != "trust" || "${2:-}" != "list" ]]; then
  echo "unexpected fake npm command: $*" >&2
  exit 2
fi

package_name="${3:-}"
if [[ "${FAKE_TRUST_MODE:-valid}" = "missing" && "$package_name" = "@abloatai/humans" ]]; then
  echo "No trust configurations found for package ($package_name)"
  exit 0
fi

repository="Abloatai/ablo"
if [[ "${FAKE_TRUST_MODE:-valid}" = "wrong-repository" && "$package_name" = "@abloatai/cli" ]]; then
  repository="someone/else"
fi

echo "type: github"
echo "id: test-publisher"
echo "file: release.yml"
echo "repository: $repository"
echo "permissions: publish, stage publish"
