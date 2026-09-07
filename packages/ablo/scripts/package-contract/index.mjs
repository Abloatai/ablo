import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { checkReleaseFamily } from './release-family.mjs';

const root = new URL('../../../../', import.meta.url);
checkReleaseFamily(root);
const work = mkdtempSync(join(tmpdir(), 'ablo-package-contract-'));
const modules = join(work, 'node_modules');
const compiler = fileURLToPath(new URL('node_modules/.bin/tsc', root));
const write = (path, value) => writeFileSync(join(work, path), typeof value === 'string' ? value : JSON.stringify(value));
const options = { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true, types: ['react', 'node'] };
function compile(config, failure = false) {
  const result = spawnSync(compiler, ['-p', join(work, config), '--pretty', 'false'], { encoding: 'utf8' });
  if (!failure) assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout + result.stderr;
}
try {
  mkdirSync(modules);
  // Only third-party dependencies are shared. Every Ablo declaration comes from a tarball.
  for (const name of readdirSync(new URL('node_modules/', root))) {
    if (name !== '@abloatai' && name !== '.bin') symlinkSync(fileURLToPath(new URL(`node_modules/${name}`, root)), join(modules, name));
  }
  mkdirSync(join(modules, '@abloatai'));
  for (const name of ['transaction', 'humans', 'ablo']) {
    const output = execFileSync('npm', ['pack', '--json', '--pack-destination', work], {
      cwd: new URL(`packages/${name}/`, root), encoding: 'utf8',
      env: { ...process.env, npm_config_cache: join(work, 'cache') },
    });
    const [{ filename }] = JSON.parse(output);
    const destination = join(modules, '@abloatai', name);
    mkdirSync(destination);
    execFileSync('tar', ['-xzf', join(work, filename), '--strip-components=1', '-C', destination]);
  }
  write('package.json', { private: true, type: 'module' });
  mkdirSync(join(modules, '@fixture'));
  for (const name of ['schema', 'binding']) {
    mkdirSync(join(modules, '@fixture', name));
    write(`node_modules/@fixture/${name}/package.json`, { name: `@fixture/${name}`, type: 'module', exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } } });
    write(`node_modules/@fixture/${name}/tsconfig.json`, { compilerOptions: { ...options, declaration: true, outDir: 'dist' }, include: ['index.ts'] });
    const source = name === 'schema'
      ? "import { defineSchema, model, z } from '@abloatai/ablo/schema';\nexport const schema = defineSchema({ notes: model({ title: z.string() }) });\n"
      : "import { createAbloReact } from '@abloatai/ablo/react';\nimport { schema } from '@fixture/schema';\nexport const { useAblo, useAbloClient, usePresence, useMutationFailure } = createAbloReact(schema);\n";
    write(`node_modules/@fixture/${name}/index.ts`, source);
    compile(`node_modules/@fixture/${name}/tsconfig.json`);
    rmSync(join(modules, '@fixture', name, 'index.ts'));
  }
  for (const name of ['registered', 'explicit', 'missing']) {
    write(`${name}.ts`, readFileSync(new URL(`${name}.ts.txt`, import.meta.url), 'utf8'));
    write(`${name}.json`, { compilerOptions: { ...options, noEmit: true }, include: [`${name}.ts`] });
    const output = compile(`${name}.json`, name === 'missing');
    if (name === 'missing') {
      assert.match(output, /Ablo schema missing: pass schema explicitly or include ablo\/register.ts in tsconfig/);
      assert.equal((output.match(/error TS/g) ?? []).length, 3, output);
    }
  }
  console.log('Packed schema registration, separate binding packages, diagnostics and release family passed.');
} finally {
  rmSync(work, { recursive: true, force: true });
}
