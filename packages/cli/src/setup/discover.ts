import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { basename, join, relative, resolve, sep } from 'node:path';
import { apiBaseUrl } from '../controlPlane';
import { getActiveProjectReadOnly, resolveRuntimeApiKeyReadOnly } from '../config';
import { inspectDoctor } from '../doctor';
import {
  SETUP_CONTRACT_VERSION,
  setupMutationSiteSchema,
  setupPlanSchema,
  setupStepResultSchema,
  type SetupAction,
  type SetupDecision,
  type SetupEvidence,
  type SetupFact,
  type SetupPlan,
  type SetupStepResult,
  type SetupMutationSite,
  type SetupCompatibilityDisposition,
  type SetupCoordinationAdoptionDisposition,
  type SetupDatabaseColumn,
} from './contracts';
import { executeSetupProgram, type SetupProgram } from './program';
import {
  analyzeSetupCompatibility,
  discoverDatabaseColumnsFromSqlSource,
  discoverTransactionalRequirementsFromSqlSource,
  type SetupTransactionalRequirement,
} from './compatibility';

const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
  'coverage',
  'vendor',
  '.venv',
]);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const MAX_DISCOVERY_FILES = 10_000;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

interface PackageManifest {
  readonly root: string;
  readonly name: string | null;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly scripts: Readonly<Record<string, string>>;
}

interface DiscoveryState {
  repositoryRoot: string;
  packageManifests: PackageManifest[];
  applicationRoot: string | null;
  packageName: string | null;
  localSchemaDigest: string | null;
  pushedSchemaDigest: string | null;
  abloProjectId: string | null;
  abloBranchId: string | null;
  compatibility: SetupCompatibilityDisposition;
}

function isoNow(): string {
  return new Date().toISOString();
}

function evidence(
  source: SetupEvidence['source'],
  detail: string,
  locator?: string,
): SetupEvidence {
  return {
    source,
    detail,
    observedAt: isoNow(),
    ...(locator ? { locator } : {}),
  };
}

function fact(
  key: string,
  value: unknown,
  source: SetupEvidence['source'],
  detail: string,
  locator?: string,
  confidence: SetupFact['confidence'] = 'high',
): SetupFact {
  const jsonValue = JSON.parse(JSON.stringify(value ?? null)) as SetupFact['value'];
  return { key, value: jsonValue, confidence, evidence: [evidence(source, detail, locator)] };
}

type StepResultWithoutTimes<T> = T extends unknown
  ? Omit<T, 'startedAt' | 'finishedAt'>
  : never;

function stepResult(input: StepResultWithoutTimes<SetupStepResult>): SetupStepResult {
  const at = isoNow();
  return setupStepResultSchema.parse({ ...input, startedAt: at, finishedAt: at });
}

function tryGit(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
  } catch {
    return null;
  }
}

export function resolveRepositoryRoot(cwd = process.cwd()): string {
  return resolve(tryGit(cwd, ['rev-parse', '--show-toplevel']) || cwd);
}

function walkFiles(root: string, maxDepth = 5): string[] {
  const files: string[] = [];
  const stack: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  while (stack.length > 0 && files.length < MAX_DISCOVERY_FILES) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.slice(0, 10_000)) {
      if (files.length >= MAX_DISCOVERY_FILES) break;
      const path = join(current.path, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < maxDepth && !IGNORED_DIRECTORIES.has(entry.name)) {
          stack.push({ path, depth: current.depth + 1 });
        }
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  }
  return files;
}

function readManifest(path: string): PackageManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      name?: unknown;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    return {
      root: resolve(path, '..'),
      name: typeof parsed.name === 'string' ? parsed.name : null,
      dependencies: { ...parsed.dependencies, ...parsed.devDependencies },
      scripts: { ...parsed.scripts },
    };
  } catch {
    return null;
  }
}

function packageManifests(root: string, files: readonly string[]): PackageManifest[] {
  return files
    .filter((path) => basename(path) === 'package.json')
    .flatMap((path) => {
      const manifest = readManifest(path);
      return manifest ? [manifest] : [];
    })
    .sort((a, b) => a.root.localeCompare(b.root));
}

