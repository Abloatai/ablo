/**
 * `ablo push` (sandbox flow) — push your schema to the hosted API.
 *
 * Named for what it DOES: nothing runs locally (no dev server) — your app
 * talks to Ablo's hosted API with a sandbox key. `push` checks your
 * DATABASE_URL role, pushes the schema definition, provisions your tables
 * server-side in YOUR registered database, and wires ABLO_API_KEY into
 * .env.local. `--watch` re-pushes on every schema save (the dev loop).
 *
 * The missing onboarding step between `ablo init` and a hosted account: it
 * takes a developer's `sk_test_` key, pushes their `ablo/schema.ts` to the
 * sandbox environment, writes `ABLO_API_KEY` into `.env.local` (so the SDK finds
 * the key with zero copy-paste), then watches the schema file and re-pushes
 * on every save.
 *
 * Why hosted (not a bundled local server): the sync-server is the proprietary
 * hosted backend. A `sk_test_` key hits the same hosted API as production, so the
 * SDK needs nothing changed but the key — the default `baseURL`
 * (`wss://api.abloatai.com`) already routes there. `ablo dev` is therefore a
 * thin client-side command, not a server.
 *
 * Safety: `ablo dev` refuses `sk_live_` keys. Re-pushing schema in a tight
 * save loop against production data is exactly the hazard the sandbox exists to
 * avoid, so the command hard-stops rather than warn.
 *
 * Usage:
 *   ablo dev
 *   ablo dev --schema ablo/schema.ts --export schema
 *   ablo dev --no-watch
 */

import { AbloValidationError } from '../errors.js';
import pc from 'picocolors';
import { spinner } from '@clack/prompts';
import { watch, existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { resolve } from 'path';
import { schemaHash, type Schema } from '@abloatai/ablo/schema';
import {
  loadSchema,
  pushSchema,
  fmtSignal,
  DEFAULT_SCHEMA_PATH,
  DEFAULT_EXPORT,
  DEFAULT_URL,
} from './push';
import { resolveApiKey, getMode, type Mode } from './config';
import { ensureScopedRoleInteractive, readProjectDatabaseUrl } from './dbRole';
import { brand } from './theme';

export interface DevArgs {
  schemaPath: string;
  exportName: string;
  url: string;
  apiKey: string | undefined;
  watch: boolean;
}

/** Parse `dev` flags. Pure — unit-testable without touching the network. */
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
      case '--no-watch': // historical alias; one-shot is the default now
        watchEnabled = false;
        break;
      default:
        throw new AbloValidationError(`unknown flag: ${arg}`, { code: 'cli_invalid_arguments' });
    }
  }

  url = url.replace(/\/+$/, '');
  return { schemaPath, exportName, url, apiKey: process.env.ABLO_API_KEY, watch: watchEnabled };
}

/**
 * Classify the configured key. The sandbox flow only accepts a secret SANDBOX
 * key (sk_test_):
 *  - `sk_test_` → ok
 *  - `sk_live_` → refused here, but the refusal NAMES the production path
 *  - `rk_*`     → wrong kind (restricted/agent key can't push schema)
 *  - anything else → not an Ablo key
 *
 * Message contract (suite-wide): error guidance must enumerate the DOORS, not
 * just the nearest one — every refusal here names both the sandbox path and
 * the production path, because "guidance by omission" is how a user with a
 * perfectly valid live key ends up believing only sk_test_ exists.
 */
export function classifyKey(
  apiKey: string | undefined,
  activeMode: Mode,
): { ok: true } | { ok: false; reason: string } {
  if (!apiKey) {
    return {
      ok: false,
      reason:
        `No API key. Run ${pc.bold('npx ablo login')} for the sandbox dev loop — or set ${pc.bold('ABLO_API_KEY')} ` +
        `(${pc.bold('sk_test_')} = sandbox; ${pc.bold('sk_live_')} = deliberate production deploy). ` +
        pc.dim(`Mode is currently '${activeMode}'.`),
    };
  }
  if (apiKey.startsWith('sk_test_')) return { ok: true };
  if (apiKey.startsWith('sk_live_')) {
    return {
      ok: false,
      reason:
        `Production schema deploys run one-shot: ${pc.bold('ABLO_API_KEY=sk_live_… npx ablo push')} ` +
        `(or ${pc.bold('ablo mode production')}). ${pc.bold('--watch')} is sandbox-only.`,
    };
  }
  if (apiKey.startsWith('rk_')) {
    return {
      ok: false,
      reason:
        `Restricted (${pc.bold('rk_')}) keys can't push schema. Use a secret key: ${pc.bold('sk_test_')} for the ` +
        `sandbox dev loop, or ${pc.bold('sk_live_')} with ${pc.bold('npx ablo push')} for a production deploy.`,
    };
  }
  return {
    ok: false,
    reason:
      `${pc.bold('ABLO_API_KEY')} is not an Ablo key — expected ${pc.bold('sk_test_…')} (sandbox) or ` +
      `${pc.bold('sk_live_…')} (production deploy via ${pc.bold('npx ablo push')}).`,
  };
}

