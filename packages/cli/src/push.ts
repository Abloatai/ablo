/**
 * `ablo push` uploads your local schema to the hosted service.
 *
 * It imports your `defineSchema(...)` module at runtime (via jiti), serializes
 * it to JSON, and sends it to `POST /api/schema`, authenticated with your `sk_`
 * secret key. The server validates the schema, bumps its version, and activates
 * it; connecting clients are then checked against the active schema's hash.
 *
 * Where `ablo migrate` reads `schema.ts` by parsing its text, `push` needs the
 * real schema object, because only {@link serializeSchema} produces the faithful
 * representation the server stores — so `push` imports the module.
 *
 * Usage:
 *   ablo push
 *   ablo push --schema ablo/schema.ts --export schema
 *   ablo push --force
 *   ablo push --rename oldModel:newModel --rename a:b
 */

import pc from 'picocolors';
import { AbloValidationError, translateHttpError } from '@abloatai/transaction/errors';
import { classifyCredentialKind } from '@abloatai/transaction/auth/credentialPolicy';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { execFileSync } from 'child_process';
import { confirm, text, isCancel, cancel } from '@clack/prompts';
import { serializeSchema, schemaHash, type Schema } from '@abloatai/transaction/schema';
import { apiBaseUrl } from './controlPlane';
import { ambientEnvKeyNote, resolveMutationApiKey, type ResolvedKeySource } from './config';
import { resolveTarget, describeMismatches, type ResolvedTarget } from './target';
import { brand } from './theme';
import { renderCliError } from './renderError';
import { flushProductAnalytics, trackCliSchemaPushAttempted } from './telemetry';

export interface PushArgs {
  schemaPath: string;
  exportName: string;
  url: string;
  apiKey: string | undefined;
  /** Explicit dotenv file selected by the caller for this mutation. */
  envFile?: string;
  force: boolean;
  renames: { from: string; to: string }[];
  backfills: { model: string; field: string; value: string | number | boolean }[];
  /** Skip the interactive confirmation (CI / scripted deploys). */
  yes: boolean;
  /** Compute and print the plan — target, model diff, and git state — then exit
   *  without applying anything, so you can preview a deploy before running it. */
  dryRun: boolean;
}

/** Coerce a `--backfill` literal: `true`/`false` → boolean, numeric → number,
 *  else string. Keeps the CLI ergonomic without a type annotation per value. */
function coerceBackfill(raw: string): string | number | boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}

export const DEFAULT_SCHEMA_PATH = 'ablo/schema.ts';
export const DEFAULT_EXPORT = 'schema';

export const PUSH_USAGE = `  ablo push — upload a schema to one confirmed branch

  Usage:
    npx ablo push
    npx ablo push --env-file .env.production --yes
    npx ablo push --dry-run

  Credential:
    ABLO_API_KEY          Branch-bound sk_ key from the process environment
    --env-file <path>     Explicitly load ABLO_API_KEY from a dotenv file

  Safety:
    --yes, -y             Confirm non-interactively (required for the production root)
    --dry-run, --plan     Show target and schema diff without applying
    --force               Allow destructive schema changes
    --rename old:new      Record a model rename
    --backfill m.f=value  Seed existing rows for a new required field

  The server confirms the key's project and branch. Current keys do not encode
  live/test state, and push never guesses a branch from their spelling.`;

/** Formats a single migration signal — `{ model, field?, detail, shadowed? }` —
 *  for display. When `shadowed` is present, meaning a removal was diffed against
 *  an existing schema, a second line names the baseline it compares against: the
 *  version and the date it was pushed, so "incompatible" is easy to interpret. */
export function fmtSignal(s: unknown): string {
  const sig = s as {
    model?: string;
    field?: string;
    detail?: string;
    shadowed?: { environment?: string; version?: number; pushedAt?: string | null; pushedBy?: string | null };
  };
  const where = sig.field ? `${sig.model}.${sig.field}` : sig.model;
  let line = `    • ${pc.bold(where ?? '?')} — ${sig.detail ?? ''}`;
  if (sig.shadowed) {
    const env = sig.shadowed.environment ?? 'production';
    const ver = sig.shadowed.version != null ? `v${sig.shadowed.version}` : 'active';
    const when = sig.shadowed.pushedAt
      ? new Date(sig.shadowed.pushedAt).toISOString().slice(0, 10)
      : 'unknown date';
    const by = sig.shadowed.pushedBy ? ` by ${sig.shadowed.pushedBy}` : '';
    line += `\n      ${pc.dim(`↳ baseline: ${env} ${ver}, pushed ${when}${by}`)}`;
  }
  return line;
}

