import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
execFileSync('cargo', ['build', '--release', '--locked', '--manifest-path', `${root}/runtime/Cargo.toml`], { stdio: 'inherit' });
mkdirSync(`${root}/bin`, { recursive: true });
copyFileSync(`${process.env.CARGO_TARGET_DIR ?? `${root}/runtime/target`}/release/ablo-resource-coordinator`, `${root}/bin/ablo-resource-coordinator`);
