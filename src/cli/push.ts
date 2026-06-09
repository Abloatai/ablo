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
import { existsSync } from 'fs';
import { resolve } from 'path';
import { serializeSchema, schemaHash, type Schema } from '@abloatai/ablo/schema';
import { resolveApiKey } from './config';

export interface PushArgs {
  schemaPath: string;
  exportName: string;
  url: string;
  apiKey: string | undefined;
  force: boolean;
  renames: { from: string; to: string }[];
  backfills: { model: string; field: string; value: string | number | boolean }[];
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

/** Format a single migration signal `{ model, field?, detail }` for the CLI. */
export function fmtSignal(s: unknown): string {
  const sig = s as { model?: string; field?: string; detail?: string };
  const where = sig.field ? `${sig.model}.${sig.field}` : sig.model;
  return `    • ${pc.bold(where ?? '?')} — ${sig.detail ?? ''}`;
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
  return { schemaPath, exportName, url, apiKey: process.env.ABLO_API_KEY, force, renames, backfills };
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

export async function push(argv: readonly string[]): Promise<void> {
  let args: PushArgs;
  try {
    args = parsePushArgs(argv);
  } catch (err) {
    console.error(pc.red(`  ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  // Fall back to the stored credential (`ablo login`) when no env var is set.
  if (!args.apiKey) args.apiKey = resolveApiKey();

  if (!args.apiKey) {
    console.error(
      pc.red(`  No API key.`) +
        pc.dim(` Run ${pc.bold('ablo login')} or set ${pc.bold('ABLO_API_KEY')} (a secret sk_ key with schema:push).`),
    );
    process.exit(1);
  }

  const schema = await loadSchema(args.schemaPath, args.exportName);
  const hash = schemaHash(schema);

  console.log(
    `  Pushing ${pc.bold(args.schemaPath)} ${pc.dim(`(${Object.keys((schema as Schema).models).length} models, hash ${hash})`)} → ${pc.dim(args.url)}`,
  );

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
    console.error(pc.dim(`  Re-push with ${pc.bold('--force')} to override, or use ${pc.bold('--rename old:new')} if you renamed a model.`));
  } else if (status === 403) {
    console.error(pc.red(`  Forbidden: ${body.reason ?? 'key lacks schema:push scope'}.`));
  } else {
    console.error(pc.red(`  Push failed (${status}): ${body.reason ?? bodyText}`));
  }
  process.exit(1);
}