/**
 * Wire the resolved sandbox key into `.env.local` so the SDK finds it without a
 * copy-paste step (frameworks load `.env.local`; vanilla Node uses
 * `node --env-file=.env.local`). Idempotent: creates the file, appends the
 * line, or updates a differing value — and says which it did. Never touches
 * anything when the key already came from the environment (CI / explicit).
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
    const match = content.match(/^ABLO_API_KEY=(.*)$/m);
    if (!match) {
      appendFileSync(envPath, `${content.endsWith('\n') || content.length === 0 ? '' : '\n'}${line}\n`);
      action = `Added ${pc.bold('ABLO_API_KEY')} to ${pc.bold('.env.local')}`;
    } else if (match[1] === apiKey) {
      action = `${pc.bold('.env.local')} already has this key`;
    } else {
      writeFileSync(envPath, content.replace(/^ABLO_API_KEY=.*$/m, line));
      action = `Updated ${pc.bold('ABLO_API_KEY')} in ${pc.bold('.env.local')} ${pc.dim(`(was ${match[1].slice(0, 12)}…)`)}`;
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
        : `schema pushed (sandbox) ${pc.dim(`(v${body.version}, hash ${body.hash})`)}`,
    };
  }

  if (status === 409) {
    const unexecutable = Array.isArray(body.unexecutable) ? body.unexecutable : [];
    const warnings = Array.isArray(body.warnings) ? body.warnings : [];
    const lines = [
      'Incompatible schema change — not safe to apply as-is.',
      ...unexecutable.map((u) => pc.red(fmtSignal(u))),
      ...warnings.map((w) => pc.yellow(fmtSignal(w))),
      pc.dim(`Run ${pc.bold('ablo push --force')} (or ${pc.bold('--rename old:new')}) to resolve.`),
    ];
    return { ok: false, message: lines.join('\n') };
  }
  if (status === 403) {
    // Stripe-shaped errors carry the actionable text in `message` (e.g.
    // `test_database_not_registered` tells you to register a dev database).
    // Guessing "missing scope" here MASKED that instruction — print the
    // server's words first, fall back to the scope hint only when absent.
    const serverSays = (body.message ?? body.reason) as string | undefined;
    // The RLS gate has a one-command fix — say so instead of leaving the
    // user to hand-write SQL (the gate is hit by every Neon/Supabase
    // dashboard connection string, whose default role is BYPASSRLS).
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
  return { ok: false, message: `Push failed (${status}): ${body.message ?? body.reason ?? bodyText}` };
}

export async function dev(argv: readonly string[]): Promise<void> {
  let args: DevArgs;
  try {
    args = parseDevArgs(argv);
  } catch (err) {
    console.error(pc.red(`  ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  // Fall back to the stored credential when no env var is set. `dev` is always
  // the SANDBOX loop, so it resolves the sandbox key regardless of the active mode.
  if (!args.apiKey) args.apiKey = resolveApiKey('sandbox');

  const key = classifyKey(args.apiKey, getMode());
  if (!key.ok) {
    console.error(pc.red(`  ${key.reason}`));
    process.exit(1);
  }

  console.log(`\n  ${brand('ablo')} ${pc.dim('push')} ${pc.dim('(sandbox)')}\n`);

  // Direct-databaseUrl projects: check the configured role BEFORE the push.
  // Neon/Supabase dashboard strings connect as the BYPASSRLS owner, which the
  // server's RLS gate refuses — `dev` offers to create the scoped role here
  // (from this machine; the owner credential never reaches Ablo), so the
  // quickstart needs no separate `ablo migrate` step: the push provisions the
  // tables server-side in the registered database.
  const projectDbUrl = readProjectDatabaseUrl();
  if (projectDbUrl) await ensureScopedRoleInteractive(projectDbUrl);

  const schema = await loadSchema(args.schemaPath, args.exportName);
  const modelCount = Object.keys(schema.models).length;
  console.log(
    `  ${pc.dim('schema')}  ${pc.bold(args.schemaPath)} ${pc.dim(`(${modelCount} models, hash ${schemaHash(schema)})`)}`,
  );
  console.log(`  ${pc.dim('key')}     ${args.apiKey!.slice(0, 12)}…`);
  console.log(`  ${pc.dim('api')}     ${args.url}\n`);

  const s = spinner();
  s.start('Pushing schema definition (sandbox)');
  const first = await runPush(schema, args);
  s.stop(first.message, first.ok ? 0 : 1);
  if (!first.ok) process.exit(1);

  // Hand the key to the SDK without a copy-paste step. When ABLO_API_KEY is
  // already in the environment (CI / explicit export) it's flowing — don't
  // touch the developer's files.
  if (process.env.ABLO_API_KEY) {
    console.log(`\n  ${pc.green('✓')} ${pc.bold('ABLO_API_KEY')} is set in this shell — the SDK reads it directly.`);
  } else {
    console.log(`\n  ${pc.green('✓')} ${wireEnvLocal(args.apiKey!)}`);
    console.log(`  ${pc.dim('Frameworks load it automatically; plain Node: node --env-file=.env.local app.ts')}`);
  }
  console.log(`  Your app is wired for the sandbox.`);

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