function pathInside(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`));
}

/**
 * Files lexically owned by one package. A root application does not own an
 * independently manifested nested plugin merely because it is its ancestor.
 * Agents may still follow an import into a workspace package; this boundary
 * keeps coarse discovery evidence from being dominated by an unrelated UI.
 */
function packageOwnedFiles(
  manifest: PackageManifest,
  manifests: readonly PackageManifest[],
  files: readonly string[],
): string[] {
  const nestedPackageRoots = manifests
    .filter(({ root }) => root !== manifest.root && pathInside(manifest.root, root));
  return files.filter((path) =>
    pathInside(manifest.root, path) &&
    !nestedPackageRoots.some(({ root }) => pathInside(root, path)),
  );
}

function detectedFrameworks(manifest: PackageManifest): string[] {
  const deps = manifest.dependencies;
  return [
    deps.next ? 'nextjs' : null,
    deps['@remix-run/react'] ? 'remix' : null,
    deps['react-router'] ? 'react-router' : null,
    deps['@sveltejs/kit'] ? 'sveltekit' : null,
    deps.nuxt ? 'nuxt' : null,
    deps.vite ? 'vite' : null,
  ].filter((value): value is string => value !== null);
}

function detectedAuth(manifest: PackageManifest): string[] {
  const deps = manifest.dependencies;
  return [
    deps['@clerk/nextjs'] || deps['@clerk/clerk-react'] ? 'clerk' : null,
    deps['@supabase/supabase-js'] ? 'supabase' : null,
    deps['@auth0/nextjs-auth0'] || deps['@auth0/auth0-react'] ? 'auth0' : null,
    deps['better-auth'] ? 'betterauth' : null,
    deps.firebase ? 'firebase' : null,
    deps['next-auth'] || deps['@auth/core'] ? 'authjs' : null,
  ].filter((value): value is string => value !== null);
}

function detectedOrm(manifest: PackageManifest): string[] {
  const deps = manifest.dependencies;
  return [
    deps['@prisma/client'] || deps.prisma ? 'prisma' : null,
    deps['drizzle-orm'] ? 'drizzle' : null,
  ].filter((value): value is string => value !== null);
}

function detectedDataAccess(manifest: PackageManifest): string[] {
  const deps = manifest.dependencies;
  return [
    ...detectedOrm(manifest),
    deps.pg ? 'pg' : null,
    deps.postgres ? 'postgres' : null,
    deps.mysql2 ? 'mysql' : null,
  ].filter((value): value is string => value !== null);
}

function isRunnableApplication(manifest: PackageManifest): boolean {
  return Boolean(manifest.scripts.start || manifest.scripts.dev || manifest.scripts.worker);
}

/**
 * Distinguish a package that owns a runtime entrypoint from a workspace shell
 * whose `dev` script merely delegates to a nested application. This lets a
 * headless root outrank its renderer without treating every monorepo root as
 * the application.
 */
function ownsRuntimeEntrypoint(manifest: PackageManifest): boolean {
  return [manifest.scripts.start, manifest.scripts.dev, manifest.scripts.worker]
    .some((script) => typeof script === 'string' && /(?:^|\s)(?:\.\/)?src[/\\][^\s]+/i.test(script));
}

function detectedPersistence(
  manifest: PackageManifest,
  files: readonly string[],
): string[] {
  const kinds = new Set(detectedDataAccess(manifest).map((kind) =>
    ['pg', 'postgres'].includes(kind) ? 'postgres' : kind));
  for (const path of files) {
    if (!SOURCE_EXTENSIONS.has(sourceExtension(path))) continue;
    let source: string;
    try {
      if (lstatSync(path).size > MAX_SOURCE_BYTES) continue;
      source = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    if (/(?:node:fs(?:\/promises)?|from\s+['"]fs(?:\/promises)?['"])/.test(source) &&
      /(?:writeFile|writeJsonFileAtomic|rename)\s*\(/.test(source)) {
      kinds.add('filesystem');
    }
  }
  return [...kinds].sort();
}

/** Describe adoption work from repository evidence; never claim a live authority. */
function coordinationAdoptionDisposition(
  persistence: readonly string[],
): SetupCoordinationAdoptionDisposition {
  if (persistence.includes('postgres') || persistence.includes('mysql')) {
    return 'existing_state_reuse_candidate';
  }
  if (persistence.includes('filesystem')) return 'model_migration_required';
  return 'coordination_path_undetermined';
}

function coordinationAdoptionReason(
  disposition: SetupCoordinationAdoptionDisposition,
  persistence: readonly string[],
): string {
  switch (disposition) {
    case 'existing_state_reuse_candidate':
      return 'A durable relational store is a candidate for reusing existing state, but setup has not proven schema compatibility or a safe development database.';
    case 'model_migration_required':
      return `Detected ${persistence.join(', ')} persistence; coordinated models need addressable identity and their write paths migrated behind an authority.`;
    case 'coordination_path_undetermined':
      return 'No durable state path was proven strongly enough to choose reuse or model migration.';
  }
}

function packageManager(root: string): string {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) return 'bun';
  return 'npm';
}

function environmentKeyNames(root: string): Array<{ file: string; keys: string[] }> {
  const names = ['.env.local', '.env.development.local', '.env.development', '.env'];
  return names.flatMap((name) => {
    const path = join(root, name);
    if (!existsSync(path)) return [];
    const keys = readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .flatMap((line) => {
        const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
        return match ? [match[1]!] : [];
      });
    return [{ file: name, keys: [...new Set(keys)].sort() }];
  });
}

function sourceExtension(path: string): string {
  const match = /\.[^.]+$/.exec(path);
  return match?.[0] ?? '';
}

function abloSourceFiles(root: string, files: readonly string[]): string[] {
  return files.flatMap((path) => {
    if (!SOURCE_EXTENSIONS.has(sourceExtension(path))) return [];
    try {
      if (lstatSync(path).size > MAX_SOURCE_BYTES) return [];
      return readFileSync(path, 'utf8').includes('@abloatai/')
        ? [relative(root, path) || '.']
        : [];
    } catch {
      return [];
    }
  }).sort();
}

function mutationOperation(raw: string): SetupMutationSite['operation'] {
  if (raw === 'createMany') return 'bulk_create';
  if (raw === 'updateMany') return 'bulk_update';
  if (raw === 'deleteMany') return 'bulk_delete';
  return raw as SetupMutationSite['operation'];
}

/**
 * Build a bounded candidate inventory of application writes without importing
 * project code. A future AST adapter can refine these findings; confidence is
 * explicit so lexical evidence is never presented as a semantic verdict.
 */
export function discoverMutationSites(
  root: string,
  files: readonly string[],
): readonly SetupMutationSite[] {
  const sites: SetupMutationSite[] = [];
  const seen = new Set<string>();
  const add = (site: SetupMutationSite): void => {
    const parsed = setupMutationSiteSchema.parse(site);
    const key = `${parsed.path}:${parsed.line}:${parsed.kind}:${parsed.operation}:${parsed.modelHint}`;
    if (!seen.has(key)) {
      seen.add(key);
      sites.push(parsed);
    }
  };

  for (const path of files) {
    if (!SOURCE_EXTENSIONS.has(sourceExtension(path))) continue;
    let source: string;
    try {
      if (lstatSync(path).size > MAX_SOURCE_BYTES) continue;
      source = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const locator = relative(root, path) || '.';
    for (const match of source.matchAll(/\b(?:(?:[A-Za-z_$][\w$]*)\.query|query|q)\s*\(\s*(?:`|['"])\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([A-Za-z_$][\w$.[\]"`]*|"[^"]+"|`[^`]+`)/gi)) {
      const rawTable = match[2] ?? '';
      const modelHint = rawTable
        .replace(/["`\[\]]/g, '')
        .split('.')
        .at(-1)
        ?.toLowerCase() || null;
      const line = source.slice(0, match.index).split('\n').length;
      add({ path: locator, line, kind: 'sql', operation: 'sql_write', modelHint, confidence: 'medium' });
    }
    for (const match of source.matchAll(/\bsql\s*`\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([A-Za-z_$][\w$.[\]"`]*|"[^"]+"|`[^`]+`)/gi)) {
      const modelHint = (match[2] ?? '')
        .replace(/["`\[\]]/g, '')
        .split('.')
        .at(-1)
        ?.toLowerCase() || null;
      const line = source.slice(0, match.index).split('\n').length;
      add({ path: locator, line, kind: 'sql', operation: 'sql_write', modelHint, confidence: 'medium' });
    }
    for (const [index, line] of source.split(/\r?\n/).entries()) {
      const lineNumber = index + 1;
      for (const match of line.matchAll(/\bablo\.([A-Za-z_$][\w$]*)\.(create|update|delete)\s*\(/g)) {
        add({ path: locator, line: lineNumber, kind: 'ablo', operation: mutationOperation(match[2]!), modelHint: match[1]!, confidence: 'high' });
      }
      for (const match of line.matchAll(/\b(?:prisma|tx|transaction)\.([A-Za-z_$][\w$]*)\.(createMany|updateMany|deleteMany|create|update|delete|upsert)\s*\(/g)) {
        add({ path: locator, line: lineNumber, kind: 'prisma', operation: mutationOperation(match[2]!), modelHint: match[1]!, confidence: 'high' });
      }
      for (const match of line.matchAll(/\b(?:db|database|tx)\.(insert|update|delete)\s*\(\s*([A-Za-z_$][\w$]*)/g)) {
        const operation = match[1] === 'insert' ? 'create' : match[1] as 'update' | 'delete';
        add({ path: locator, line: lineNumber, kind: 'drizzle', operation, modelHint: match[2]!, confidence: 'medium' });
      }
      if (/(?:fetch\s*\(|axios\.(?:post|put|patch|delete)\s*\()/i.test(line) && /(?:method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)|axios\.(?:post|put|patch|delete))/i.test(line)) {
        add({ path: locator, line: lineNumber, kind: 'http', operation: 'http_write', modelHint: null, confidence: 'low' });
      }
    }
  }
  return sites.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

function isProductionMutationFile(root: string, path: string): boolean {
  const locator = relative(root, path).replaceAll('\\', '/');
  return !/(?:^|\/)(?:test|tests|__tests__|scripts)(?:\/|$)/.test(locator) &&
    !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(locator);
}

function digestFile(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

function localDiscoveryStep(state: DiscoveryState): SetupStepResult {
  const root = state.repositoryRoot;
  const files = walkFiles(root);
  state.packageManifests = packageManifests(root, files);
  const candidates = state.packageManifests
    .map((manifest) => ({
      manifest,
      frameworks: detectedFrameworks(manifest),
      dataAccess: detectedDataAccess(manifest),
      runtimeEntrypoint: ownsRuntimeEntrypoint(manifest),
    }))
    .filter(({ manifest, frameworks, dataAccess, runtimeEntrypoint }) =>
      frameworks.length > 0 || (isRunnableApplication(manifest) && (dataAccess.length > 0 || runtimeEntrypoint)));
  const dataApplications = candidates.filter(({ manifest, dataAccess }) =>
    isRunnableApplication(manifest) && dataAccess.length > 0);
  const runtimeOwners = candidates.filter(({ manifest, runtimeEntrypoint }) =>
    isRunnableApplication(manifest) && runtimeEntrypoint);
  const selectedCandidate = dataApplications.length === 1
    ? dataApplications[0]!
    : runtimeOwners.length === 1
      ? runtimeOwners[0]!
      : candidates.length === 1
        ? candidates[0]!
        : null;
  const selected = selectedCandidate?.manifest ?? null;
  state.applicationRoot = selected?.root ?? (state.packageManifests.length === 1 ? state.packageManifests[0]!.root : null);
  state.packageName = selected?.name ?? null;

  const gitStatus = tryGit(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  const dirtyEntries = gitStatus ? gitStatus.split('\n').filter(Boolean) : [];
  const envRoot = state.applicationRoot ?? root;
  const env = environmentKeyNames(envRoot);
  const selectedFrameworks = selected ? detectedFrameworks(selected) : [];
  const selectedApplicationKinds = selectedCandidate
    ? [...selectedCandidate.frameworks, ...(selectedCandidate.dataAccess.length > 0 || selectedCandidate.runtimeEntrypoint ? ['node'] : [])]
    : [];
  const selectedAuth = selected ? detectedAuth(selected) : [];
  const appFiles = selected
    ? packageOwnedFiles(selected, state.packageManifests, files)
    : files.filter((path) => pathInside(envRoot, path));
  const persistence = selected ? detectedPersistence(selected, appFiles) : [];
  const coordinationAdoption = coordinationAdoptionDisposition(persistence);
  const excludedNestedPackages = selected
    ? state.packageManifests
        .filter(({ root: packageRoot }) => packageRoot !== selected.root && pathInside(selected.root, packageRoot))
        .map(({ root: packageRoot, name }) => ({ root: relative(root, packageRoot), name }))
    : [];
  const mutationSites = discoverMutationSites(
    envRoot,
    appFiles.filter((path) => isProductionMutationFile(envRoot, path)),
  );
  const directMutationSites = mutationSites.filter(({ kind }) => kind !== 'ablo');
  const coordinatedMutationSites = mutationSites.filter(({ kind }) => kind === 'ablo');
  const databaseColumns: SetupDatabaseColumn[] = [];
  const transactionalRequirements: SetupTransactionalRequirement[] = [];
  for (const path of appFiles) {
    if (!SOURCE_EXTENSIONS.has(sourceExtension(path))) continue;
    let source: string;
    try {
      if (lstatSync(path).size > MAX_SOURCE_BYTES) continue;
      source = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    databaseColumns.push(...discoverDatabaseColumnsFromSqlSource({
      path: relative(envRoot, path),
      source,
    }));
    transactionalRequirements.push(...discoverTransactionalRequirementsFromSqlSource({
      path: relative(envRoot, path),
      source,
    }));
  }
  const uniqueDatabaseColumns = [...new Map(databaseColumns.map((column) => [
    `${column.table.toLowerCase()}.${column.column.toLowerCase()}`,
    column,
  ])).values()];
  const uniqueRequirements = [...new Map(transactionalRequirements.map((requirement) => [
    `${requirement.table.toLowerCase()}:${requirement.conditionalAtomicMutation}:${requirement.transactionBoundTypedResult}`,
    requirement,
  ])).values()];
  state.compatibility = analyzeSetupCompatibility({
    columns: uniqueDatabaseColumns,
    requirements: uniqueRequirements,
    schemaEvidence: evidence(
      'filesystem',
      uniqueDatabaseColumns.length > 0
        ? `Derived ${uniqueDatabaseColumns.length} database column(s) from application-owned CREATE TABLE statements; catalog verification is still required before apply.`
        : 'No CREATE TABLE metadata was available without executing application code or reading database credentials.',
      envRoot,
    ),
  });
  const relevantPaths = [
    'ablo/schema.ts',
    'ablo/index.ts',
    'ablo/register.ts',
    'src/ablo/schema.ts',
    'src/ablo/index.ts',
    'src/ablo/register.ts',
    'app/providers.tsx',
    'src/app/providers.tsx',
    'app/api/ablo-session/route.ts',
    'src/app/api/ablo-session/route.ts',
  ].filter((path) => existsSync(join(envRoot, path)));
  const localSchemaPath = [join(envRoot, 'ablo', 'schema.ts'), join(envRoot, 'src', 'ablo', 'schema.ts')]
    .find((path) => existsSync(path)) ?? join(envRoot, 'ablo', 'schema.ts');
  state.localSchemaDigest = digestFile(localSchemaPath);

  const facts: SetupFact[] = [
    fact('repository.root', root, 'git', tryGit(root, ['rev-parse', '--show-toplevel']) ? 'Resolved from Git.' : 'No Git root was available; using the requested directory.', root),
    fact('repository.git', gitStatus !== null, 'git', gitStatus !== null ? 'Git status was readable.' : 'Git status was unavailable.', root),
    fact('repository.dirty', gitStatus === null ? null : dirtyEntries.length > 0, 'git', gitStatus === null ? 'Dirty-worktree state is unknown because Git status was unavailable.' : `${dirtyEntries.length} changed or untracked path(s).`, root, gitStatus === null ? 'low' : 'high'),
    fact('repository.dirtyPathCount', dirtyEntries.length, 'git', 'Count from porcelain status; path names are intentionally omitted.', root),
    fact('repository.scanTruncated', files.length >= MAX_DISCOVERY_FILES, 'filesystem', `Scanned at most ${MAX_DISCOVERY_FILES} files to depth 5.`, root),
    fact('package.manager', packageManager(root), 'filesystem', 'Detected from the repository lockfile.', root),
    fact('application.candidates', candidates.map(({ manifest, frameworks, dataAccess, runtimeEntrypoint }) => ({ root: relative(root, manifest.root) || '.', name: manifest.name, frameworks, dataAccess, runtimeEntrypoint })), 'package_manifest', `${candidates.length} runnable application candidate(s) found.`, root),
    fact('application.selectedRoot', state.applicationRoot ? relative(root, state.applicationRoot) || '.' : null, 'inference', state.applicationRoot ? 'Exactly one usable application root was selected.' : 'Application selection is ambiguous.', root, state.applicationRoot ? 'high' : 'low'),
    fact('application.packageName', state.packageName, 'package_manifest', 'Read from the selected package manifest.', state.applicationRoot ? join(relative(root, state.applicationRoot), 'package.json') : 'package.json'),
    fact('application.frameworks', selected ? selectedFrameworks : candidates.flatMap(({ frameworks }) => frameworks), 'package_manifest', 'Detected only from declared package dependencies.', root),
    fact('application.kinds', selectedApplicationKinds, 'package_manifest', 'Detected from runtime scripts and declared framework or database dependencies.', root),
    fact('application.excludedNestedPackages', excludedNestedPackages, 'package_manifest', 'Independently manifested nested packages are excluded from the selected package\'s lexical mutation inventory; an agent may still follow application imports across that boundary.', root),
    fact('application.authCandidates', selectedAuth, 'package_manifest', 'Detected only from declared package dependencies; source wiring is not yet proven.', root, 'medium'),
    fact('application.ormCandidates', selected ? detectedOrm(selected) : [], 'package_manifest', 'Detected only from declared package dependencies.', root, 'medium'),
    fact('application.persistenceCandidates', persistence, 'filesystem', 'Detected from declared data-access dependencies and bounded source evidence; this does not prove a safe development database.', envRoot, 'medium'),
    fact('application.coordinationAdoption', coordinationAdoption, 'inference', 'Classified the adoption work implied by durable-state evidence without asserting that a coordination authority exists.', envRoot, 'medium'),
    fact('application.envKeys', env, 'environment', 'Only environment key names were read; values are excluded.', envRoot),
    fact('application.abloFiles', relevantPaths, 'filesystem', 'Known Ablo integration paths that already exist.', envRoot),
    fact('application.abloImports', abloSourceFiles(envRoot, appFiles), 'filesystem', 'Source files containing an @abloatai import.', envRoot),
    fact('application.directMutationSites', directMutationSites, 'filesystem', 'Bounded lexical candidates for ORM, SQL, and HTTP writes that may bypass Ablo. Each hit carries confidence and requires semantic review.', envRoot, 'medium'),
    fact('application.abloMutationSites', coordinatedMutationSites, 'filesystem', 'Lexically detected ablo.<model>.create/update/delete calls.', envRoot, 'medium'),
    fact('application.writeInventory', {
      direct: directMutationSites.length,
      coordinated: coordinatedMutationSites.length,
      byKind: Object.fromEntries(['prisma', 'drizzle', 'sql', 'http', 'ablo'].map((kind) => [kind, mutationSites.filter((site) => site.kind === kind).length])),
    }, 'inference', 'Summary of bounded mutation-site candidates; counts require semantic review.', envRoot, 'medium'),
    fact('application.databaseSchemaEvidence', uniqueDatabaseColumns, 'filesystem', 'Conservative database-column evidence derived from application-owned CREATE TABLE statements. Database catalogs remain authoritative.', envRoot, 'medium'),
    fact('application.transactionalRequirements', uniqueRequirements, 'filesystem', 'Transaction shapes whose atomic predicates or exact RETURNING rows must be preserved.', envRoot, 'medium'),
    fact('application.compatibilityDisposition', state.compatibility, 'inference', 'Compared database and transaction evidence with the current canonical Ablo contracts.', envRoot, uniqueDatabaseColumns.length > 0 ? 'medium' : 'low'),
    fact('application.localSchemaDigest', state.localSchemaDigest, 'filesystem', state.localSchemaDigest ? 'SHA-256 of the local schema source file.' : 'No local ablo/schema.ts was found.', relative(root, localSchemaPath)),
  ];

  const applicationChoices = candidates.map(({ manifest, frameworks, dataAccess }) => ({
    value: relative(root, manifest.root) || '.',
    label: manifest.name ?? (relative(root, manifest.root) || '.'),
    consequence: `Setup will modify only this ${[...frameworks, ...dataAccess].join('/')} application.`,
  }));
  if (state.applicationRoot && !applicationChoices.some(({ value }) => value === (relative(root, state.applicationRoot!) || '.'))) {
    applicationChoices.push({
      value: relative(root, state.applicationRoot) || '.',
      label: state.packageName ?? '.',
      consequence: 'Setup will treat this package as the application root; framework support remains unconfirmed.',
    });
  }
  const decisions: SetupDecision[] = [
    {
      id: 'application_root',
      question: 'Which application should Ablo set up?',
      status: state.applicationRoot ? 'resolved' : 'unresolved',
      choices: applicationChoices,
      ...(state.applicationRoot ? { selected: relative(root, state.applicationRoot) || '.' } : {}),
      reason: state.applicationRoot
        ? dataApplications.length === 1
          ? 'Exactly one runnable package owns database access, so it is the coordination boundary.'
          : runtimeOwners.length === 1
            ? 'Exactly one package owns a concrete runtime entrypoint, so it is the application boundary.'
            : 'The repository has one unambiguous application target.'
        : 'More than one or no runnable application was identified.',
    },
    {
      id: 'framework_path',
      question: 'Is this application on the supported deterministic setup path?',
      status: selectedFrameworks.includes('nextjs') ? 'resolved' : 'unresolved',
      choices: selectedFrameworks.map((framework) => ({
        value: framework,
        label: framework,
        consequence: framework === 'nextjs'
          ? 'Use the first supported Next.js setup path.'
          : 'Stop with a precise unsupported-framework handoff; apply is not implemented for this framework.',
      })),
      ...(selectedFrameworks.includes('nextjs') ? { selected: 'nextjs' } : {}),
      reason: selectedFrameworks.includes('nextjs')
        ? 'Next.js is the first deterministic setup target.'
        : 'The first apply slice supports Next.js only, and no supported target was proven.',
    },
    {
      id: 'auth_integration',
      question: 'How should application identity be mapped into the Ablo session route?',
      status: 'unresolved',
      choices: selectedAuth.map((auth) => ({
        value: auth,
        label: auth,
        consequence: `Inspect the existing ${auth} wiring and apply only a tested adapter or reviewed patch.`,
      })),
      reason: selectedAuth.length > 0
        ? 'Dependencies are evidence of an auth provider, but not proof of the application wiring to modify.'
        : 'No supported auth provider was proven from package dependencies.',
    },
    {
      id: 'coordinated_models',
      question: 'Which customer-owned models should participate in coordination?',
      status: 'unresolved',
      choices: [...new Set(directMutationSites.flatMap(({ modelHint }) => modelHint ? [modelHint] : []))].map((model) => ({
        value: model,
        label: model,
        consequence: `Every write path for ${model} must be reviewed and migrated to ablo.${model}.create/update/delete or explicitly classified as an allowed bypass.`,
      })),
      reason: directMutationSites.length > 0
        ? `${directMutationSites.length} direct write candidate(s) were found. Model selection defines a repository-wide write-path migration, not only schema generation.`
        : 'No direct write candidate proved which models require coordination; schema or ORM inspection and explicit review are still required.',
    },
    {
      id: 'development_database',
      question: 'Which non-production Postgres database may setup connect and use for the canary?',
      status: 'unresolved',
      choices: [],
      reason: coordinationAdoptionReason(coordinationAdoption, persistence),
    },
  ];

  return stepResult({
    stepId: 'discover_repository',
    status: 'complete',
    summary: `Inspected ${files.length} bounded project files without executing project code.`,
    facts,
    decisions,
    actions: [{
      id: 'inspect_repository',
      stepId: 'discover_repository',
      kind: 'inspect_repository',
      summary: 'Inspect repository structure and local Ablo evidence.',
      mutation: 'read_only',
      approval: 'none',
      executor: 'deterministic',
      status: 'not_needed',
      blockedBy: [],
      paths: [],
      preconditions: [],
    }],
  });
}

async function remoteDiscoveryStep(state: DiscoveryState): Promise<SetupStepResult> {
  const appRoot = state.applicationRoot ?? state.repositoryRoot;
  const runtimeKey = resolveRuntimeApiKeyReadOnly(undefined, appRoot);
  const apiUrl = apiBaseUrl();
  const activeProject = getActiveProjectReadOnly();
  if (!runtimeKey.key) {
    return stepResult({
      stepId: 'discover_ablo_target',
      status: 'incomplete',
      summary: 'No runtime credential is available, so remote target state was not queried.',
      next: 'Run `ablo login` or provide a branch-bound ABLO_API_KEY, then rerun the plan.',
      facts: [
        fact('ablo.apiUrl', apiUrl, 'ablo_config', 'Resolved control-plane URL.'),
        fact('ablo.runtimeCredential', null, 'environment', 'No runtime credential resolved from env files, process environment, or the active profile.'),
        fact('ablo.activeProject', activeProject ?? null, 'ablo_config', 'Local project preference; not server-confirmed.'),
      ],
      decisions: [],
      actions: [],
    });
  }

  // Reuse the same structured verdict as `ablo doctor`. Runtime schema loading
  // stays disabled here because setup discovery never executes project code.
  const report = await inspectDoctor({
    readOnlyConfig: true,
    readLocalSchema: false,
    cwd: appRoot,
  });
  const target = report.target;
  const pushed = report.pushedSchema;
  const dataSource = report.dataSource;
  state.abloProjectId = target?.confirmed?.projectId ?? null;
  state.abloBranchId = target?.confirmed?.branchId ?? null;
  state.pushedSchemaDigest = pushed?.hash ?? null;
  const reachable = report.reachable;
  const routingProjection = dataSource.kind === 'connected'
    ? {
        kind: dataSource.kind,
        connectionCount: dataSource.connections.length,
        connectionKinds: dataSource.connections,
      }
    : dataSource;

  const facts: SetupFact[] = [
    fact('ablo.apiUrl', apiUrl, 'ablo_config', 'Resolved control-plane URL.'),
    fact('ablo.runtimeCredential', { prefix: runtimeKey.key.slice(0, 12), source: runtimeKey.source }, 'environment', 'Credential is represented only by prefix and source.'),
    fact('ablo.confirmedTarget', target?.confirmed ?? null, 'ablo_api', target?.confirmed ? 'Server-confirmed credential target.' : 'The server did not confirm this credential target.', apiUrl, target?.confirmed ? 'high' : 'low'),
    fact('ablo.targetMismatches', target?.mismatches ?? [], 'inference', 'Compared local project selection with server-confirmed identity.', apiUrl),
    fact('ablo.pushedSchema', pushed ? { active: pushed.active, hash: pushed.hash ?? null, version: pushed.version ?? null, modelCount: pushed.models.length } : null, 'ablo_api', pushed ? 'Read the active schema metadata.' : 'Schema metadata was unavailable.', apiUrl, pushed ? 'high' : 'low'),
    fact('ablo.routing', routingProjection, 'ablo_api', 'Read-only routing state. Database hosts and credentials are excluded.', apiUrl, dataSource.kind === 'unknown' ? 'low' : 'high'),
    fact('ablo.readinessChecks', report.checks, 'inference', 'Collected by the same structured adapter rendered by `ablo doctor`.', apiUrl),
    fact('ablo.readinessBlockers', report.blockers, 'inference', 'Classified through the existing readiness model.', apiUrl),
  ];

  return reachable
    ? stepResult({
        stepId: 'discover_ablo_target',
        status: 'complete',
        summary: 'Read the server-confirmed Ablo target and routing state.',
        facts,
        decisions: [],
        actions: [],
      })
    : stepResult({
        stepId: 'discover_ablo_target',
        status: 'incomplete',
        summary: 'A credential exists, but the Ablo target could not be confirmed.',
        next: 'Check the API URL and credential, then rerun the plan.',
        facts,
        decisions: [],
        actions: [],
      });
}

function plannedActions(state: DiscoveryState, results: ReadonlyMap<string, SetupStepResult>): SetupStepResult {
  const allDecisions = [...results.values()].flatMap(({ decisions }) => decisions);
  const unresolved = allDecisions.filter(({ status }) => status === 'unresolved').map(({ id }) => `decision:${id}`);
  const mutationPaths = [...results.values()]
    .flatMap(({ facts }) => facts)
    .find(({ key }) => key === 'application.directMutationSites')?.value;
  const candidatePaths = Array.isArray(mutationPaths)
    ? [...new Set(mutationPaths.flatMap((site) => typeof site === 'object' && site !== null && 'path' in site && typeof site.path === 'string' ? [site.path] : []))]
    : [];
  const remote = results.get('discover_ablo_target');
  const credentialBlocker = remote?.status === 'complete' ? [] : ['step:discover_ablo_target'];
  const compatibilityBlocker = state.compatibility.status === 'compatible'
    ? []
    : [`compatibility:${state.compatibility.status}`];
  const actions: SetupAction[] = [
    {
      id: 'select_application', stepId: 'build_plan', kind: 'select_application',
      summary: 'Confirm the application root.', mutation: 'read_only', approval: 'review',
      executor: 'user',
      status: state.applicationRoot ? 'planned' : 'blocked', blockedBy: state.applicationRoot ? [] : ['decision:application_root'], paths: [], preconditions: ['Repository root remains unchanged.'],
    },
    {
      id: 'analyze_compatibility', stepId: 'build_plan', kind: 'analyze_compatibility',
      summary: 'Compare database tables and transactional write contracts before application adaptation.', mutation: 'read_only', approval: 'none',
      executor: 'deterministic', status: 'not_needed', blockedBy: [], paths: [],
      preconditions: ['Catalog-derived metadata must replace source-derived evidence before database apply.'],
    },
    {
      id: 'integrate_application', stepId: 'build_plan', kind: 'write_files',
      summary: 'Install the SDK and integrate Ablo client, providers, and authentication into the existing application.', mutation: 'local_write', approval: 'review',
      executor: 'agent',
      status: unresolved.length === 0 && compatibilityBlocker.length === 0 ? 'planned' : 'blocked', blockedBy: [...unresolved, ...compatibilityBlocker], paths: [], preconditions: ['Every occupied file is read and reviewed before modification.', 'The worktree target still matches discovery evidence.'],
    },
    {
      id: 'adapt_write_paths', stepId: 'build_plan', kind: 'adapt_write_paths',
      summary: `Run the installing agent's skill-driven repository exploration for selected models; ${candidatePaths.length} lexical hint path(s) are available but do not define its scope or coverage.`, mutation: 'local_write', approval: 'review', executor: 'agent',
      status: 'blocked', blockedBy: ['decision:coordinated_models', ...compatibilityBlocker], paths: [],
      preconditions: ['Coordinated models are explicitly selected.', 'Discovery hints are advisory and the agent independently explores the application.', 'The agent may inspect the selected application but not secrets or paths outside it.', 'Application authorization, validation, and transaction behavior must be preserved.'],
    },
    {
      id: 'authenticate', stepId: 'build_plan', kind: 'authenticate',
      summary: 'Authenticate and confirm the Ablo project and development branch.', mutation: 'remote_write', approval: 'review',
      executor: 'deterministic',
      status: credentialBlocker.length === 0 ? 'planned' : 'blocked', blockedBy: credentialBlocker, paths: [], preconditions: ['The server confirms project and branch identity.'],
    },
    {
      id: 'connect_database', stepId: 'build_plan', kind: 'connect_database',
      summary: 'Apply the reviewed logical-replication plan to customer-owned development Postgres.', mutation: 'database_write', approval: 'explicit',
      executor: 'deterministic',
      status: 'blocked', blockedBy: ['decision:development_database', 'contract:customer_postgres_canary'], paths: [], preconditions: ['Database is positively identified as non-production.', 'The complete database plan is approved.'],
    },
    {
      id: 'push_schema', stepId: 'build_plan', kind: 'push_schema',
      summary: 'Push the reviewed coordination schema to the confirmed development branch.', mutation: 'remote_write', approval: 'review',
      executor: 'deterministic',
      status: 'blocked', blockedBy: ['decision:coordinated_models'], paths: ['ablo/schema.ts'], preconditions: ['Local schema digest still matches the reviewed plan.', 'Branch identity is server-confirmed.'],
    },
    {
      id: 'verify_setup', stepId: 'build_plan', kind: 'verify',
      summary: 'Run static checks, prove selected models have no unclassified direct-write bypass, and consume structured readiness verdicts.', mutation: 'read_only', approval: 'none',
      executor: 'deterministic',
      status: 'blocked', blockedBy: ['action:integrate_application', 'action:adapt_write_paths', 'action:connect_database', 'action:push_schema'], paths: [], preconditions: [],
    },
    {
      id: 'run_canary', stepId: 'build_plan', kind: 'run_canary',
      summary: 'Run one coordinated canary through the customer-owned development table.', mutation: 'database_write', approval: 'explicit',
      executor: 'deterministic',
      status: 'blocked', blockedBy: ['contract:customer_postgres_canary', 'action:verify_setup'], paths: [], preconditions: ['Canary table, data, cleanup, and production exclusion contract is approved.'],
    },
  ];
  return stepResult({
    stepId: 'build_plan',
    status: 'complete',
    summary: `Built ${actions.length} typed actions; blocked actions are not executable.`,
    facts: [],
    decisions: [],
    actions,
  });
}

export async function discoverSetupPlan(input: { root?: string } = {}): Promise<SetupPlan> {
  const repositoryRoot = resolveRepositoryRoot(input.root);
  const state: DiscoveryState = {
    repositoryRoot,
    packageManifests: [],
    applicationRoot: null,
    packageName: null,
    localSchemaDigest: null,
    pushedSchemaDigest: null,
    abloProjectId: null,
    abloBranchId: null,
    compatibility: analyzeSetupCompatibility({ columns: [] }),
  };
  const program: SetupProgram<DiscoveryState> = {
    id: 'ablo-setup-plan-v1',
    steps: [
      { id: 'discover_repository', label: 'Repository discovery', mutation: 'read_only', approval: 'none', run: ({ state: value }) => localDiscoveryStep(value) },
      { id: 'discover_ablo_target', label: 'Ablo target discovery', mutation: 'read_only', approval: 'none', dependsOn: ['discover_repository'], run: ({ state: value }) => remoteDiscoveryStep(value) },
      { id: 'build_plan', label: 'Build setup plan', mutation: 'read_only', approval: 'none', dependsOn: ['discover_repository'], run: ({ state: value, results }) => plannedActions(value, results) },
    ],
  };
  const steps = await executeSetupProgram(program, { repositoryRoot, state });
  const facts = steps.flatMap(({ facts: values }) => values);
  const decisions = steps.flatMap(({ decisions: values }) => values);
  const actions = steps.flatMap(({ actions: values }) => values);
  const unresolved = decisions.filter(({ status }) => status === 'unresolved');
  const hardBlocked = actions.some(({ blockedBy }) => blockedBy.some((value) => value.startsWith('contract:')));
  return setupPlanSchema.parse({
    schemaVersion: SETUP_CONTRACT_VERSION,
    kind: 'ablo_setup_plan',
    mode: 'plan',
    createdAt: isoNow(),
    target: {
      repositoryRoot,
      applicationRoot: state.applicationRoot,
      packageName: state.packageName,
      abloProjectId: state.abloProjectId,
      abloBranchId: state.abloBranchId,
      databaseFingerprint: null,
      localSchemaDigest: state.localSchemaDigest,
      pushedSchemaDigest: state.pushedSchemaDigest,
    },
    compatibility: state.compatibility,
    steps,
    facts,
    decisions,
    actions,
    postconditions: [
      { id: 'application_integrated', description: 'The selected application integrates Ablo without replacing user-owned wiring.', status: 'unverified', evidence: [] },
      { id: 'write_paths_coordinated', description: 'Every write path for selected models uses ablo.<model>.create/update/delete or has an explicitly reviewed bypass classification.', status: 'unverified', evidence: [] },
      { id: 'target_confirmed', description: 'Project, branch, and non-production database identities are confirmed.', status: 'unverified', evidence: [] },
      { id: 'readiness', description: 'Structured readiness reports no write blocker.', status: 'unverified', evidence: [] },
      { id: 'coordinated_canary', description: 'A coordinated write is confirmed through customer-owned development Postgres.', status: 'blocked', evidence: [] },
    ],
    outcome: hardBlocked ? 'blocked' : unresolved.length > 0 ? 'needs_decisions' : 'ready_to_apply',
    summary: `${facts.length} facts, ${unresolved.length} unresolved decisions, ${actions.filter(({ status }) => status === 'blocked').length} blocked actions. No project files were changed.`,
  });
}
