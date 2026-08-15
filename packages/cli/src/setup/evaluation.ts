/**
 * Diff-first evidence for setup-agent runs. The evaluator deliberately cannot
 * award completion: builds, readiness, database identity, and a real canary are
 * separate deterministic gates.
 */

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, relative, resolve, sep } from 'node:path';
import {
  SETUP_CONTRACT_VERSION,
  setupDiffEvaluationSchema,
  setupAdaptationTaskSchema,
  setupWorkspaceSnapshotSchema,
  type SetupAdaptationTask,
  type SetupDiffEvaluation,
  type SetupWorkspaceSnapshot,
} from './contracts';

const SKIP_DIRECTORIES = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next', '.turbo', 'coverage', 'vendor',
]);
const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|py|rb|php|java|kt|swift)$/i;
const MAX_FILES = 20_000;
const MAX_DEPTH = 8;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

function protectedEnvironment(path: string): boolean {
  const name = basename(path);
  return name.startsWith('.env') && !/(?:^|\.)(?:example|sample|template|dist)$/.test(name);
}

function inside(root: string, target: string): boolean {
  const fromRoot = relative(resolve(root), resolve(target));
  return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`));
}

export function captureSetupWorkspace(
  repositoryRoot: string,
  now: () => Date = () => new Date(),
): SetupWorkspaceSnapshot {
  const root = resolve(repositoryRoot);
  const files: SetupWorkspaceSnapshot['files'][number][] = [];
  const stack: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  let truncated = false;
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) {
        truncated = true;
        break;
      }
      const path = resolve(current.path, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < MAX_DEPTH && !SKIP_DIRECTORIES.has(entry.name)) {
          stack.push({ path, depth: current.depth + 1 });
        } else if (!SKIP_DIRECTORIES.has(entry.name)) {
          truncated = true;
        }
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = lstatSync(path);
        if (stat.size > MAX_FILE_BYTES) {
          truncated = true;
          continue;
        }
        const isProtectedEnvironment = protectedEnvironment(path);
        const fingerprintInput = isProtectedEnvironment
          ? `${relative(root, path)}:${stat.size}:${stat.mtimeMs}`
          : readFileSync(path);
        files.push({
          path: relative(root, path) || '.',
          fingerprint: createHash('sha256').update(fingerprintInput).digest('hex'),
          size: stat.size,
          protectedEnvironment: isProtectedEnvironment,
        });
      } catch {
        truncated = true;
      }
    }
    if (files.length >= MAX_FILES) break;
  }
  return setupWorkspaceSnapshotSchema.parse({
    schemaVersion: SETUP_CONTRACT_VERSION,
    kind: 'ablo_setup_workspace_snapshot',
    repositoryRoot: root,
    capturedAt: now().toISOString(),
    truncated,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  });
}

function changedFiles(
  before: SetupWorkspaceSnapshot,
  after: SetupWorkspaceSnapshot,
): SetupDiffEvaluation['changes'] {
  const oldFiles = new Map(before.files.map((file) => [file.path, file]));
  const newFiles = new Map(after.files.map((file) => [file.path, file]));
  const changes: SetupDiffEvaluation['changes'] = [];
  for (const path of new Set([...oldFiles.keys(), ...newFiles.keys()])) {
    const oldFile = oldFiles.get(path);
    const newFile = newFiles.get(path);
    if (!oldFile && newFile) changes.push({ path, kind: 'created' });
    else if (oldFile && !newFile) changes.push({ path, kind: 'deleted' });
    else if (oldFile?.fingerprint !== newFile?.fingerprint) changes.push({ path, kind: 'modified' });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

function modelCallEvidence(
  record: SetupAdaptationTask,
  snapshot: SetupWorkspaceSnapshot,
): { found: Map<string, string[]>; changedSinceSnapshot: string[] } {
  const found = new Map(record.selectedModels.map((model) => [model, [] as string[]]));
  const changedSinceSnapshot: string[] = [];
  for (const file of snapshot.files) {
    if (!SOURCE_EXTENSIONS.test(file.path)) continue;
    const absolute = resolve(record.repositoryRoot, file.path);
    if (!inside(record.applicationRoot, absolute)) continue;
    let source: string;
    try {
      source = readFileSync(absolute, 'utf8');
      const currentFingerprint = createHash('sha256').update(source).digest('hex');
      if (currentFingerprint !== file.fingerprint) {
        changedSinceSnapshot.push(file.path);
        continue;
      }
    } catch {
      changedSinceSnapshot.push(file.path);
      continue;
    }
    for (const model of record.selectedModels) {
      const escaped = model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\bablo\\.${escaped}\\.(?:create|update|delete)\\s*\\(`).test(source)) {
        found.get(model)!.push(file.path);
      }
    }
  }
  return { found, changedSinceSnapshot };
}

