#!/usr/bin/env bash
# Shared read-only registry gate for Actions and local releases.
verify_npm_versions() {
  if (( $# < 2 )); then
    echo 'error: verification requires a version and package names' >&2
    return 2
  fi
  local version="$1"
  shift
  local package_name published download_dir downloaded attempt
  local tarballs
  for package_name in "$@"; do
    downloaded=false
    download_dir="$(mktemp -d)"
    # npm accepts publishes before metadata and tarballs finish processing.
    # Allow up to 15 minutes of read-only polling; never repeat a publish here.
    for ((attempt = 1; attempt <= 180; attempt++)); do
      published="$(npm view "$package_name@$version" version 2>/dev/null || true)"
      if [[ -n "$published" && "$published" != "$version" ]]; then
        rm -rf "$download_dir"
        echo "error: unexpected registry version for $package_name: $published" >&2
        return 1
      fi
      # A fresh cache and npm's integrity check prove the actual artifact is readable.
      if [[ "$published" = "$version" ]] && npm pack "$package_name@$version" \
        --ignore-scripts --prefer-online --cache "$download_dir/cache" \
        --pack-destination "$download_dir" >"$download_dir/download.log" 2>&1; then
        tarballs=("$download_dir"/*.tgz)
        if [[ ${#tarballs[@]} != 1 || ! -f "${tarballs[0]}" ]] ||
           ! tar -xOf "${tarballs[0]}" package/package.json | node -e '
             const assert = require("node:assert/strict");
             const pkg = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
             assert.equal(pkg.name, process.argv[1]);
             assert.equal(pkg.version, process.argv[2]);
           ' "$package_name" "$version"; then
          rm -rf "$download_dir"
          echo "error: downloaded package does not match $package_name@$version" >&2
          return 1
        fi
        downloaded=true
        break
      fi
      if [[ -f "$download_dir/download.log" ]] && grep -q 'EINTEGRITY' "$download_dir/download.log"; then
        cat "$download_dir/download.log" >&2
        rm -rf "$download_dir"
        return 1
      fi
      if (( attempt < 180 )); then
        echo "    waiting for $package_name@$version metadata and tarball ($attempt/180)"
        sleep 5
      fi
    done
    if [[ "$downloaded" != true ]]; then
      [[ ! -f "$download_dir/download.log" ]] || cat "$download_dir/download.log" >&2
      rm -rf "$download_dir"
      echo "error: $package_name@$version was not downloadable from npm" >&2
      return 1
    fi
    rm -rf "$download_dir"
    echo ">>> verified $package_name@$version metadata, tarball, identity, and integrity"
  done
}
