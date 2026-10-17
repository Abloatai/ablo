import { execFileSync } from 'node:child_process';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const owner = fileURLToPath(new URL('..', import.meta.url));
const repository = fileURLToPath(new URL('../../..', import.meta.url));
const context = await mkdtemp(join(tmpdir(), 'ablo-resource-adapter-linux-'));
try {
  execFileSync('npm', ['run', 'build', '--workspace', '@abloatai/transaction'], { cwd: repository, stdio: 'inherit' });
  await cp(join(owner, 'runtime'), join(context, 'runtime'), { recursive: true, filter: path => !path.includes('/target') });
  await cp(join(owner, 'Dockerfile'), join(context, 'Dockerfile'));
  await cp(join(owner, 'linux'), join(context, 'linux'), { recursive: true, filter: path => !path.includes('__pycache__') });
  await build({ entryPoints: [join(owner, 'tests/native.ts')], bundle: true, platform: 'node', format: 'esm',
    outfile: join(context, 'native.mjs'), banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } });
  execFileSync('docker', ['build', '-t', 'ablo-resource-adapter-test', context], { stdio: 'inherit' });
  if (!process.argv.includes('--build-only')) {
    execFileSync('docker', ['run', '--rm', '--init', '--cap-add', 'SYS_ADMIN', '--device', '/dev/fuse',
      '--security-opt', 'apparmor=unconfined', 'ablo-resource-adapter-test'], { stdio: 'inherit' });
  }
} finally { await rm(context, { recursive: true, force: true }); }
