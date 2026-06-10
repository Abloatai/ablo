/**
 * `ablo pull drizzle` — generate `defineSchema(...)` from a Drizzle schema MODULE.
 *
 * The Drizzle sibling of `ablo pull prisma`, and a direct analogue of what
 * `drizzle-zero` does: it imports the customer's Drizzle schema and *reflects*
 * it at runtime (`getTableColumns`, `getTableConfig`) rather than reading the
 * lossy database. That keeps the two things DB-introspection throws away:
 *
 *   - `pgEnum(...)` members            → `field.enum([...])`
 *   - `.references(() => other.id)`    → `relation.belongsTo(target, fk)`
 *
 * The reflection core ({@link lowerDrizzleModule}) is pure — it takes an already
 * imported module object — so it's unit-testable against real Drizzle tables.
 * The CLI wrapper loads the customer's (TypeScript) module via jiti, then calls
 * it. Reflection uses the *customer's* `drizzle-orm` (resolved from their
 * project), so the column metadata always matches their version.
 */

import pc from 'picocolors';
import { AbloValidationError } from '../errors.js';
import { existsSync, writeFileSync } from 'fs';
import { resolve } from 'path';
// TYPE-ONLY at module scope — erased at compile time. The VALUE imports load
// lazily inside `loadDrizzle()`: drizzle-orm is the CUSTOMER's dependency
// (resolved from their project), and a top-level import becomes a startup
// `require("drizzle-orm")` in the CJS bundle that crashes EVERY `ablo`
// command in projects that don't use Drizzle.
import type { Column } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { brand } from './theme';
import { camelToSnake, emitSchemaSource, type IRField, type IRModel, type IRRelation, type IRSchema } from './schema-ir';

const DEFAULT_OUT = 'ablo/schema.ts';
const DEFAULT_IMPORT = '@abloatai/ablo/schema';

/** Engine-owned, never emitted (by Ablo field name)… */
const BASE_FIELD_NAMES = new Set(['id', 'organizationId', 'createdBy', 'createdAt', 'updatedAt']);
/** …or by physical column. */
const BASE_COLUMNS = new Set(['id', 'organization_id', 'created_by', 'created_at', 'updated_at']);

/** Map a Drizzle column to an IR field kind. Enum is detected first. */
function mapColumn(col: Column): { kind: IRField['kind']; enumValues?: readonly string[]; note?: string } {
  const enumValues = col.enumValues;
  if (col.columnType === 'PgEnumColumn' && Array.isArray(enumValues) && enumValues.length > 0) {
    return { kind: 'enum', enumValues };
  }
  switch (col.dataType) {
    case 'string':
      return { kind: 'string' };
    case 'number':
    case 'bigint':
      return { kind: 'number' };
    case 'boolean':
      return { kind: 'boolean' };
    case 'date':
      return { kind: 'date' };
    case 'json':
      return { kind: 'json' };
    case 'array':
      return { kind: 'json', note: `array (${col.columnType}) — stored as JSON` };
    case 'buffer':
      return { kind: 'json', note: `bytes (${col.columnType}) — stored as JSON` };
    default:
      return { kind: 'json', note: `unrecognized type (${col.columnType}) — stored as JSON` };
  }
}

function stripIdSuffix(field: string): string {
  if (field.endsWith('Id') && field.length > 2) return field.slice(0, -2);
  if (field.endsWith('_id') && field.length > 3) return field.slice(0, -3);
  return field;
}

/** Lazy-load the customer's drizzle-orm. See the type-only import note above. */
async function loadDrizzle() {
  const [orm, pgCore] = await Promise.all([import('drizzle-orm'), import('drizzle-orm/pg-core')]);
  return {
    is: orm.is,
    getTableName: orm.getTableName,
    getTableColumns: orm.getTableColumns,
    PgTable: pgCore.PgTable,
    getTableConfig: pgCore.getTableConfig,
  };
}

/**
 * Reflect an imported Drizzle schema module into the shared IR. No I/O, no
 * DB; async only because drizzle-orm itself loads lazily. `mod` is the module
 * namespace object (its exported tables).
 */
export async function lowerDrizzleModule(mod: Record<string, unknown>): Promise<IRSchema> {
  const { is, getTableName, getTableColumns, PgTable, getTableConfig } = await loadDrizzle();
  const tables = Object.values(mod).filter((v): v is PgTable => is(v, PgTable));

  const models: IRModel[] = [];
  const skipped: IRSchema['skipped'] = [];

  for (const table of tables) {
    const tableName = getTableName(table);
    const columns = getTableColumns(table);

    // Reverse map (Column instance → declared field key) so foreign keys, which
    // reference Column objects, can resolve back to the IR field name.
    const fieldKeyByColumn = new Map<Column, string>();
    const fieldKeyByColName = new Map<string, string>();
    for (const [key, col] of Object.entries(columns)) {
      fieldKeyByColumn.set(col, key);
      fieldKeyByColName.set(col.name, key);
    }

    const fields: IRField[] = [];
    let hasId = false;
    let hasTenancy = false;

    for (const [key, col] of Object.entries(columns)) {
      const column = col.name;
      if (key === 'id' || column === 'id' || col.primary) hasId = true;
      if (key === 'organizationId' || column === 'organization_id') hasTenancy = true;
      if (BASE_FIELD_NAMES.has(key) || BASE_COLUMNS.has(column)) continue;

      const { kind, enumValues, note } = mapColumn(col);
      fields.push({ name: key, kind, enumValues, optional: !col.notNull, column, note });
    }

    const relations: IRRelation[] = [];
    const { foreignKeys } = getTableConfig(table);
    for (const fk of foreignKeys) {
      const ref = fk.reference();
      if (ref.columns.length !== 1) continue; // composite FK → not a single belongsTo
      const localCol = ref.columns[0];
      const fkField = fieldKeyByColumn.get(localCol) ?? fieldKeyByColName.get(localCol.name) ?? localCol.name;
      const target = getTableName(ref.foreignTable);
      relations.push({ name: stripIdSuffix(fkField), target, fkField });
    }

    if (!hasId || !hasTenancy) {
      skipped.push({ name: tableName, reason: !hasId ? 'no id column' : 'no organization_id (not tenant-scoped)' });
      continue;
    }
    models.push({ key: tableName, fields, relations });
  }

  return { models, skipped };
}

