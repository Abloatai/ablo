/**
 * `ablo push` — upload the local schema to the hosted sync-server.
 *
 * Serializes the user's `defineSchema(...)` (imported at runtime via jiti) to
 * its JSON form and POSTs it to `POST /api/schema`, authed by the `sk_`
 * secret key. The server validates, version-bumps, and activates it; a
 * connecting client is then gated against the active schema's hash.
 *
 * Unlike `migrate` (which regex-parses `schema.ts`), `push` needs the real
 * schema object — only `serializeSchema` produces the faithful AST the server
 * stores — so it imports the module.
 *
 * Usage:
 *   ablo push
 *   ablo push --schema ablo/schema.ts --export schema
 *   ablo push --force
 *   ablo push --rename oldModel:newModel --rename a:b
 */

import pc from 'picocolors';
import { AbloValidationError } from '../errors.js';
import { classifyCredentialKind } from '../auth/credentialPolicy.js';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { execFileSync } from 'child_process';
import { confirm, text, isCancel, cancel } from '@clack/prompts';
import { serializeSchema, schemaHash, type Schema } from '@abloatai/ablo/schema';
import { resolveApiKey, getMode, getActiveProject, modeFromKey } from './config';
import { readProjectApiKey, type ApiKeySource } from './dbRole';
import { brand } from './theme';