/** Structured outcome of a single `POST /api/schema` — no console/exit so it
 *  can be reused by both `push` (one-shot) and `dev` (watch loop). */
export interface PushResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
  bodyText: string;
}

/**
 * Sends a serialized schema to the hosted service and returns the parsed
 * result. Does the network call and nothing else — the caller decides how to
 * render success or rejection.
 */
export async function pushSchema(
  schema: Schema,
  args: Pick<PushArgs, 'url' | 'apiKey' | 'force' | 'renames' | 'backfills'>,
): Promise<PushResult> {
  trackCliSchemaPushAttempted();
  void flushProductAnalytics();
  const schemaJson = JSON.parse(serializeSchema(schema)) as unknown;
  const res = await fetch(`${args.url}/api/schema`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${args.apiKey}`,
    },
    body: JSON.stringify({
      schema: schemaJson,
      force: args.force,
      renames: args.renames,
      backfills: args.backfills,
    }),
  });
  const bodyText = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    /* non-JSON error body */
  }
  return { ok: res.ok, status: res.status, body, bodyText };
}

/** Parses the `push` command's flags into {@link PushArgs}. Does no I/O. */
export function parsePushArgs(argv: readonly string[]): PushArgs {
  let schemaPath = DEFAULT_SCHEMA_PATH;
  let exportName = DEFAULT_EXPORT;
  // Left unset unless `--url` names one: `apiBaseUrl` below applies the
  // env-then-default fallback, so the chain is written in one place.
  let url: string | undefined;
  let force = false;
  let yes = false;
  let dryRun = false;
  let envFile: string | undefined;
  const renames: { from: string; to: string }[] = [];
  const backfills: { model: string; field: string; value: string | number | boolean }[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--schema':
        schemaPath = argv[++i] ?? schemaPath;
        break;
      case '--export':
        exportName = argv[++i] ?? exportName;
        break;
      case '--url':
        url = argv[++i] ?? url;
        break;
      case '--env-file':
        envFile = argv[++i] ?? envFile;
        break;
      case '--force':
        force = true;
        break;
      case '--yes':
      case '-y':
        yes = true;
        break;
      case '--allow-dirty':
        // Accepted and ignored: git state is a note now, never a refusal, so
        // old scripts passing this keep working with nothing to override.
        break;
      case '--dry-run':
      case '--plan':
        dryRun = true;
        break;
      case '--rename': {
        const spec = argv[++i] ?? '';
        const [from, to] = spec.split(':');
        if (!from || !to) {
          throw new AbloValidationError(`--rename expects "old:new", got "${spec}"`, { code: 'cli_invalid_arguments' });
        }
        renames.push({ from, to });
        break;
      }
      case '--backfill': {
        // `model.field=value` — seed existing rows so a required-field add can
        // set NOT NULL.
        const spec = argv[++i] ?? '';
        const eq = spec.indexOf('=');
        const path = eq === -1 ? '' : spec.slice(0, eq);
        const rawValue = eq === -1 ? '' : spec.slice(eq + 1);
        const dot = path.indexOf('.');
        const modelName = dot === -1 ? '' : path.slice(0, dot);
        const fieldName = dot === -1 ? '' : path.slice(dot + 1);
        if (!modelName || !fieldName || eq === -1) {
          throw new AbloValidationError(`--backfill expects "model.field=value", got "${spec}"`, { code: 'cli_invalid_arguments' });
        }
        backfills.push({ model: modelName, field: fieldName, value: coerceBackfill(rawValue) });
        break;
      }
      default:
        throw new AbloValidationError(`unknown flag: ${arg}`, { code: 'cli_invalid_arguments' });
    }
  }

  // One resolver decides where a key may be sent, and it also makes the base
  // well-formed for `${url}/api/schema` (absolute, no trailing slash).
  url = apiBaseUrl(url);
  return {
    schemaPath,
    exportName,
    url,
    apiKey: process.env.ABLO_API_KEY,
    ...(envFile ? { envFile } : {}),
    force,
    renames,
    backfills,
    yes,
    dryRun,
  };
}

/** Dynamically import the user's schema module (TS) and return the export. */

/** Tables the customer's publication does not carry, as the push response reports them. */
interface PublicationGap {
  readonly missing: readonly string[];
  readonly remediation?: string;
}

/**
 * Read the publication advisory off a push response, or `null` when there is
 * none to report. Narrowed rather than asserted: this is an optional field on a
 * response an older engine does not send at all, so its absence is ordinary and
 * must not throw on the success path.
 */
function publicationGap(value: unknown): PublicationGap | null {
  if (typeof value !== 'object' || value === null) return null;
  if (!('missing' in value) || !Array.isArray(value.missing)) return null;
  const missing = value.missing.filter((table: unknown): table is string => typeof table === 'string');
  if (missing.length === 0) return null;
  const remediation =
    'remediation' in value && typeof value.remediation === 'string' ? value.remediation : null;
  return { missing, ...(remediation ? { remediation } : {}) };
}

export async function loadSchema(schemaPath: string, exportName: string): Promise<Schema> {
  const abs = resolve(process.cwd(), schemaPath);
  if (!existsSync(abs)) {
    throw new AbloValidationError(
      `schema not found at ${pc.bold(schemaPath)}. Run ${pc.bold('npx ablo init')} or pass ${pc.bold('--schema <path>')}.`,
      { code: 'cli_invalid_arguments' },
    );
  }
  // jiti transpiles the user's TS schema module on the fly, resolving its
  // `@abloatai/ablo` from their cwd node_modules. Imported lazily so the rest
  // of the CLI doesn't pay for it. Matches how `ablo pull drizzle` loads TS.
  const { createJiti } = await import('jiti');
  const jiti = createJiti(process.cwd());
  const mod = await jiti.import<Record<string, unknown>>(abs);
  // Depending on the module's emit (ESM vs transpiled CommonJS), the named
  // exports may surface directly or nest under `default`. Check both so a plain
  // `export const schema = …` resolves either way.
  const nested = mod.default && typeof mod.default === 'object' ? (mod.default as Record<string, unknown>) : undefined;
  const schema = mod[exportName] ?? nested?.[exportName];
  if (!schema || typeof schema !== 'object' || !('models' in (schema))) {
    throw new AbloValidationError(
      `${pc.bold(schemaPath)} has no \`${exportName}\` export that looks like a Schema. ` +
        `Did you \`export const ${exportName} = defineSchema({ ... })\`?`,
      { code: 'cli_invalid_arguments' },
    );
  }
  return schema as Schema;
}

