/**
 * `ablo pull prisma` — generate `defineSchema(...)` from a Prisma schema FILE.
 *
 * The lossless counterpart to `ablo pull` (which reads the live database and so
 * can't recover enums or relations). This reads `schema.prisma` directly, where
 * the ORM's intent is still declared:
 *
 *   - `enum Status { … }`              → `field.enum([...])`  (members preserved)
 *   - `@relation(fields:[x], references:[y])` → `relation.belongsTo(target, x)`
 *   - `@map("col")`                    → `field.from('col')`  (column preserved)
 *
 * It is the Prisma analogue of what `drizzle-zero` does by reflecting a Drizzle
 * module. Non-infringing: it only READS a local file and writes another local
 * file; it never touches a database.
 *
 * Adoption contract (same as `ablo pull`): a Prisma model becomes an Ablo model
 * only if it is tenant-scoped — it must have an `id` field and an
 * `organizationId` field (or a field mapped to the `organization_id` column).
 * Models that don't clear the contract are reported as skipped.
 */

import { AbloValidationError } from '../errors.js';
import pc from 'picocolors';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { brand } from './theme';
import { camelToSnake, emitSchemaSource, type IRField, type IRModel, type IRRelation, type IRSchema } from './schema-ir';

const DEFAULT_SCHEMA = 'prisma/schema.prisma';
const DEFAULT_OUT = 'ablo/schema.ts';
const DEFAULT_IMPORT = '@abloatai/ablo/schema';

/** Engine-owned, never emitted as declared fields (by Ablo field name). */
const BASE_FIELD_NAMES = new Set(['id', 'organizationId', 'createdBy', 'createdAt', 'updatedAt']);
/** …or by their physical column (when a field carries `@map`). */
const BASE_COLUMNS = new Set(['id', 'organization_id', 'created_by', 'created_at', 'updated_at']);

/** Prisma scalar → IR field kind. JSON-ish and unsupported scalars get a note. */
const SCALAR_MAP: Record<string, { kind: IRField['kind']; note?: string }> = {
  String: { kind: 'string' },
  Boolean: { kind: 'boolean' },
  Int: { kind: 'number' },
  BigInt: { kind: 'number' },
  Float: { kind: 'number' },
  Decimal: { kind: 'number', note: 'Decimal → number (precision not preserved)' },
  DateTime: { kind: 'date' },
  Json: { kind: 'json' },
  Bytes: { kind: 'json', note: 'Bytes has no engine type — review' },
};

// ── Block scanning ──────────────────────────────────────────────────────────

interface PrismaBlock {
  type: 'model' | 'enum' | 'other';
  name: string;
  body: string;
}

/** Remove `// …` line comments, respecting double-quoted strings. */
function stripComments(src: string): string {
  const out: string[] = [];
  for (const line of src.split('\n')) {
    let inStr = false;
    let res = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        inStr = !inStr;
        res += c;
        continue;
      }
      if (!inStr && c === '/' && line[i + 1] === '/') break;
      res += c;
    }
    out.push(res);
  }
  return out.join('\n');
}

/** Split a schema into its top-level `model` / `enum` / other blocks. */
export function parseBlocks(srcRaw: string): PrismaBlock[] {
  const src = stripComments(srcRaw);
  const blocks: PrismaBlock[] = [];
  const headerRe = /(model|enum|datasource|generator|type)\s+(\w+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(src))) {
    const openIdx = headerRe.lastIndex - 1; // index of the matched `{`
    let depth = 1;
    let j = openIdx + 1;
    for (; j < src.length && depth > 0; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') depth--;
    }
    const body = src.slice(openIdx + 1, j - 1);
    const kw = m[1];
    const type: PrismaBlock['type'] = kw === 'model' ? 'model' : kw === 'enum' ? 'enum' : 'other';
    blocks.push({ type, name: m[2], body });
    headerRe.lastIndex = j; // resume after this block
  }
  return blocks;
}

function parseEnumMembers(body: string): string[] {
  const members: string[] = [];
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('@') || t.startsWith('@@')) continue;
    const first = t.split(/\s+/)[0];
    if (/^\w+$/.test(first)) members.push(first);
  }
  return members;
}

