#!/usr/bin/env bash
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERIFY_SCRIPT="$TEST_DIR/../verify-trusted-publishers.sh"
FAKE_NPM="$TEST_DIR/fake-npm.sh"

NPM_BIN="$FAKE_NPM" bash "$VERIFY_SCRIPT" >/dev/null

if FAKE_TRUST_MODE=missing NPM_BIN="$FAKE_NPM" bash "$VERIFY_SCRIPT" >/dev/null 2>&1; then
  echo "error: missing package trust was accepted" >&2
  exit 1
fi

if FAKE_TRUST_MODE=wrong-repository NPM_BIN="$FAKE_NPM" bash "$VERIFY_SCRIPT" >/dev/null 2>&1; then
  echo "error: a mismatched trusted repository was accepted" >&2
  exit 1
fi

echo ">>> trusted-publisher preflight tests passed"
