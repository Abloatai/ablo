#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

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

const STMT_RE = /\b(?:from|import\()\s*(['"])(\.{1,2}\/[^'"`]+)\1/g;

const violations = [];

for (const file of walk(SRC)) {
  if (file.includes("/__tests__/")) continue;
  const src = readFileSync(file, "utf8");
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  let m;
  while ((m = STMT_RE.exec(stripped))) {
    const spec = m[2];
    if (!hasKnownExtension(spec)) {
      violations.push({ file: file.slice(SRC.length + 1), spec });
    }
  }
}

if (violations.length) {
  console.error(`Found ${violations.length} relative import(s) without an explicit extension:\n`);
  for (const v of violations) console.error(`  ${v.file}: ${v.spec}`);
  console.error(`\nRun \`node scripts/add-js-extensions.mjs\` to fix.`);
  process.exit(1);
}

console.log("All relative imports have explicit extensions.");