export interface PulledDrizzleSchema {
  source: string;
  models: string[];
  skipped: IRSchema['skipped'];
}

export async function buildSchemaSourceFromDrizzle(opts: {
  mod: Record<string, unknown>;
  importPath: string;
}): Promise<PulledDrizzleSchema> {
  const ir = await lowerDrizzleModule(opts.mod);
  return {
    source: emitSchemaSource(ir, opts.importPath),
    models: ir.models.map((m) => m.key),
    skipped: ir.skipped,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

interface DrizzlePullArgs {
  schema: string | null;
  out: string;
  importPath: string;
  force: boolean;
}

export function parseDrizzlePullArgs(argv: readonly string[]): DrizzlePullArgs {
  let schema: string | null = null;
  let out = DEFAULT_OUT;
  let importPath = DEFAULT_IMPORT;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--schema':
        schema = argv[++i] ?? schema;
        break;
      case '--out':
        out = argv[++i] ?? out;
        break;
      case '--import':
        importPath = argv[++i] ?? importPath;
        break;
      case '--force':
        force = true;
        break;
      default:
        if (arg.startsWith('--')) throw new AbloValidationError(`unknown flag: ${arg}`, { code: 'cli_invalid_arguments' });
        schema = arg;
    }
  }
  return { schema, out, importPath, force };
}

/** Load a (possibly TypeScript) Drizzle module from disk via jiti. */
async function loadModule(path: string): Promise<Record<string, unknown>> {
  // jiti transpiles TS on the fly, so we can import the customer's schema.ts
  // directly. Imported lazily so the rest of the CLI doesn't pay for it.
  const { createJiti } = await import('jiti');
  const jiti = createJiti(process.cwd());
  const mod = await jiti.import<Record<string, unknown>>(resolve(path));
  return mod;
}

export async function drizzlePull(argv: readonly string[]): Promise<void> {
  let args: DrizzlePullArgs;
  try {
    args = parseDrizzlePullArgs(argv);
  } catch (err) {
    console.error(pc.red(`  ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  if (!args.schema) {
    console.error(
      pc.red(`  No Drizzle schema given.`) + pc.dim(` Pass the module: ${pc.bold('ablo pull drizzle src/db/schema.ts')}.`),
    );
    process.exit(1);
  }
  if (!existsSync(args.schema)) {
    console.error(pc.red(`  No file at ${pc.bold(args.schema)}.`));
    process.exit(1);
  }
  if (existsSync(args.out) && !args.force) {
    console.error(
      pc.red(`  ${args.out} already exists.`) + pc.dim(` Re-run with ${pc.bold('--force')} to overwrite.`),
    );
    process.exit(1);
  }

  console.log(`\n  ${brand('ablo')} ${pc.dim('pull drizzle')}  ${pc.dim(args.schema)}\n`);

  let result: PulledDrizzleSchema;
  try {
    const mod = await loadModule(args.schema);
    result = await buildSchemaSourceFromDrizzle({ mod, importPath: args.importPath });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint = /Cannot find package 'drizzle-orm'/.test(msg)
      ? pc.dim(` (install ${pc.bold('drizzle-orm')} in this project)`)
      : '';
    console.error(pc.red(`  Couldn't load the schema: ${msg}`) + hint);
    process.exit(1);
  }

  if (result.models.length === 0) {
    console.error(
      pc.yellow(`  No adoptable tables found`) +
        pc.dim(` (a table needs an ${pc.bold('id')} + ${pc.bold('organization_id')} column).`),
    );
    process.exit(1);
  }

  writeFileSync(args.out, result.source);
  console.log(`  ${pc.green('✓')} wrote ${pc.bold(args.out)} ${pc.dim(`(${result.models.length} models)`)}`);
  console.log(`  ${pc.dim(`models: ${result.models.join(', ')}`)}`);
  if (result.skipped.length > 0) {
    console.log(`  ${pc.dim(`${result.skipped.length} table(s) skipped:`)}`);
    for (const s of result.skipped) console.log(`    ${pc.dim(`- ${s.name}: ${s.reason}`)}`);
  }
  console.log(
    `\n  ${pc.dim('Enums and relations were preserved. Review the file, then')} ${pc.bold('ablo check')}.\n`,
  );
}
