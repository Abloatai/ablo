#!/usr/bin/env node
// `npx ablo` — the SDK's bin. The command itself lives in its own package so
// installing the SDK never downloads the CLI's tooling; this file only finds
// that package and hands over.
//
// Resolution order:
//   1. An installed CLI — the project's own, or one hoisted beside this SDK.
//      Requiring it runs it: the CLI's entry executes on load and reads
//      process.argv itself, which this shim leaves untouched.
//   2. `npm exec` — fetches the CLI on demand, so `npx ablo init` in a fresh
//      project keeps working with nothing else installed.

'use strict';

// The published name first; the workspace name resolves inside the monorepo.
const CLI_PACKAGES = ['@abloatai/cli', '@ablo/cli'];

for (const name of CLI_PACKAGES) {
  let resolved;
  try {
    resolved = require.resolve(name);
  } catch {
    continue; // not installed under this name — try the next
  }
  require(resolved);
  return;
}

const { spawnSync } = require('child_process');
const result = spawnSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['exec', '--yes', '--package=@abloatai/cli', '--', 'ablo', ...process.argv.slice(2)],
  { stdio: 'inherit', shell: process.platform === 'win32' },
);
if (result.error) {
  console.error('Could not run the ablo CLI. Install it with: npm i -D @abloatai/cli');
  process.exit(1);
}
process.exit(result.status ?? 1);