/** Masked key for error output — `sk_CEIM…`, never the full secret. */
function maskKey(key: string | undefined): string {
  return key ? `${key.slice(0, 12)}…` : '(none)';
}

/**
 * A branch-storage rejection happens after the schema-authoring gate. Keep this
 * fact in one helper so both one-shot `push` and the `dev` watcher cannot turn
 * the same 403 into a fictitious missing-scope diagnosis.
 */
export function schemaPushStorageHint(code: unknown): string | null {
  if (code === 'no_data_source_registered') {
    return (
      `This branch is not connected to your database yet. Run ${pc.bold('ablo connect')} ` +
      `for this branch, then retry the schema push.`
    );
  }
  return null;
}

/**
 * Uncommitted-schema guard. A deploy should be traceable to a commit, so we
 * check whether the schema file differs from git HEAD. Returns `null` when not
 * in a git repo / git is unavailable — non-git users are never blocked.
 */
function schemaGitState(schemaPath: string): { dirty: boolean; untracked: boolean } | null {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--', schemaPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out === '') return { dirty: false, untracked: false };
    return { dirty: true, untracked: out.startsWith('??') };
  } catch {
    return null;
  }
}

/** A model in the deployed schema (`GET /api/schema`). */
interface RemoteModel {
  key: string;
}
interface RemoteSchema {
  active?: boolean;
  version?: number;
  models?: RemoteModel[];
}

/** Best-effort read of the schema currently active for this key, used only for
 *  the diff preview. Any failure returns null and never blocks the push — the
 *  server still computes the authoritative diff when the schema is applied. */