export interface PushArgs {
  schemaPath: string;
  exportName: string;
  url: string;
  apiKey: string | undefined;
  force: boolean;
  renames: { from: string; to: string }[];
  backfills: { model: string; field: string; value: string | number | boolean }[];
  /** Skip the interactive confirmation (CI / scripted deploys). */
  yes: boolean;
  /** Don't refuse a production push when the schema file has uncommitted changes. */
  allowDirty: boolean;
  /** Compute and print the plan (target + model diff + git state), then exit
   *  WITHOUT applying — the `terraform plan` / `prisma migrate diff` of push. */
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
export const DEFAULT_URL = 'https://api.abloatai.com';

/** Format a single migration signal `{ model, field?, detail, shadowed? }` for
 *  the CLI. When `shadowed` is present (a removal diffed against an existing
 *  artifact), a second line names the baseline — version + WHEN it was pushed —
 *  so the user understands what "incompatible" is comparing against. */
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
 * POST a serialized schema to the control plane and return the parsed result.
 * Pure I/O — the caller decides how to render success/rejection.
 */
export async function pushSchema(
  schema: Schema,
  args: Pick<PushArgs, 'url' | 'apiKey' | 'force' | 'renames' | 'backfills'>,
): Promise<PushResult> {
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

/** Parse `push` flags. Pure — unit-tested without touching the network. */
export function parsePushArgs(argv: readonly string[]): PushArgs {
  let schemaPath = DEFAULT_SCHEMA_PATH;
  let exportName = DEFAULT_EXPORT;
  let url = process.env.ABLO_API_URL ?? DEFAULT_URL;
  let force = false;
  let yes = false;
  let allowDirty = false;
  let dryRun = false;
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
      case '--force':
        force = true;
        break;
      case '--yes':
      case '-y':
        yes = true;
        break;
      case '--allow-dirty':
        allowDirty = true;
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

  // Strip a trailing slash so `${url}/api/schema` is well-formed.
  url = url.replace(/\/+$/, '');
  return { schemaPath, exportName, url, apiKey: process.env.ABLO_API_KEY, force, renames, backfills, yes, allowDirty, dryRun };
}

/** Dynamically import the user's schema module (TS) and return the export. */
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
  // Depending on the module's emit (ESM vs transpiled CJS), the named exports
  // may surface directly OR nest under `default`. Check both so a plain
  // `export const schema = …` resolves either way.
  const nested = mod.default && typeof mod.default === 'object' ? (mod.default as Record<string, unknown>) : undefined;
  const schema = mod[exportName] ?? nested?.[exportName];
  if (!schema || typeof schema !== 'object' || !('models' in (schema as object))) {
    throw new AbloValidationError(
      `${pc.bold(schemaPath)} has no \`${exportName}\` export that looks like a Schema. ` +
        `Did you \`export const ${exportName} = defineSchema({ ... })\`?`,
      { code: 'cli_invalid_arguments' },
    );
  }
  return schema as Schema;
}

/** Masked key for error output — `sk_test_CEIM…`, never the full secret. */
function maskKey(key: string | undefined): string {
  return key ? `${key.slice(0, 12)}…` : '(none)';
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

/** A model on the deployed plane (`GET /api/schema`) — key + conflict policy. */
interface RemoteModel {
  key: string;
  conflict: Record<string, string> | null;
}
interface RemoteSchema {
  active?: boolean;
  version?: number;
  models?: RemoteModel[];
}

/** Best-effort read of the schema CURRENTLY ACTIVE on the key's plane, for the
 *  diff preview. Any failure → null (the server still computes the real diff on
 *  apply); never blocks the push. Mirrors `status`'s fetch. */
async function fetchActiveSchema(url: string, apiKey: string): Promise<RemoteSchema | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3000);
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

/** Compact conflict string for a diff line: `{user:overwrite,agent:reject}` or ''. */
function conflictStr(c: Record<string, string> | null | undefined): string {
  if (!c) return '';
  const parts = (['user', 'agent', 'system'] as const).flatMap((k) => (c[k] ? [`${k}:${c[k]}`] : []));
  return parts.length ? `{${parts.join(',')}}` : '';
}

/** Local model summary from the serialized schema: key → conflict string. */
function localModels(schema: Schema): Map<string, string> {
  const json = JSON.parse(serializeSchema(schema)) as {
    models: Record<string, { conflict?: Record<string, string> | null }>;
  };
  const out = new Map<string, string>();
  for (const [key, def] of Object.entries(json.models)) out.set(key, conflictStr(def.conflict));
  return out;
}

/**
 * Print the model-level plan (added / removed / conflict-changed) against the
 * deployed schema — the at-a-glance `terraform plan`. Field-level destructive
 * changes are caught authoritatively by the server's gate on apply (it returns
 * `warnings`/`unexecutable`); this is the human preview before that.
 */
function printPlan(local: Map<string, string>, remote: RemoteSchema | null): void {
  if (!remote?.models) {
    console.log(`  ${pc.dim('plan')}     ${pc.dim('(deployed schema unavailable — the server computes the diff on apply)')}\n`);
    return;
  }
  const remoteMap = new Map<string, string>();
  for (const m of remote.models) remoteMap.set(m.key, conflictStr(m.conflict));

  const added = [...local.keys()].filter((k) => !remoteMap.has(k));
  const removed = [...remoteMap.keys()].filter((k) => !local.has(k));
  const changed = [...local.keys()].filter((k) => remoteMap.has(k) && remoteMap.get(k) !== local.get(k));
  const verLabel = remote.version != null ? `v${remote.version}` : 'active';

  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    console.log(`  ${pc.dim('plan')}     ${pc.dim(`no model-level changes vs deployed ${verLabel} (any field changes apply on push)`)}\n`);
    return;
  }
  console.log(`  ${pc.dim('plan')}     ${pc.dim(`vs deployed ${verLabel}:`)}`);
  for (const k of added) console.log(`           ${pc.green(`+ ${k}`)} ${pc.dim('(new model)')}`);
  for (const k of changed)
    console.log(`           ${pc.yellow(`~ ${k}`)} ${pc.dim(`conflict ${remoteMap.get(k) || '(default)'} → ${local.get(k) || '(default)'}`)}`);
  for (const k of removed) console.log(`           ${pc.red(`- ${k}`)} ${pc.dim('(removed — destructive, needs --force)')}`);
  console.log('');
}

/**
 * Pre-flight gate run after the banner + plan, before the write. Encodes the
 * sandbox/production separation: sandbox confirms interactively (and proceeds
 * silently when not a TTY, so the dev/CI loop never hangs); production is gated
 * hard — uncommitted schema is refused (unless `--allow-dirty`), and applying
 * requires a typed confirmation (TTY) or an explicit `--yes` (CI). Calls
 * `process.exit(1)` on refusal/cancel; returns when clear to apply.
 */