// ── Field parsing ───────────────────────────────────────────────────────────

interface RawField {
  name: string;
  type: string;
  optional: boolean;
  list: boolean;
  attrs: string;
}

/** Parse one field line: `name Type[]? @attrs…`. Returns null for non-fields. */
export function parseFieldLine(line: string): RawField | null {
  const t = line.trim();
  if (!t || t.startsWith('@@') || t.startsWith('//')) return null;
  const m = /^(\w+)\s+([A-Za-z_]\w*)(\[\])?(\?)?\s*(.*)$/.exec(t);
  if (!m) return null;
  return {
    name: m[1],
    type: m[2],
    list: Boolean(m[3]),
    optional: Boolean(m[4]),
    attrs: m[5] ?? '',
  };
}

function mapAttr(attrs: string): string | undefined {
  return /@map\("([^"]+)"\)/.exec(attrs)?.[1];
}

function blockMap(body: string): string | undefined {
  return /@@map\("([^"]+)"\)/.exec(body)?.[1];
}

/** Single foreign-key field from `@relation(fields:[x], references:[…])`, if 1:1. */
function relationFkFields(attrs: string): string[] | null {
  const rel = /@relation\(([^)]*)\)/.exec(attrs);
  if (!rel) return null;
  const fields = /fields:\s*\[([^\]]*)\]/.exec(rel[1]);
  if (!fields) return null; // the back-reference side carries no local FK
  return fields[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── Lowering ────────────────────────────────────────────────────────────────

/** Parse a Prisma schema source into the shared IR. Pure; no I/O. */
export function parsePrismaSchema(src: string): IRSchema {
  const blocks = parseBlocks(src);

  const enums = new Map<string, string[]>();
  for (const b of blocks) {
    if (b.type === 'enum') enums.set(b.name, parseEnumMembers(b.body));
  }

  const modelBlocks = blocks.filter((b) => b.type === 'model');
  const modelNames = new Set(modelBlocks.map((b) => b.name));
  // Prisma model → physical table name (== `@@map` value, else the model name).
  const tableOf = new Map<string, string>();
  for (const b of modelBlocks) tableOf.set(b.name, blockMap(b.body) ?? b.name);

  const models: IRModel[] = [];
  const skipped: IRSchema['skipped'] = [];

  for (const b of modelBlocks) {
    const fields: IRField[] = [];
    const relations: IRRelation[] = [];
    let hasId = false;
    let hasTenancy = false;

    for (const line of b.body.split('\n')) {
      const raw = parseFieldLine(line);
      if (!raw) continue;
      const column = mapAttr(raw.attrs);

      // Relation field (its type is another model): emit a belongsTo edge from
      // the local FK; the field itself has no column of its own.
      if (modelNames.has(raw.type)) {
        const fks = relationFkFields(raw.attrs);
        if (fks && fks.length === 1) {
          relations.push({ name: raw.name, target: tableOf.get(raw.type) ?? raw.type, fkField: fks[0] });
        }
        // No `fields:[…]` → back-reference side; nothing to emit. Composite
        // (multi-column) FKs aren't expressible as a single belongsTo → skip.
        continue;
      }

      // Engine-owned base columns are implicit — detect (to satisfy the adopt
      // contract) but never emit.
      if (raw.name === 'id' || /@id\b/.test(raw.attrs)) hasId = true;
      if (raw.name === 'organizationId' || column === 'organization_id') hasTenancy = true;
      if (BASE_FIELD_NAMES.has(raw.name) || (column && BASE_COLUMNS.has(column))) continue;

      // Scalar / enum / unknown.
      let kind: IRField['kind'];
      let enumValues: readonly string[] | undefined;
      let note: string | undefined;
      const scalar = SCALAR_MAP[raw.type];
      if (scalar) {
        kind = scalar.kind;
        note = scalar.note;
      } else if (enums.has(raw.type)) {
        const members = enums.get(raw.type) ?? [];
        if (members.length > 0) {
          kind = 'enum';
          enumValues = members;
        } else {
          kind = 'string';
          note = `enum ${raw.type} had no members`;
        }
      } else {
        // A composite `type` block or otherwise unsupported — store as JSON.
        kind = 'json';
        note = `unrecognized type "${raw.type}" — stored as JSON`;
      }

      // A scalar list (`String[]`) has no first-class engine type → JSON.
      if (raw.list && kind !== 'enum') {
        note = note ?? `list (${raw.type}[]) — stored as JSON`;
        kind = 'json';
      } else if (raw.list && kind === 'enum') {
        note = `enum list (${raw.type}[]) — stored as JSON`;
        kind = 'json';
        enumValues = undefined;
      }

      fields.push({ name: raw.name, kind, enumValues, optional: raw.optional, column, note });
    }

    if (!hasId || !hasTenancy) {
      skipped.push({
        name: b.name,
        reason: !hasId ? 'no id field' : 'no organization_id (not tenant-scoped)',
      });
      continue;
    }

    models.push({ key: tableOf.get(b.name) ?? b.name, fields, relations });
  }

  return { models, skipped };
}

export interface PulledPrismaSchema {
  source: string;
  models: string[];
  skipped: IRSchema['skipped'];
}

/** Parse + emit in one step. Pure; no I/O. */
export function buildSchemaSourceFromPrisma(opts: { src: string; importPath: string }): PulledPrismaSchema {
  const ir = parsePrismaSchema(opts.src);
  return {
    source: emitSchemaSource(ir, opts.importPath),
    models: ir.models.map((m) => m.key),
    skipped: ir.skipped,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

interface PrismaPullArgs {
  schema: string;
  out: string;
  importPath: string;
  force: boolean;
}

export function parsePrismaPullArgs(argv: readonly string[]): PrismaPullArgs {
  let schema = DEFAULT_SCHEMA;
  let out = DEFAULT_OUT;
  let importPath = DEFAULT_IMPORT;
  let force = false;
  // First bare arg (not a flag) is the schema path: `ablo pull prisma path.prisma`.
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

export async function prismaPull(argv: readonly string[]): Promise<void> {
  let args: PrismaPullArgs;
  try {
    args = parsePrismaPullArgs(argv);
  } catch (err) {
    console.error(pc.red(`  ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  if (!existsSync(args.schema)) {
    console.error(
      pc.red(`  No Prisma schema at ${pc.bold(args.schema)}.`) +
        pc.dim(` Pass a path: ${pc.bold('ablo pull prisma <path>')}.`),
    );
    process.exit(1);
  }
  if (existsSync(args.out) && !args.force) {
    console.error(
      pc.red(`  ${args.out} already exists.`) + pc.dim(` Re-run with ${pc.bold('--force')} to overwrite.`),
    );
    process.exit(1);
  }

  console.log(`\n  ${brand('ablo')} ${pc.dim('pull prisma')}  ${pc.dim(args.schema)}\n`);

  let result: PulledPrismaSchema;
  try {
    const src = readFileSync(args.schema, 'utf8');
    result = buildSchemaSourceFromPrisma({ src, importPath: args.importPath });
  } catch (err) {
    console.error(pc.red(`  Couldn't parse the schema: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  if (result.models.length === 0) {
    console.error(
      pc.yellow(`  No adoptable models found`) +
        pc.dim(` (a model needs an ${pc.bold('id')} + ${pc.bold('organizationId')} / ${pc.bold('organization_id')}).`),
    );
    process.exit(1);
  }

  writeFileSync(args.out, result.source);
  console.log(`  ${pc.green('✓')} wrote ${pc.bold(args.out)} ${pc.dim(`(${result.models.length} models)`)}`);
  console.log(`  ${pc.dim(`models: ${result.models.join(', ')}`)}`);
  if (result.skipped.length > 0) {
    console.log(`  ${pc.dim(`${result.skipped.length} model(s) skipped:`)}`);
    for (const s of result.skipped) console.log(`    ${pc.dim(`- ${s.name}: ${s.reason}`)}`);
  }
  console.log(
    `\n  ${pc.dim('Enums and relations were preserved. Review the file, then')} ${pc.bold('ablo check')}.\n`,
  );
}
