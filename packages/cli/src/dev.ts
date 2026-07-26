/**
 * Implements the watch-loop schema push behind `ablo dev`: it uploads your
 * schema to the hosted Ablo API, and nothing runs locally. It checks the role in
 * your `DATABASE_URL`, uploads the schema definition, provisions your tables in
 * the database you registered, and writes `ABLO_API_KEY` into `.env.local` so
 * the SDK finds it without any copy-paste. With `--watch`, it re-pushes every
 * time you save the schema file, which is the inner-loop workflow.
 *
 * An `sk_test_` key reaches the same hosted API, the same engine, and the same
 * schema as a production key. Only the rows it acts on differ, and the default
 * endpoint (`wss://api.abloatai.com`) already routes there, so nothing in the
 * SDK changes but the key. {@link classifyKey} takes the `sk_test_` key here and
 * sends `sk_live_` to `ablo push`, because production schema changes land in one
 * reviewed step rather than on every keystroke.
 *
 * Usage:
 *   ablo dev
 *   ablo dev --schema ablo/schema.ts --export schema
 *   ablo dev --no-watch
 */

import { AbloValidationError } from '@abloatai/transaction/errors';
import { classifyCredentialKind } from '@abloatai/transaction/auth/credentialPolicy';
import pc from 'picocolors';
import { spinner } from '@clack/prompts';
import { watch, existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { resolve } from 'path';
import { schemaHash, type Schema } from '@abloatai/transaction/schema';
import {
  loadSchema,
  pushSchema,
  fmtSignal,
  apiBaseUrl,
  DEFAULT_SCHEMA_PATH,
  DEFAULT_EXPORT,
  DEFAULT_URL,
} from './push';
import { resolveEffectiveApiKey } from './config';
import { looksLikeCredentialRefusal, poolerExplanation } from './readiness';
import { brand } from './theme';

export interface DevArgs {
  schemaPath: string;
  exportName: string;
  url: string;
  apiKey: string | undefined;
  watch: boolean;
  planeLabel: string;
}

export interface DevRuntimeOptions {
  /** In-memory credential override supplied by branch orchestration. */
  apiKey?: string;
  branch?: {
    id: string;
    slug: string;
    expiresAt: string;
  };
}

/** Parses the `dev` command's flags into {@link DevArgs}. Does no I/O, so it can be unit-tested without a network. */
export function parseDevArgs(argv: readonly string[]): DevArgs {
  let schemaPath = DEFAULT_SCHEMA_PATH;
  let exportName = DEFAULT_EXPORT;
  let url = process.env.ABLO_API_URL ?? DEFAULT_URL;
  let watchEnabled = false;

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
      case '--watch':
        watchEnabled = true;
        break;
      case '--no-watch': // push once and exit; do not start the file watcher
        watchEnabled = false;
        break;
      default:
        throw new AbloValidationError(`unknown flag: ${arg}`, { code: 'cli_invalid_arguments' });
    }
  }

  url = url.replace(/\/+$/, '');
  return {
    schemaPath,
    exportName,
    url,
    apiKey: process.env.ABLO_API_KEY,
    watch: watchEnabled,
    planeLabel: 'sandbox',
  };
}

/**
 * Decides which command the configured key belongs to. The watch loop runs on a
 * secret `sk_test_` key:
 *  - `sk_test_` is taken here.
 *  - `sk_live_` is sent to `ablo push`, the reviewed one-shot production deploy.
 *  - `rk_...` is a restricted key, which carries only its minted scopes.
 *  - anything else is not an Ablo key.
 *
 * Every message names both doors, the watch loop and the production deploy, so a
 * developer holding either key learns where it goes rather than only that this
 * command declined it. Returns `{ ok: true }` when the key is accepted, or
 * `{ ok: false, reason }` with text ready to print.
 */
