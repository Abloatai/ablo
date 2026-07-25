#!/usr/bin/env bash
#
# Regenerate the lockfile used by the standalone Ablo workspace.
# Run after changing a public package version or dependency.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONOREPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ALLOW_DIRTY=1 bash "$SCRIPT_DIR/build-workspace-mirror.sh" "$TMP/workspace"
(
  cd "$TMP/workspace"
  npm install --package-lock-only --ignore-scripts
)

mkdir -p "$MONOREPO_ROOT/.public-ablo"
cp "$TMP/workspace/package-lock.json" "$MONOREPO_ROOT/.public-ablo/package-lock.json"

echo "Updated .public-ablo/package-lock.json"
