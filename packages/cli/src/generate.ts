/**
 * Implements `ablo generate`, which emits TypeScript types from your local
 * schema.
 *
 *   ablo generate [--schema ablo/schema.ts] [--export schema] [--out ablo/generated.ts]
 *
 * It loads the same `defineSchema(...)` that `ablo push` uploads, lowers it to
 * row interfaces and an `AbloSchema` map with `generateTypes`, and writes the
 * result. Because the types come from the very schema you push, the types your
 * app compiles against are the ones the database and sync layer enforce.
 */

import { AbloValidationError } from '@abloatai/transaction/errors';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import pc from 'picocolors';
import { serializeSchema, generateTypes, type SchemaJSON } from '@abloatai/transaction/schema';
import { loadSchema } from './push';

export interface GenerateArgs {
  schemaPath: string;
  exportName: string;
  out: string;
}

const DEFAULT_SCHEMA_PATH = 'ablo/schema.ts';
const DEFAULT_EXPORT = 'schema';
const DEFAULT_OUT = 'ablo/generated.ts';

/** Parses the `generate` command's flags into {@link GenerateArgs}. Does no I/O, so it can be unit-tested without touching disk. */
export function parseGenerateArgs(argv: readonly string[]): GenerateArgs {
  let schemaPath = DEFAULT_SCHEMA_PATH;
  let exportName = DEFAULT_EXPORT;
  let out = DEFAULT_OUT;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--schema':
        schemaPath = argv[++i] ?? schemaPath;
        break;
      case '--export':
        exportName = argv[++i] ?? exportName;
        break;
      case '--out':
        out = argv[++i] ?? out;
        break;
      default:
        throw new AbloValidationError(`unknown flag: ${arg}`, { code: 'cli_invalid_arguments' });
    }
  }
  return { schemaPath, exportName, out };
}

export async function generate(argv: readonly string[]): Promise<void> {
  let args: GenerateArgs;
  try {
    args = parseGenerateArgs(argv);
  } catch (err) {
    console.error(pc.red(`  ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  let source: string;
  try {
    const schema = await loadSchema(args.schemaPath, args.exportName);
    const schemaJson = JSON.parse(serializeSchema(schema)) as SchemaJSON;
    source = generateTypes(schemaJson);
  } catch (err) {
    console.error(pc.red(`  ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  const abs = resolve(process.cwd(), args.out);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, source);
  console.log(`  ${pc.green('✓')} Generated types → ${pc.bold(args.out)}`);
}
