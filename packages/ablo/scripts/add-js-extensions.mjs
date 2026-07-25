#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const SRC = resolve(new URL("../src", import.meta.url).pathname);

const SKIP_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".json", ".node",
  ".css", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp",
  ".ts", ".tsx",
]);

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, files);
    else if (/\.tsx?$/.test(name)) files.push(full);
  }
  return files;
}

function hasKnownExtension(spec) {
  const dot = spec.lastIndexOf(".");
  if (dot < 0) return false;
  const slash = spec.lastIndexOf("/");
  if (dot < slash) return false;
  return SKIP_EXTENSIONS.has(spec.slice(dot));
}

function resolveSpecifier(fromFile, spec) {
  const baseDir = dirname(fromFile);
  const absNoExt = resolve(baseDir, spec);
  for (const ext of [".ts", ".tsx"]) {
    if (existsSync(absNoExt + ext)) return { kind: "file", newSpec: spec + ".js" };
  }
  for (const ext of [".ts", ".tsx"]) {
    const idx = join(absNoExt, "index" + ext);
    if (existsSync(idx)) return { kind: "dir", newSpec: spec.replace(/\/+$/, "") + "/index.js" };
  }
  return null;
}

const IMPORT_RE = /(from\s*|import\s*\(\s*|export\s+[^'"`;]*?from\s*)(['"])(\.{1,2}\/[^'"`]+)\2/g;
const BARE_IMPORT_RE = /^(\s*import\s+)(['"])(\.{1,2}\/[^'"`]+)\2/gm;

let totalRewrites = 0;
let unresolvedCount = 0;
const unresolved = [];

for (const file of walk(SRC)) {
  let src = readFileSync(file, "utf8");
  let changed = false;

  const transform = (_match, prefix, quote, spec) => {
    if (hasKnownExtension(spec)) return _match;
    const resolved = resolveSpecifier(file, spec);
    if (!resolved) {
      unresolvedCount++;
      unresolved.push(`${file}: ${spec}`);
      return _match;
    }
    totalRewrites++;
    changed = true;
    return `${prefix}${quote}${resolved.newSpec}${quote}`;
  };

  src = src.replace(IMPORT_RE, transform);
  src = src.replace(BARE_IMPORT_RE, transform);

  if (changed) writeFileSync(file, src);
}

console.log(`Rewrote ${totalRewrites} import specifiers.`);
if (unresolvedCount) {
  console.log(`\nUnresolved (${unresolvedCount}):`);
  for (const line of unresolved.slice(0, 30)) console.log("  " + line);
  if (unresolved.length > 30) console.log(`  ...and ${unresolved.length - 30} more`);
}