export function classifyKey(
  apiKey: string | undefined,
): { ok: true } | { ok: false; reason: string } {
  if (!apiKey) {
    return {
      ok: false,
      reason:
        `No API key. Run ${pc.bold('npx ablo login')}, or set ${pc.bold('ABLO_API_KEY')}: ` +
        `${pc.bold('sk_test_')} runs the ${pc.bold('npx ablo dev')} watch loop, ` +
        `${pc.bold('sk_live_')} deploys production with ${pc.bold('npx ablo push')}.`,
    };
  }
  if (apiKey.startsWith('sk_test_')) return { ok: true };
  if (apiKey.startsWith('sk_live_')) {
    return {
      ok: false,
      reason:
        `A ${pc.bold('sk_live_')} key deploys production schema in one reviewed step: ` +
        `${pc.bold('npx ablo push')}. The ${pc.bold('--watch')} loop runs on a ${pc.bold('sk_test_')} ` +
        `key, which reaches the same API and the same schema over its own rows.`,
    };
  }
  if (classifyCredentialKind(apiKey) === 'restricted') {
    return {
      ok: false,
      reason:
        `Authoring schema needs a secret key. ${pc.bold('sk_test_')} runs the ${pc.bold('npx ablo dev')} ` +
        `watch loop, ${pc.bold('sk_live_')} deploys production with ${pc.bold('npx ablo push')}. ` +
        `A restricted ${pc.bold('rk_')} key carries only the scopes it was minted with.`,
    };
  }
  return {
    ok: false,
    reason:
      `${pc.bold('ABLO_API_KEY')} is not an Ablo key. Expected ${pc.bold('sk_test_…')} for the ` +
      `${pc.bold('npx ablo dev')} watch loop, or ${pc.bold('sk_live_…')} for a production deploy ` +
      `with ${pc.bold('npx ablo push')}.`,
  };
}

/**
 * Writes the resolved sandbox key into `.env.local` so the SDK finds it without
 * a copy-paste step (frameworks load `.env.local` automatically; with plain
 * Node, use `node --env-file=.env.local`). Safe to run repeatedly: it creates
 * the file, appends the key line, or updates a differing value, and returns a
 * short description of which it did. It also adds `.env.local` to `.gitignore`
 * when nothing already covers it, so the secret can't be committed.
 */
export function wireEnvLocal(apiKey: string, cwd: string = process.cwd()): string {
  const envPath = resolve(cwd, '.env.local');
  const line = `ABLO_API_KEY=${apiKey}`;

  let action: string;
  if (!existsSync(envPath)) {
    writeFileSync(envPath, `${line}\n`, { mode: 0o600 });
    action = `Created ${pc.bold('.env.local')} with ${pc.bold('ABLO_API_KEY')}`;
  } else {
    const content = readFileSync(envPath, 'utf8');
    const match = /^ABLO_API_KEY=(.*)$/m.exec(content);
    // `(.*)` always captures on a match — `?? ''` only satisfies the checker.
    const existing = match?.[1] ?? '';
    if (!match) {
      appendFileSync(envPath, `${content.endsWith('\n') || content.length === 0 ? '' : '\n'}${line}\n`);
      action = `Added ${pc.bold('ABLO_API_KEY')} to ${pc.bold('.env.local')}`;
    } else if (existing === apiKey) {
      action = `${pc.bold('.env.local')} already has this key`;
    } else {
      writeFileSync(envPath, content.replace(/^ABLO_API_KEY=.*$/m, line));
      action = `Updated ${pc.bold('ABLO_API_KEY')} in ${pc.bold('.env.local')} ${pc.dim(`(was ${existing.slice(0, 12)}…)`)}`;
    }
  }

  // `.env.local` carries a secret — make sure it can never be committed.
  // Most people forget, and a key in git history is a leak forever, so the
  // CLI adds the ignore entry itself rather than printing a warning nobody
  // reads. Idempotent: skipped when an existing pattern already covers it.
  const gitignorePath = resolve(cwd, '.gitignore');
  const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const ignored = /^(\.env\.local|\.env\*|\.env\.\*|\.env.*)$/m.test(gitignore);
  let gitignoreNote = '';
  if (!ignored) {
    writeFileSync(
      gitignorePath,
      `${gitignore.endsWith('\n') || gitignore.length === 0 ? gitignore : `${gitignore}\n`}.env.local\n`,
    );
    gitignoreNote = ` Added ${pc.bold('.env.local')} to ${pc.bold('.gitignore')} so the key can't be committed.`;
  }

  return `${action}.${gitignoreNote}`;
}

