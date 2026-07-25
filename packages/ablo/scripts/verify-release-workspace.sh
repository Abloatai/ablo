#!/usr/bin/env bash
#
# Verify a built public Ablo workspace. Used both before review/push and by the
# public GitHub workflow so the two release gates cannot drift.
set -euo pipefail

echo ">>> verify 1/7: production dependency audit"
npm audit --omit=dev

echo ">>> verify 2/7: build"
npm run build

echo ">>> verify 3/7: typecheck"
npm run typecheck

echo ">>> verify 4/7: tests"
npm run test

echo ">>> verify 5/7: fresh-project quickstart"
npm run test:quickstart --workspace=@abloatai/cli

echo ">>> verify 6/7: tarball and source-condition lifecycle"
npm pack --dry-run \
  --workspace=@abloatai/transaction \
  --workspace=@abloatai/humans \
  --workspace=@abloatai/ablo \
  --workspace=@abloatai/cli
npm run pack:check --workspace=@abloatai/transaction
npm run pack:check --workspace=@abloatai/humans
npm run pack:check --workspace=@abloatai/ablo

echo ">>> verify 7/7: package metadata"
npx publint --strict packages/transaction
npx publint --strict packages/humans
npx publint --strict packages/ablo
npx publint --strict packages/cli
