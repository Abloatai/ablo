#!/usr/bin/env bash
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$TEST_DIR/../verify-npm-versions.sh"
TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

for kind in correct wrong-name wrong-version; do
  mkdir -p "$TEST_TMP/$kind/package"
  name='@abloatai/ablo'
  version='0.64.3'
  [[ "$kind" != wrong-name ]] || name='@abloatai/wrong'
  [[ "$kind" != wrong-version ]] || version='9.9.9'
  printf '{"name":"%s","version":"%s"}\n' "$name" "$version" >"$TEST_TMP/$kind/package/package.json"
  tar -czf "$TEST_TMP/$kind.tgz" -C "$TEST_TMP/$kind" package
done

next_call() {
  local value=0
  [[ ! -f "$TEST_TMP/$1" ]] || read -r value <"$TEST_TMP/$1"
  value=$((value + 1))
  printf '%s\n' "$value" >"$TEST_TMP/$1"
  printf '%s' "$value"
}

npm() {
  local call destination previous argument
  case "$1" in
    view)
      call="$(next_call views)"
      if [[ "$MODE" = missing || ( "$MODE" = transient && "$call" -le 8 ) ]]; then
        echo 'npm error code E404' >&2
        return 1
      fi
      if [[ "$MODE" = wrong-metadata ]]; then echo '9.9.9'; else echo '0.64.3'; fi
      ;;
    pack)
      [[ "$*" = *--cache* && "$*" = *--ignore-scripts* && "$*" = *--prefer-online* ]] || return 2
      call="$(next_call packs)"
      if [[ "$MODE" = integrity ]]; then echo 'npm error code EINTEGRITY' >&2; return 1; fi
      if [[ "$MODE" = missing-tarball || ( "$MODE" = transient && "$call" = 1 ) ]]; then
        echo 'npm error code E404' >&2
        return 1
      fi
      destination=''
      previous=''
      for argument in "$@"; do
        [[ "$previous" != --pack-destination ]] || destination="$argument"
        previous="$argument"
      done
      [[ -n "$destination" ]] || return 2
      case "$MODE" in
        wrong-name|wrong-version) cp "$TEST_TMP/$MODE.tgz" "$destination/package.tgz" ;;
        *) cp "$TEST_TMP/correct.tgz" "$destination/package.tgz" ;;
      esac
      ;;
    *) echo 'verification must never publish' >&2; return 2 ;;
  esac
}
sleep() { :; }

check() {
  rm -f "$TEST_TMP/views" "$TEST_TMP/packs"
  MODE="$1" verify_npm_versions 0.64.3 '@abloatai/ablo'
}

# Metadata appears after the old 30-second window; its first tarball still 404s.
check transient >/dev/null
[[ "$(cat "$TEST_TMP/views")" = 10 && "$(cat "$TEST_TMP/packs")" = 2 ]]

for mode in missing missing-tarball integrity wrong-metadata wrong-name wrong-version; do
  if (check "$mode") >/dev/null 2>&1; then
    echo "error: $mode publication was accepted" >&2
    exit 1
  fi
  case "$mode" in
    missing) [[ "$(cat "$TEST_TMP/views")" = 180 && ! -f "$TEST_TMP/packs" ]] ;;
    missing-tarball) [[ "$(cat "$TEST_TMP/packs")" = 180 ]] ;;
    integrity|wrong-name|wrong-version) [[ "$(cat "$TEST_TMP/packs")" = 1 ]] ;;
    wrong-metadata) [[ "$(cat "$TEST_TMP/views")" = 1 && ! -f "$TEST_TMP/packs" ]] ;;
  esac
done

echo 'Registry verification waits for processing, checks real tarballs, and rejects wrong or unavailable artifacts.'
