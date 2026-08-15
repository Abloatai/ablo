import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  setupInitPlanProjectionSchema,
  type SetupInitPlanProjection,
} from '../setup/contracts';

export interface InitOwnedFile {
  readonly path: string;
  readonly content: string;
  readonly note?: string;
}

export interface InitEnvironmentFile {
  readonly path: string;
  readonly template: string;
}

export type InitWriteAction =
  | {
      readonly kind: 'create';
      readonly path: string;
      readonly content: string;
      readonly note?: string;
      readonly precondition: { readonly kind: 'absent' };
    }
  | {
      readonly kind: 'update';
      readonly path: string;
      readonly content: string;
      readonly note?: string;
      readonly precondition: { readonly kind: 'content'; readonly sha256: string };
    }
  | {
      readonly kind: 'unchanged';
      readonly path: string;
      readonly content: string;
      readonly note?: string;
    };

export interface InitWriteConflict {
  readonly path: string;
  readonly reason: 'occupied';
}

export interface InitWritePlan {
  readonly root: string;
  readonly actions: readonly InitWriteAction[];
  readonly conflicts: readonly InitWriteConflict[];
}

/** Machine-safe init projection: paths and guards, never generated contents. */
export function projectInitWritePlan(plan: InitWritePlan): SetupInitPlanProjection {
  return setupInitPlanProjectionSchema.parse({
    root: plan.root,
    actions: plan.actions.map((action) => ({
      kind: action.kind,
      path: action.path,
      ...(action.note !== undefined ? { note: action.note } : {}),
      ...(action.kind !== 'unchanged' ? { precondition: action.precondition } : {}),
    })),
    conflicts: plan.conflicts,
  });
}

function absolute(root: string, path: string): string {
  const target = resolve(root, path);
  const fromRoot = relative(root, target);
  if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`Init target must stay inside the project root: ${path}`);
  }
  return target;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function readIfPresent(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

/**
 * Environment files are application-owned, so init only adds assignments that
 * are genuinely absent. Existing values, comments, ordering, and quoting stay
 * byte-for-byte intact. A comment containing `ABLO_` is not an assignment and
 * no longer suppresses the required keys.
 */
export function mergeEnvironmentTemplate(
  existing: string,
  template: string,
): { readonly content: string; readonly addedKeys: readonly string[] } {
  const assignments = template
    .split(/\r?\n/)
    .map((line) => {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      return match ? { key: match[1]!, line } : null;
    })
    .filter((entry): entry is { key: string; line: string } => entry !== null);

  const existingKeys = new Set(
    existing
      .split(/\r?\n/)
      .map((line) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1])
      .filter((key): key is string => key !== undefined),
  );
  const missing = assignments.filter(({ key }) => !existingKeys.has(key));
  if (missing.length === 0) return { content: existing, addedKeys: [] };

  const separator = existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  const block = [
    '# Ablo (added by `npx ablo init`)',
    ...missing.map(({ line }) => line),
    '',
  ].join('\n');
  return {
    content: `${existing}${separator}${block}`,
    addedKeys: missing.map(({ key }) => key),
  };
}

/**
 * Plan the complete init filesystem transaction without writing anything.
 * Generated TypeScript is owned by the application after creation: an exact
 * rerun is idempotent, but different existing contents are a conflict rather
 * than permission to overwrite the file.
 */
export function planInitWrites(input: {
  readonly root?: string;
  readonly files: readonly InitOwnedFile[];
  readonly environment: InitEnvironmentFile;
}): InitWritePlan {
  const root = resolve(input.root ?? process.cwd());
  const actions: InitWriteAction[] = [];
  const conflicts: InitWriteConflict[] = [];

  for (const file of input.files) {
    const current = readIfPresent(absolute(root, file.path));
    if (current === undefined) {
      actions.push({ kind: 'create', ...file, precondition: { kind: 'absent' } });
    } else if (current === file.content) {
      actions.push({ kind: 'unchanged', ...file });
    } else {
      conflicts.push({ path: file.path, reason: 'occupied' });
    }
  }

  const envPath = absolute(root, input.environment.path);
  const currentEnv = readIfPresent(envPath);
  if (currentEnv === undefined) {
    actions.push({
      kind: 'create',
      path: input.environment.path,
      content: input.environment.template,
      precondition: { kind: 'absent' },
    });
  } else {
    const merged = mergeEnvironmentTemplate(currentEnv, input.environment.template);
    const note =
      merged.addedKeys.length > 0
        ? ` (added ${merged.addedKeys.join(', ')})`
        : ' (already configured)';
    if (merged.content === currentEnv) {
      actions.push({
        kind: 'unchanged',
        path: input.environment.path,
        content: merged.content,
        note,
      });
    } else {
      actions.push({
        kind: 'update',
        path: input.environment.path,
        content: merged.content,
        precondition: { kind: 'content', sha256: sha256(currentEnv) },
        note,
      });
    }
  }

  return { root, actions, conflicts };
}

function writeAtomic(path: string, content: string, kind: 'create' | 'update'): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${randomUUID()}.ablo-init.tmp`);
  writeFileSync(temporary, content, { flag: 'wx' });
  try {
    if (kind === 'create') {
      // A hard link fails if another process created the target after planning;
      // unlike rename, it can never replace that newly occupied file.
      linkSync(temporary, path);
      unlinkSync(temporary);
    } else {
      renameSync(temporary, path);
    }
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

export function applyInitWritePlan(plan: InitWritePlan): void {
  if (plan.conflicts.length > 0) {
    throw new Error('Cannot apply an init plan with occupied targets.');
  }
  // Revalidate every precondition before the first write. A user's editor or a
  // second initializer may have changed the project since this plan was made.
  for (const action of plan.actions) {
    if (action.kind === 'unchanged') continue;
    const current = readIfPresent(absolute(plan.root, action.path));
    const stillValid =
      action.precondition.kind === 'absent'
        ? current === undefined
        : current !== undefined && sha256(current) === action.precondition.sha256;
    if (!stillValid) {
      throw new Error(
        `Init target changed after planning; no files were written: ${action.path}`,
      );
    }
  }
  for (const action of plan.actions) {
    if (action.kind === 'unchanged') continue;
    writeAtomic(absolute(plan.root, action.path), action.content, action.kind);
  }
}