export function evaluateSetupDiff(input: {
  readonly before: SetupWorkspaceSnapshot;
  readonly after: SetupWorkspaceSnapshot;
  readonly record: SetupAdaptationTask;
  readonly now?: () => Date;
}): SetupDiffEvaluation {
  const before = setupWorkspaceSnapshotSchema.parse(input.before);
  const after = setupWorkspaceSnapshotSchema.parse(input.after);
  const record = setupAdaptationTaskSchema.parse(input.record);
  if (before.repositoryRoot !== after.repositoryRoot || before.repositoryRoot !== resolve(record.repositoryRoot)) {
    throw new Error('Setup evaluation snapshots and record must target the same repository.');
  }
  const changes = changedFiles(before, after);
  const outside = changes.filter(({ path }) => !inside(record.applicationRoot, resolve(before.repositoryRoot, path)));
  const oldByPath = new Map(before.files.map((file) => [file.path, file]));
  const envChanges = changes.filter(({ path }) => oldByPath.get(path)?.protectedEnvironment || protectedEnvironment(path));
  const deleted = changes.filter(({ kind }) => kind === 'deleted');
  const { found: modelEvidence, changedSinceSnapshot } = modelCallEvidence(record, after);
  const missingModels = [...modelEvidence].filter(([, paths]) => paths.length === 0).map(([model]) => model);
  const evidencePaths = [...new Set([...modelEvidence.values()].flat())].sort();
  const truncated = before.truncated || after.truncated;
  const unsafe = outside.length > 0 || envChanges.length > 0;
  const absenceIsReliable = !truncated && changedSinceSnapshot.length === 0;
  const outcome = unsafe ? 'unsafe' : missingModels.length > 0 && absenceIsReliable ? 'incomplete' : 'candidate';

  return setupDiffEvaluationSchema.parse({
    schemaVersion: SETUP_CONTRACT_VERSION,
    kind: 'ablo_setup_diff_evaluation',
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
    selectedModels: record.selectedModels,
    changes,
    checks: [
      { id: 'application_scope', status: outside.length === 0 ? 'pass' : 'fail', detail: outside.length === 0 ? 'All observed edits stayed inside the selected application root.' : `${outside.length} edit(s) occurred outside the selected application root.`, evidencePaths: outside.map(({ path }) => path) },
      { id: 'environment_values', status: envChanges.length === 0 ? 'pass' : 'fail', detail: envChanges.length === 0 ? 'No protected environment file changed.' : `${envChanges.length} protected environment file(s) changed during agent work.`, evidencePaths: envChanges.map(({ path }) => path) },
      { id: 'selected_model_calls', status: missingModels.length === 0 ? 'pass' : absenceIsReliable ? 'fail' : 'review', detail: missingModels.length === 0 ? 'Every selected model has at least one observable Ablo mutation call.' : `No Ablo mutation call was observed for: ${missingModels.join(', ')}.`, evidencePaths },
      { id: 'deletions', status: deleted.length === 0 ? 'pass' : 'review', detail: deleted.length === 0 ? 'No pre-existing file was deleted.' : `${deleted.length} pre-existing file deletion(s) require review.`, evidencePaths: deleted.map(({ path }) => path) },
      { id: 'snapshot_coverage', status: truncated ? 'review' : 'pass', detail: truncated ? 'At least one bounded snapshot was truncated; absence claims are not reliable.' : 'Both bounded snapshots covered every eligible file.', evidencePaths: [] },
      { id: 'snapshot_integrity', status: changedSinceSnapshot.length === 0 ? 'pass' : 'review', detail: changedSinceSnapshot.length === 0 ? 'Every inspected source file still matched the after snapshot.' : `${changedSinceSnapshot.length} source file(s) changed or disappeared after the after snapshot.`, evidencePaths: changedSinceSnapshot },
      { id: 'semantic_write_coverage', status: 'review', detail: 'Repository semantics, intentional bypasses, authorization, transactions, build/tests, readiness, and canary still require deterministic or human grading.', evidencePaths: record.discoveryHints.map(({ path }) => path) },
    ],
    outcome,
    summary: `${changes.length} changed file(s); ${outside.length} outside scope; ${envChanges.length} protected environment change(s); ${missingModels.length} selected model(s) without an observable Ablo mutation. This is diff evidence, not activation proof.`,
  });
}