/** Push once and return a rendered result for a spinner to display. */
async function runPush(schema: Schema, args: DevArgs): Promise<{ ok: boolean; message: string }> {
  const { ok, status, body, bodyText } = await pushSchema(schema, {
    url: args.url,
    apiKey: args.apiKey,
    force: false,
    renames: [],
    backfills: [],
  });

  if (ok) {
    return {
      ok: true,
      message: body.unchanged
        ? `schema unchanged ${pc.dim(`(v${body.version})`)}`
        : `schema pushed (${args.planeLabel}) ${pc.dim(`(v${body.version}, hash ${body.hash})`)}`,
    };
  }

  if (status === 409) {
    if (body.code === 'replication_reset_required') {
      const models = Array.isArray(body.models) ? body.models : [];
      return {
        ok: false,
        message: [
          pc.bold('Replication reset required — a removed model still has live rows in this log plane.'),
          ...models.map((model) => pc.yellow(`  Live vanished model: ${String(model)}`)),
          pc.dim(`  Use ${pc.bold('--rename old:new')} to carry it forward, or ${pc.bold('--force')} to accept the drop/reset.`),
        ].join('\n'),
      };
    }
    const unexecutable = Array.isArray(body.unexecutable) ? body.unexecutable : [];
    const warnings = Array.isArray(body.warnings) ? body.warnings : [];
    // Whether any signal is a reader-visibility removal (carries `shadowed`):
    // those need the "why" context line below; a pure unexecutable (e.g. a
    // required column on a non-empty table) does not.
    const hasShadowed = [...unexecutable, ...warnings].some(
      (s) => (s as { shadowed?: unknown }).shadowed != null,
    );
    const lines = [
      pc.bold('Incompatible schema change — not safe to apply as-is.'),
      '',
      ...unexecutable.map((u) => pc.red(fmtSignal(u))),
      ...warnings.map((w) => pc.yellow(fmtSignal(w))),
      '',
      ...(hasShadowed
        ? [
            pc.dim(
              '  These models exist in the baseline above but not in your push. Sandbox readers',
            ),
            pc.dim(
              '  fall back to the production schema until you push your own, so applying this drops them.',
            ),
            '',
          ]
        : []),
      pc.dim(
        `  Fix: ${pc.bold('ablo push --force')} to apply anyway, or ${pc.bold('--rename old:new')} if you renamed a model.`,
      ),
    ];
    return { ok: false, message: lines.join('\n') };
  }
  if (status === 403) {
    // The server's error carries the actionable text in `message` (for example,
    // `test_database_not_registered` tells you to register a development
    // database). Print the server's words first and fall back to the scope hint
    // only when they're absent, so a specific instruction isn't hidden behind a
    // guessed "missing scope".
    const serverSays = (body.message ?? body.reason) as string | undefined;
    // The row-level-security rejection has a one-command fix, so point to it
    // rather than leaving the developer to hand-write SQL. It is triggered by any
    // connection string whose default role can bypass row-level security.
    const hint =
      body.code === 'database_role_cannot_enforce_rls'
        ? `Run ${pc.bold('npx ablo migrate')} — it creates the scoped role for you (your DB credential never leaves this machine).`
        : `Schema authoring needs a ${pc.bold('sandbox')} key with ${pc.bold('schema:push')} — manage keys at ${pc.cyan('https://abloatai.com')}.`;
    return {
      ok: false,
      message:
        `${serverSays ?? "This key can't author schema (missing schema:push scope)."}\n` + pc.dim(hint),
    };
  }
  const serverMessage = String(body.message ?? body.reason ?? bodyText);
  // A credential refusal from the database is the one failure here whose words
  // point away from its cause: the pooled host says "password authentication
  // failed" about a password that is correct and working elsewhere in the same
  // session. Ask the plane what host it holds before repeating that.
  if (looksLikeCredentialRefusal(serverMessage)) {
    const pooled = await poolerExplanation(apiBaseUrl(), args.apiKey);
    if (pooled) {
      return { ok: false, message: `${serverMessage}\n${pc.dim(pooled)}` };
    }
  }
  return { ok: false, message: `Push failed (${status}): ${serverMessage}` };
}