async function confirmPush(
  args: PushArgs,
  env: 'production' | 'sandbox' | null | undefined,
): Promise<void> {
  const isProd = env === 'production';
  const tty = Boolean(process.stdout.isTTY && process.stdin.isTTY);

  if (isProd && !args.yes) {
    const git = schemaGitState(args.schemaPath);
    if (git?.dirty && !args.allowDirty) {
      console.error(`  ${pc.red('✗')} Refusing to deploy uncommitted schema to ${pc.red(pc.bold('production'))}.`);
      console.error(pc.dim(`    Commit ${pc.bold(args.schemaPath)} first, or pass ${pc.bold('--allow-dirty')} to override.`));
      process.exit(1);
    }
    if (!tty) {
      console.error(`  ${pc.red('✗')} Refusing to deploy to ${pc.red(pc.bold('production'))} non-interactively without confirmation.`);
      console.error(pc.dim(`    Re-run with ${pc.bold('--yes')} to confirm in CI/scripts.`));
      process.exit(1);
    }
    const project = getActiveProject();
    const expected = project?.slug ?? 'production';
    const typed = await text({
      message: `This deploys to ${pc.red(pc.bold('PRODUCTION'))}. Type ${pc.bold(expected)} to confirm:`,
      placeholder: expected,
    });
    if (isCancel(typed) || String(typed).trim() !== expected) {
      cancel('Aborted — confirmation did not match.');
      process.exit(1);
    }
    return;
  }

  // Sandbox: confirm interactively; proceed silently when not a TTY so the dev
  // loop / scripted sandbox deploys don't hang on stdin.
  if (!isProd && !args.yes && tty) {
    const ok = await confirm({ message: `Apply to ${pc.green('sandbox')}?` });
    if (isCancel(ok) || !ok) {
      cancel('Aborted.');
      process.exit(1);
    }
  }
}

/**
 * `prisma migrate`-style target banner — printed before every push so the
 * deploy target is never a guess. The drift the demo hit (app built against
 * one schema, a DIFFERENT schema deployed) happens when you can't see WHICH
 * project/environment a push lands on. The environment is read from the KEY,
 * not the CLI mode: the resolved key's plane is the real target, and a key
 * whose env disagrees with the active mode is exactly the silent footgun.
 */
function printPushTarget(opts: {
  schemaPath: string;
  url: string;
  apiKey: string;
  keySource: ApiKeySource | 'login';
  modelCount: number;
  hash: string;
}): void {
  const env = modeFromKey(opts.apiKey);
  const envLabel =
    env === 'production'
      ? pc.red(pc.bold('production'))
      : env === 'sandbox'
        ? pc.green('sandbox')
        : pc.yellow('unknown env');
  const project = getActiveProject();
  const projectLabel = project
    ? `${pc.bold(project.slug)} ${pc.dim(`(${project.id})`)}`
    : `${pc.bold('default')} ${pc.dim('(org-default — `ablo projects use <slug>` to scope)')}`;
  // Flag the drift trap: CLI mode and the key's plane disagree → you may be
  // pushing somewhere other than where `ablo status` implies.
  const cliMode = getMode();
  const modeNote =
    env && env !== cliMode
      ? ` ${pc.yellow(`(CLI mode is ${cliMode} — this key targets ${env})`)}`
      : '';

  console.log(`\n  ${brand('ablo')} ${pc.dim('push')} ${pc.dim('→')} ${envLabel}${modeNote}`);
  console.log(`  ${pc.dim('project')}  ${projectLabel}`);
  console.log(`  ${pc.dim('target')}   ${pc.dim(opts.url)}`);
  console.log(
    `  ${pc.dim('key')}      ${maskKey(opts.apiKey)} ${pc.dim(`(${describeKeySource(opts.keySource)})`)}`,
  );
  console.log(
    `  ${pc.dim('schema')}   ${pc.bold(opts.schemaPath)} ${pc.dim(`· ${opts.modelCount} models · hash ${opts.hash}`)}\n`,
  );
}

