#!/usr/bin/env bash
#
# Verify a built public Ablo workspace. Used both before review/push and by the
# public GitHub workflow so the two release gates cannot drift.
set -euo pipefail

echo ">>> verify 1/8: production dependency audit"
npm audit --omit=dev

echo ">>> verify 2/8: build"
npm run build

echo ">>> verify 3/8: typecheck"
npm run typecheck

echo ">>> verify 4/8: tests"
npm run test

echo ">>> verify 5/8: fresh-project quickstart"
npm run test:quickstart --workspace=@abloatai/cli

echo ">>> verify 6/8: tarball and source-condition lifecycle"
npm pack --dry-run \
  --workspace=@abloatai/transaction \
  --workspace=@abloatai/humans \
  --workspace=@abloatai/ablo \
  --workspace=@abloatai/cli
npm run pack:check --workspace=@abloatai/transaction
npm run pack:check --workspace=@abloatai/humans
npm run pack:check --workspace=@abloatai/ablo

echo ">>> verify 7/8: package metadata"
npx publint --strict packages/transaction
npx publint --strict packages/humans
npx publint --strict packages/ablo
npx publint --strict packages/cli

echo ">>> verify 8/8: release authentication"
RELEASE_WORKFLOW=".github/workflows/release.yml"
grep -q 'id-token: write' "$RELEASE_WORKFLOW"
if grep -Eq 'NPM_TOKEN|NODE_AUTH_TOKEN' "$RELEASE_WORKFLOW"; then
  echo "error: release workflow contains a long-lived npm credential" >&2
  exit 1
fi