async function fetchActiveSchema(url: string, apiKey: string): Promise<RemoteSchema | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => { ctrl.abort(); }, 3000);
  try {
    const res = await fetch(`${url}/api/schema`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as RemoteSchema;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Model keys from the serialized local schema. */
function localModels(schema: Schema): Set<string> {
  const json = JSON.parse(serializeSchema(schema)) as {
    models: Record<string, unknown>;
  };
  return new Set(Object.keys(json.models));
}

/**
 * Prints models added or removed against the deployed schema.
 * Field-level destructive changes are caught authoritatively by the server when
 * the schema is applied (it returns `warnings` and `unexecutable`); this is the
 * human-readable preview shown beforehand.
 */
function printPlan(local: Set<string>, remote: RemoteSchema | null): void {
  if (!remote?.models) {
    console.log(`  ${pc.dim('plan')}     ${pc.dim('(deployed schema unavailable — the server computes the diff on apply)')}\n`);
    return;
  }
  const remoteKeys = new Set(remote.models.map((model) => model.key));

  const added = [...local].filter((key) => !remoteKeys.has(key));
  const removed = [...remoteKeys].filter((key) => !local.has(key));
  const verLabel = remote.version != null ? `v${remote.version}` : 'active';

  if (added.length === 0 && removed.length === 0) {
    console.log(`  ${pc.dim('plan')}     ${pc.dim(`no model-level changes vs deployed ${verLabel} (any field changes apply on push)`)}\n`);
    return;
  }
  console.log(`  ${pc.dim('plan')}     ${pc.dim(`vs deployed ${verLabel}:`)}`);
  for (const k of added) console.log(`           ${pc.green(`+ ${k}`)} ${pc.dim('(new model)')}`);
  for (const k of removed) console.log(`           ${pc.red(`- ${k}`)} ${pc.dim('(removed — destructive, needs --force)')}`);
  console.log('');
}

/**
 * Pre-flight gate run after the banner + plan, before the write. Encodes the
 * child/root separation: a child confirms interactively (and proceeds silently
 * when not a TTY); the production root requires a typed confirmation (TTY) or
 * an explicit `--yes` (CI).
 *
 * Deliberately NO git gate: Ablo blocks only on what it is authoritative
 * about — the DESTINATION (the typed project-name confirmation below). Whether
 * the schema file is committed is the user's workflow, so git state is a
 * one-line note earlier in the flow, never a refusal. (The old refusal was
 * also theater: `--yes` skipped it, so CI never saw it and only humans paid.)
 * Calls `process.exit(1)` on refusal/cancel; returns when clear to apply.
 */
async function confirmPush(args: PushArgs, target: ResolvedTarget): Promise<void> {
  const confirmedRoot = target.confirmed?.branchRoot;
  const legacyEnv = target.keyEnv;
  if (confirmedRoot === undefined && legacyEnv === null) {
    console.error(
      `  ${pc.red('✗')} Refusing to deploy because the server did not confirm which branch this key targets.`,
    );
    console.error(
      pc.dim(
        `    Current ${pc.bold('sk_')} keys do not encode live/test state. Check connectivity with ` +
          `${pc.bold('ablo whoami')} and retry; the CLI will not guess for a write.`,
      ),
    );
    process.exit(1);
    return;
  }
  const isProd = confirmedRoot ?? legacyEnv === 'production';
  const tty = Boolean(process.stdout.isTTY && process.stdin.isTTY);

  if (isProd && !args.yes) {
    if (!tty) {
      console.error(`  ${pc.red('✗')} Refusing to deploy to ${pc.red(pc.bold('production'))} non-interactively without confirmation.`);
      console.error(pc.dim(`    Re-run with ${pc.bold('--yes')} to confirm in CI/scripts.`));
      process.exit(1);
    }
    // Type the SERVER-CONFIRMED project, so confirming a production push means
    // acknowledging the real destination by name. This is what makes a
    // wrong-project deploy impossible to do by reflex: when the key targets a
    // project other than the one selected locally, the operator must type the
    // key's actual project to proceed. Falls back to the local slug, then
    // `production`, only when the server couldn't confirm a project.
    //
    // A name the operator cannot read is worse than no name: an id gets pasted
    // rather than recognised, so the prompt stops being a check and becomes a
    // transcription. When the project could not be named (`name === null` — the
    // project list did not answer), ask for `production` instead, which is the
    // thing actually being acknowledged.
    const confirmedProject = target.confirmed?.project;
    const named = confirmedProject && (confirmedProject.isDefault || confirmedProject.name !== null);
    const expected = named
      ? (confirmedProject.isDefault ? 'default' : confirmedProject.slug)
      : (target.localProject?.slug ?? 'production');
    const destination = confirmedProject && !named ? ` (project ${confirmedProject.id})` : '';
    const typed = await text({
      message: `This deploys to ${pc.bold('production')}${destination ? pc.dim(destination) : ` project ${pc.bold(expected)}`}. Type ${pc.bold(expected)} to confirm:`,
      placeholder: expected,
    });
    if (isCancel(typed) || String(typed).trim() !== expected) {
      cancel('Aborted — confirmation did not match.');
      process.exit(1);
    }
    return;
  }

  // Child branch: confirm interactively; proceed silently when not a TTY so the
  // dev loop and scripted branch deploys do not hang on stdin.
  if (!isProd && !args.yes && tty) {
    const branch = target.confirmed?.branchId;
    const ok = await confirm({
      message: `Apply to development branch${branch ? ` ${pc.bold(branch)}` : ''}?`,
    });
    if (isCancel(ok) || !ok) {
      cancel('Aborted.');
      process.exit(1);
    }
  }
}

/**
 * Prints a target banner before every push so the deploy destination is never a
 * guess. It's easy to build an app against one schema and deploy to a different
 * project or environment without noticing; the banner names exactly where the
 * push will land — the SERVER-CONFIRMED org, project, and environment the key
 * resolves to ({@link resolveTarget}), not a local preference that can silently
 * disagree with the key. When the server can't confirm (offline, or an older
 * server), it falls back to the local view and marks it unconfirmed so the
 * uncertainty is visible rather than assumed away.
 */
function printPushTarget(
  target: ResolvedTarget,
  schema: { path: string; modelCount: number; hash: string },
): void {
  const confirmed = target.confirmed;
  const branchLabel =
    confirmed?.branchRoot === true
      ? pc.bold('production root')
      : confirmed?.branchId
        ? `${pc.bold('branch')} ${pc.bold(confirmed.branchId)}`
        : target.keyEnv === 'production'
          ? `${pc.bold('production root')} ${pc.yellow('(legacy key; unconfirmed)')}`
          : target.keyEnv === 'sandbox'
            ? `${pc.bold('development branch')} ${pc.yellow('(legacy key; unconfirmed)')}`
            : pc.red('unknown branch');
  // Project + org: server-confirmed when available, otherwise the local
  // preference with an explicit "unconfirmed" marker.
  let projectLabel: string;
  if (confirmed?.project) {
    const p = confirmed.project;
    // `name === null` means the project list could not name this id, so `slug`
    // holds the id (see nameProject). Printing `id (id)` reads as a project
    // called by its own id; say the name is unresolved instead, once.
    projectLabel = p.isDefault
      ? `${pc.bold('default')} ${pc.dim('(org-default)')} ${pc.dim(`(${p.id})`)}`
      : p.name === null
        ? `${pc.bold(p.id)} ${pc.yellow(`(unnamed — ${p.unnamedReason ?? 'the project list did not answer'})`)}`
        : `${pc.bold(p.slug)} ${pc.dim(`(${p.id})`)}`;
  } else if (confirmed) {
    // Identity resolved but carried no project (human session / older server).
    projectLabel = `${pc.bold('default')} ${pc.dim('(org-default)')}`;
  } else {
    const local = target.localProject;
    const shown = local ? `${pc.bold(local.slug)} ${pc.dim(`(${local.id})`)}` : `${pc.bold('default')} ${pc.dim('(org-default)')}`;
    projectLabel = `${shown} ${pc.yellow('(unconfirmed — server did not answer)')}`;
  }

  // ONE statement of the target — never two truths on this line. A divergence
  // from the saved workspace selection is the note below, not a parenthetical.
  console.log(`\n  ${brand('ablo')} ${pc.dim('push')} ${pc.dim('→')} ${branchLabel}`);
  if (confirmed?.organizationId) console.log(`  ${pc.dim('org')}      ${pc.dim(confirmed.organizationId)}`);
  console.log(`  ${pc.dim('project')}  ${projectLabel}`);
  console.log(`  ${pc.dim('target')}   ${pc.dim(target.url)}`);
  console.log(
    `  ${pc.dim('key')}      ${target.keyPrefix} ${pc.dim(`(${describeKeySource(target.keySource)})`)}`,
  );
  console.log(
    `  ${pc.dim('schema')}   ${pc.bold(schema.path)} ${pc.dim(`${schema.modelCount} models, hash ${schema.hash}`)}\n`,
  );
}

/** Prints each local-intent-vs-key divergence as a prose warning. Returns
 *  whether any project-level drift was found — the kind a production push must
 *  make the operator acknowledge by name. */
function warnMismatches(target: ResolvedTarget): { projectDrift: boolean } {
  const projectDrift = target.mismatches.some((m) => m.kind === 'project');
  const note = describeMismatches(target.mismatches);
  if (note) console.log(`  ${pc.yellow('⚠')}  ${pc.yellow(note)}\n`);
  return { projectDrift };
}

/** Human label for where the resolved key came from. */
function describeKeySource(source: ResolvedKeySource): string {
  switch (source) {
    case 'env':
      return 'ABLO_API_KEY';
    case '.env.local':
      return '.env.local';
    case '.env':
      return '.env';
    case 'stored':
      return 'ablo login';
    case 'explicit-file':
      return '--env-file';
  }
}

export async function push(argv: readonly string[]): Promise<void> {
  let args: PushArgs;
  try {
    args = parsePushArgs(argv);
  } catch (err) {
    console.error(pc.red(`  ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  if (args.envFile) {
    try {
      process.loadEnvFile(args.envFile);
    } catch (error) {
      throw new AbloValidationError(
        `could not load --env-file ${args.envFile}: ${error instanceof Error ? error.message : String(error)}`,
        { code: 'cli_invalid_arguments' },
      );
    }
    args.apiKey = process.env.ABLO_API_KEY;
  }

  // Mutations use the process environment, an explicitly selected env file, or
  // a legacy stored credential. An ambient dotenv file never silently chooses
  // the branch.
  let keySource: ResolvedKeySource = 'env';
  if (!args.apiKey) {
    args.apiKey = resolveMutationApiKey();
    keySource = args.apiKey ? 'stored' : 'env';
  } else if (args.envFile) {
    keySource = 'explicit-file';
  }

  if (!args.apiKey) {
    const ambient = ambientEnvKeyNote();
    console.error(
      pc.red(`  No API key.`) +
        pc.dim(
          ` Run ${pc.bold('ablo login')}, or set ${pc.bold('ABLO_API_KEY')} to a branch-bound ${pc.bold('sk_')} credential.` +
            (ambient
              ? ` A project env file contains one; select it explicitly with ${pc.bold('npx ablo push --env-file .env.local')}.`
              : ''),
        ),
    );
    process.exit(1);
  }

  const schema = await loadSchema(args.schemaPath, args.exportName);
  const hash = schemaHash(schema);

  // Resolve the true target from the key: the server-confirmed org, project, and
  // branch it acts on, reconciled against the local `ablo projects use`
  // preference. Everything shown and confirmed below reads from
  // this one resolution, so the banner can't say one thing while the push does
  // another.
  const target = await resolveTarget({ url: args.url, apiKey: args.apiKey, keySource });

  printPushTarget(target, {
    path: args.schemaPath,
    modelCount: Object.keys(schema.models).length,
    hash,
  });

  // Plan preview — the model-level diff against the deployed schema.
  const remote = await fetchActiveSchema(args.url, args.apiKey);
  printPlan(localModels(schema), remote);

  // Local-intent-vs-key divergences: the selected project isn't the key's
  // project, or the CLI mode isn't the key's environment. Named in prose so the
  // "wrong project" surprise happens here, before the write, not after.
  warnMismatches(target);

  // Git state — warn about a deploy that won't match a commit; never block it.
  const git = schemaGitState(args.schemaPath);
  if (git?.dirty) {
    const what = git.untracked ? 'is untracked (not committed)' : 'has uncommitted changes';
    console.log(`  ${pc.yellow('⚠')}  ${pc.bold(args.schemaPath)} ${what} — this deploy won't match a git commit.\n`);
  }

  if (args.dryRun) {
    console.log(`  ${pc.dim('○')} dry run — nothing applied. Re-run without ${pc.bold('--dry-run')} to deploy.`);
    return;
  }

  // Child/root branch separation + confirmation (exits on refusal). On the
  // production root this requires typing the key's real project name.
  await confirmPush(args, target);

  const { ok: resOk, status, body, bodyText } = await pushSchema(schema, args);

  if (resOk) {
    if (body.unchanged) {
      console.log(`  ${pc.dim('○')} No changes — schema already active (v${body.version}).`);
    } else {
      console.log(`  ${pc.green('✓')} Activated ${pc.bold(`v${body.version}`)} ${pc.dim(`(hash ${body.hash})`)}`);
      // A forced destructive push echoes what data-affecting changes ran.
      if (Array.isArray(body.warnings) && body.warnings.length > 0) {
        console.log(pc.yellow(`  Applied ${body.warnings.length} destructive change(s):`));
        for (const w of body.warnings) console.log(pc.yellow(fmtSignal(w)));
      }
      // The schema is recorded, but this plane's engine role is intentionally not
      // allowed to run DDL, so its tables were not created here. New models exist
      // as metadata only until they are provisioned out-of-band.
      if (body.provisioningDeferred === true) {
        console.log(
          pc.yellow(
            `  Your schema is registered, but its tables were not created on this plane — ` +
              `the engine's runtime role does not run DDL here.`,
          ),
        );
        console.log(
          pc.dim(
            `  New models are recorded as metadata; provision their tables out-of-band ` +
              `before you read or write them.`,
          ),
        );
      }
      // Tables the customer's publication does not carry. Ablo streams changes
      // only for published tables, so a model missing from it is accepted at
      // commit and never confirmed — the table looks frozen while everything
      // else works. Reported here because push is where Ablo learns the model
      // exists, whichever tool created the table; and only reported, because
      // adding a table to a publication requires owning it and Ablo's roles
      // deliberately own nothing.
      const publication = publicationGap(body.publication);
      if (publication) {
        const names = publication.missing.map((t) => pc.bold(t)).join(', ');
        console.log(
          `\n  ${pc.yellow('!')} Ablo is not receiving changes for ${names} yet.`
        );
        console.log(
          pc.dim(
            `    Your database streams only the tables it has been told to publish, and ` +
              `these\n    are not on that list, so writes to them are accepted and never confirmed.`
          )
        );
        if (publication.remediation) {
          console.log(`\n    Run this on your database:\n      ${pc.cyan(publication.remediation)}\n`);
        }
      }
    }
    return;
  }

  // Friendly messages for the expected rejection shapes.
  if (status === 409) {
    if (body.code === 'replication_reset_required') {
      const models = Array.isArray(body.models) ? body.models : [];
      console.error(pc.red('  Replication reset required — this connected log plane still has live rows for a removed model.'));
      for (const model of models) console.error(pc.yellow(`  Live vanished model: ${String(model)}`));
      console.error(
        pc.dim(
          `  Declare the intent with ${pc.bold('--rename old:new')} to carry the model forward, ` +
            `or ${pc.bold('--force')} to accept the drop/reset explicitly.`,
        ),
      );
      return;
    }
    const unexecutable = Array.isArray(body.unexecutable) ? body.unexecutable : [];
    const warnings = Array.isArray(body.warnings) ? body.warnings : [];
    console.error(pc.red('  Incompatible change — this push is not safe to apply as-is.'));
    if (unexecutable.length > 0) {
      console.error(pc.red(`  Unexecutable (would fail on existing rows):`));
      for (const u of unexecutable) console.error(pc.red(fmtSignal(u)));
    }
    if (warnings.length > 0) {
      console.error(pc.yellow(`  Destructive (data loss):`));
      for (const w of warnings) console.error(pc.yellow(fmtSignal(w)));
    }
    const hasShadowed = [...unexecutable, ...warnings].some(
      (s) => (s as { shadowed?: unknown }).shadowed != null,
    );
    if (hasShadowed) {
      console.error(
        pc.dim(
          '  These models exist in the baseline above but not in your push. Sandbox readers fall',
        ),
      );
      console.error(
        pc.dim(
          '  back to the production schema until you push your own, so applying this drops them.',
        ),
      );
    }
    console.error(pc.dim(`  Re-push with ${pc.bold('--force')} to override, or use ${pc.bold('--rename old:new')} if you renamed a model.`));
  } else if (status === 403) {
    // Choose remediation from the machine-readable code, not the HTTP status. A
    // 403 caused by row-level security is a database-configuration problem, not a
    // key-scope one, so telling the user they "need schema:push" would send them
    // down the wrong path. Lead with the server's real message and code, then
    // give advice specific to that code.
    const code = (body.code ?? body.reason) as string | undefined;
    const serverMsg = (body.message ?? body.reason) as string | undefined;
    console.error(pc.red(`  Forbidden${code ? ` [${code}]` : ''}: ${serverMsg ?? 'permission denied'}`));
    // Name which key the push used and where it came from, since the common
    // confusion is a legacy stored runtime key being used instead of the intended
    // key placed in `.env.local`.
    console.error(pc.dim(`  Push used ${pc.bold(maskKey(args.apiKey))} from ${describeKeySource(keySource)}.`));
    const storageHint = schemaPushStorageHint(code);
    if (storageHint) {
      console.error(pc.dim(`  ${storageHint}`));
    } else if (code === 'database_role_cannot_enforce_rls') {
      console.error(
        pc.dim(
          `  Your database role bypasses row-level security. Run ${pc.bold('npx ablo migrate')} to ` +
            `create a scoped (NOBYPASSRLS) role and repoint DATABASE_URL, then re-push.`,
        ),
      );
    } else if (code === 'database_tables_unforced_rls') {
      console.error(
        pc.dim(
          `  One or more synced tables don't have FORCE ROW LEVEL SECURITY. Run ` +
            `${pc.bold('npx ablo migrate')} to (re)apply the tenant policies, then re-push.`,
        ),
      );
    } else if (code === 'capability_scope_denied' || code === 'capability_invalid') {
      // Not a key-scope problem. `capability_scope_denied` means the database
      // returned Postgres error 42501 (insufficient_privilege) — the connected
      // role, or its row-level security, refused the write. The `schema:push`
      // permission gate is a different code (`forbidden`). A different API key
      // won't fix this: the role behind this organization's database can't write
      // the target, or the database has no role that can.
      console.error(
        pc.dim(
          `  This is a ${pc.bold('database privilege')} error (Postgres 42501 / row-level security), not a key scope — ` +
            `a different API key won't help. The role behind this org's database can't write the target. ` +
            `Provision a writable, RLS-scoped role with ${pc.bold('npx ablo migrate')}, or check the org's database ` +
            `registration. See docs/plans/read-path-logical-replication-vs-hosting.md.`,
        ),
      );
    } else if (code === 'schema_provisioning_forbidden') {
      // The key authenticated and passed the schema:push gate — then the target
      // database refused the CREATE TABLE DDL (Postgres 42501). The engine's
      // runtime role deliberately can't run DDL, so this is the branch's
      // storage shape, not a key scope: a different API key changes nothing
      // about what the database permits.
      console.error(
        pc.dim(
          `  This is not a key problem — the push was authorized, but the target database refused ` +
            `to let the engine create tables (Postgres 42501). On the replication read path Ablo ` +
            `never runs DDL: register your database as a data source with ${pc.bold('npx ablo connect register')}, ` +
            `and pushes to that branch record the schema as metadata only — no tables are created anywhere.`,
        ),
      );
    } else if (args.apiKey != null && classifyCredentialKind(args.apiKey) === 'restricted') {
      // A restricted key may authenticate without carrying schema:push. Name
      // the branch-bound secret key that can push instead of leaving a dead end.
      console.error(
        pc.dim(
          `  Schema pushes need a branch-bound SECRET ${pc.bold('sk_')} key. ` +
            `Use ${pc.bold('ablo dev')} for a development child or ${pc.bold('ablo push')} with a root-bound key for production.`,
        ),
      );
    } else {
      // Any other 403 on push means the key authenticated but isn't authorized
      // to author schema (it needs the schema:push capability). Most often the
      // wrong key is in use, so frame the fix around where keys are resolved.
      console.error(
        pc.dim(
          `  This key isn't authorized to push schema (needs ${pc.bold('schema:push')}). ` +
            (keySource === 'stored'
              ? `The stored login is management-only. Put a branch-bound ${pc.bold('sk_')} key with ` +
                `${pc.bold('schema:push')} in ${pc.bold('.env.local')} or ${pc.bold('ABLO_API_KEY')} and retry. `
              : `Use a branch-bound ${pc.bold('sk_')} key with ${pc.bold('schema:push')}. `) +
            `Manage keys at https://abloatai.com`,
        ),
      );
    }
  } else {
    // Everything the server rejects arrives as the standard error envelope, so
    // rebuild the typed error and let the ONE renderer lay it out — code, docs
    // link, recovery hint, request id. Printing `body.message` alone threw all
    // of that away: a stale plane registration reached the terminal as a bare
    // `password authentication failed for user '<role>'`, naming a role but not
    // the host, the environment, or a next step.
    renderCliError(translateHttpError(status, Object.keys(body).length > 0 ? body : bodyText));
  }
  process.exit(1);
}