export async function dev(
  argv: readonly string[],
  runtime: DevRuntimeOptions = {},
): Promise<void> {
  let args: DevArgs;
  try {
    args = parseDevArgs(argv);
  } catch (err) {
    console.error(pc.red(`  ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  // Resolve through the shared chain (environment variable, then `.env.local`,
  // then `.env`, then the stored login credential) so `dev` sees the same key
  // that `push` and `status` report. `dev` is always the sandbox loop, so the
  // stored fallback resolves the sandbox key regardless of the active mode; a
  // production key found in a project env file is refused just below by
  // `classifyKey`, which names the production path.
  if (runtime.apiKey) args.apiKey = runtime.apiKey;
  else if (!args.apiKey) args.apiKey = resolveEffectiveApiKey('sandbox').key;
  if (runtime.branch) args.planeLabel = runtime.branch.slug;

  const key = classifyKey(args.apiKey);
  if (!key.ok) {
    console.error(pc.red(`  ${key.reason}`));
    process.exit(1);
  }

  console.log(`\n  ${brand('ablo')} ${pc.dim('push')} ${pc.dim(`(${args.planeLabel})`)}\n`);
  if (runtime.branch) {
    console.log(
      `  ${pc.dim('branch')}  ${pc.bold(runtime.branch.slug)} ${pc.dim(runtime.branch.id)}`,
    );
    console.log(
      `  ${pc.dim('key')}     temporary · expires ${runtime.branch.expiresAt}`,
    );
  }

  // `ablo dev` does not touch your database — no role creation, no
  // row-level-security changes, no migrations. Ablo connects as-is; if the role
  // can't enforce row-level security the server warns but still serves, leaving
  // tenant isolation on your own database to you. Securing the connection is
  // opt-in; see the docs.
  const schema = await loadSchema(args.schemaPath, args.exportName);
  const modelCount = Object.keys(schema.models).length;
  console.log(
    `  ${pc.dim('schema')}  ${pc.bold(args.schemaPath)} ${pc.dim(`(${modelCount} models, hash ${schemaHash(schema)})`)}`,
  );
  if (!runtime.branch) {
    console.log(`  ${pc.dim('key')}     ${args.apiKey!.slice(0, 12)}…`);
  }
  console.log(`  ${pc.dim('api')}     ${args.url}\n`);

  const s = spinner();
  s.start('Pushing schema definition (sandbox)');
  const first = await runPush(schema, args);
  s.stop(first.message, first.ok ? 0 : 1);
  if (!first.ok) process.exit(1);

  // Hand the key to the SDK without a copy-paste step. When ABLO_API_KEY is
  // already in the environment (CI / explicit export) it's flowing — don't
  // touch the developer's files.
  if (runtime.branch) {
    console.log(`\n  ${pc.green('✓')} ${wireEnvLocal(args.apiKey!)}`);
    console.log(
      `  ${pc.dim(`Temporary branch credential expires ${runtime.branch.expiresAt}; rerun ablo dev to rotate it.`)}`,
    );
    if (process.env.ABLO_API_KEY && process.env.ABLO_API_KEY !== args.apiKey) {
      console.log(
        pc.yellow(
          `  An exported ABLO_API_KEY overrides .env.local for child processes; unset it before starting your app.`,
        ),
      );
    }
  } else if (process.env.ABLO_API_KEY) {
    console.log(`\n  ${pc.green('✓')} ${pc.bold('ABLO_API_KEY')} is set in this shell — the SDK reads it directly.`);
  } else {
    console.log(`\n  ${pc.green('✓')} ${wireEnvLocal(args.apiKey!)}`);
    console.log(`  ${pc.dim('Frameworks load it automatically; plain Node: node --env-file=.env.local app.ts')}`);
  }
  console.log(`  Your app is wired for ${runtime.branch ? `branch ${runtime.branch.slug}` : 'the sandbox'}.`);

  if (!args.watch) return;

  const abs = resolve(process.cwd(), args.schemaPath);
  console.log(`  ${pc.dim(`watching ${args.schemaPath} … (Ctrl-C to stop)`)}\n`);

  // Debounce: editors fire multiple change events per save (write + rename).
  // Collapse a burst into a single re-push.
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pushing = false;
  const watcher = watch(abs, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void rePush();
    }, 300);
  });

  async function rePush(): Promise<void> {
    if (pushing) return; // a push is in flight; the file watcher will fire again if needed
    pushing = true;
    const s = spinner();
    s.start(`${new Date().toLocaleTimeString()} change detected — re-pushing`);
    try {
      // Re-import the schema fresh each time so edits are picked up. loadSchema
      // goes through tsx's importer, which re-transpiles on each call.
      const next = await loadSchema(args.schemaPath, args.exportName);
      const r = await runPush(next, args);
      s.stop(r.message, r.ok ? 0 : 1);
    } catch (err) {
      s.stop(pc.red(`schema reload failed: ${err instanceof Error ? err.message : String(err)}`), 1);
    } finally {
      pushing = false;
    }
  }

  const stop = (): void => {
    watcher.close();
    console.log(`\n  ${pc.dim('stopped.')}`);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // Hold the process open for the watcher.
  await new Promise<never>(() => {});
}
