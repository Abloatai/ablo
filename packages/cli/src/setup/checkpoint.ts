import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  setupCheckpointSchema,
  type SetupCheckpoint,
} from './contracts';

function checkpointPathInsideRoot(root: string, path: string): string {
  const projectRoot = resolve(root);
  const target = resolve(projectRoot, path);
  const fromRoot = relative(projectRoot, target);
  if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    throw new Error(`Setup checkpoint must stay inside the project root: ${path}`);
  }
  return target;
}

export function readSetupCheckpoint(
  root: string,
  path = '.ablo/setup-checkpoint.json',
): SetupCheckpoint | null {
  const target = checkpointPathInsideRoot(root, path);
  if (!existsSync(target)) return null;
  const parsed = setupCheckpointSchema.safeParse(JSON.parse(readFileSync(target, 'utf8')));
  if (!parsed.success) {
    throw new Error(`Setup checkpoint is not valid: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function writeSetupCheckpointAtomic(
  root: string,
  checkpoint: SetupCheckpoint,
  path = '.ablo/setup-checkpoint.json',
): string {
  const value = setupCheckpointSchema.parse(checkpoint);
  const target = checkpointPathInsideRoot(root, path);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  renameSync(temporary, target);
  return target;
}