/** Human label for where the resolved key came from. */
function describeKeySource(source: ApiKeySource | 'login'): string {
  switch (source) {
    case 'env':
      return 'ABLO_API_KEY (environment)';
    case '.env.local':
      return '.env.local';
    case '.env':
      return '.env';
    case 'login':
      return '`ablo login` (stored sandbox config)';
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

  // Resolve the key the way the app's framework does: ABLO_API_KEY from
  // process.env (set by parsePushArgs) → .env.local → .env → the stored
  // `ablo login` credential. `npx ablo` has NO framework env loader, so a key a
  // developer put in `.env.local` (the natural place) is invisible to
  // process.env — without this, push silently uses the stored sandbox login key
  // instead of the production key in .env.local (the reported bug). `keySource`
  // is tracked so a 403 can say exactly WHICH key it used and WHERE it came from.
  let keySource: ApiKeySource | 'login' = 'env';
  if (!args.apiKey) {
    const fromProject = readProjectApiKey();
    if (fromProject) {
      args.apiKey = fromProject.key;
      keySource = fromProject.source;
    } else {
      args.apiKey = resolveApiKey();
      keySource = 'login';
    }
  }

  if (!args.apiKey) {
    // Message contract: enumerate the doors — both environments exist.
    console.error(
      pc.red(`  No API key.`) +
        pc.dim(
          ` Run ${pc.bold('npx ablo login')} for the sandbox dev loop — or set ${pc.bold('ABLO_API_KEY')} ` +
            `(${pc.bold('sk_test_')} = sandbox; ${pc.bold('sk_live_')} = deliberate production deploy). ` +
            `Mode is currently '${getMode()}'.`,
        ),
    );
    process.exit(1);
  }

  const schema = await loadSchema(args.schemaPath, args.exportName);
  const hash = schemaHash(schema);

  printPushTarget({
    schemaPath: args.schemaPath,
    url: args.url,
    apiKey: args.apiKey,
    keySource,
    modelCount: Object.keys((schema as Schema).models).length,
    hash,
  });

  // Plan preview — the model-level diff against the deployed schema.
  const remote = await fetchActiveSchema(args.url, args.apiKey);
  printPlan(localModels(schema), remote);

  // Git state — surface an untraceable deploy (not yet a hard block on sandbox).
  const git = schemaGitState(args.schemaPath);
  if (git?.dirty) {
    const what = git.untracked ? 'is untracked (not committed)' : 'has uncommitted changes';
    console.log(`  ${pc.yellow('⚠')}  ${pc.bold(args.schemaPath)} ${what} — this deploy won't match a git commit.\n`);
  }

  if (args.dryRun) {
    console.log(`  ${pc.dim('○')} dry run — nothing applied. Re-run without ${pc.bold('--dry-run')} to deploy.`);
    return;
  }

  // Sandbox/production separation + confirmation (exits on refusal).
  await confirmPush(args, modeFromKey(args.apiKey));

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
    }
    return;
  }

  // Friendly messages for the expected rejection shapes.
  if (status === 409) {
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
    // Remediation is keyed on the machine-readable CODE, not the HTTP status —
    // a 403 from the RLS firebreak is a DATABASE-config problem, not a key-scope
    // one, and printing "you need schema:push" for it sends the user down the
    // wrong path (the exact misdiagnosis reported from an integration). Always
    // lead with the server's real message + code, then remediate per code.
    const code = (body.code ?? body.reason) as string | undefined;
    const serverMsg = (body.message ?? body.reason) as string | undefined;
    console.error(pc.red(`  Forbidden${code ? ` [${code}]` : ''}: ${serverMsg ?? 'permission denied'}`));
    // Always name WHICH key push used and WHERE it came from — the reported
    // confusion was "push used my sandbox login key, not my prod key in .env.local".
    console.error(pc.dim(`  Push used ${pc.bold(maskKey(args.apiKey))} from ${describeKeySource(keySource)}.`));
    if (code === 'database_role_cannot_enforce_rls') {
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
    } else if (args.apiKey != null && classifyCredentialKind(args.apiKey) === 'restricted') {
      // The login-minted production key is a restricted (rk_) observe-only key
      // by design — name the door that works instead of leaving a dead end.
      console.error(
        pc.dim(
          `  Schema pushes need a SECRET key: ${pc.bold('sk_test_')} (sandbox dev loop) or a dashboard ` +
            `${pc.bold('sk_live_')} (production deploy: ${pc.bold('ABLO_API_KEY=sk_live_… npx ablo push')}).`,
        ),
      );
    } else {
      // Any other 403 on push = the key connected but isn't authorized to AUTHOR
      // schema (needs the schema:push capability). Most often this is the wrong
      // key being used — name the fix in terms of where keys are resolved from.
      console.error(
        pc.dim(
          `  This key isn't authorized to push schema (needs ${pc.bold('schema:push')}). ` +
            (keySource === 'login'
              ? `It's your stored ${pc.bold('ablo login')} sandbox key — a key in ${pc.bold('.env.local')} ` +
                `or ${pc.bold('ABLO_API_KEY')} takes precedence, so put a schema:push key there ` +
                `(sandbox ${pc.bold('sk_test_')} or production ${pc.bold('sk_live_')}) and re-push. `
              : `Use a schema:push key — a sandbox ${pc.bold('sk_test_')} or production ${pc.bold('sk_live_')}. `) +
            `Manage keys at https://abloatai.com`,
        ),
      );
    }
  } else {
    console.error(pc.red(`  Push failed (${status}): ${body.message ?? body.reason ?? bodyText}`));
  }
  process.exit(1);
}
