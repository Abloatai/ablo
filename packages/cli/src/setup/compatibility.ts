import {
  setupCompatibilityDispositionSchema,
  setupDatabaseColumnSchema,
  type SetupCompatibilityBlocker,
  type SetupCompatibilityDisposition,
  type SetupDatabaseMapping,
  type SetupEvidence,
  type SetupDatabaseColumn,
} from './contracts';

type DatabaseIdentityType = NonNullable<SetupDatabaseMapping['databaseType']>;

export interface SetupTransactionalRequirement {
  readonly table: string;
  readonly conditionalAtomicMutation: boolean;
  readonly transactionBoundTypedResult: boolean;
  readonly evidence: SetupEvidence;
}

function normalizedType(type: string): string {
  return type.toLowerCase().replace(/\s+/g, ' ').trim();
}

function databaseIdentityType(type: string): DatabaseIdentityType | null {
  const value = normalizedType(type);
  if (value === 'uuid') return 'uuid';
  if (['text', 'citext', 'character varying', 'varchar', 'character', 'char'].includes(value)) {
    return 'text';
  }
  if (value === 'bigint' || value === 'bigserial') return 'bigint';
  return null;
}

function sourceEvidence(detail: string, locator: string): SetupEvidence {
  return {
    source: 'filesystem',
    locator,
    detail,
    observedAt: new Date().toISOString(),
  };
}

function blocker(
  input: Omit<SetupCompatibilityBlocker, 'evidence'> & { evidence: SetupEvidence },
): SetupCompatibilityBlocker {
  return { ...input, evidence: [input.evidence] };
}

function dispositionFor(
  blockers: readonly SetupCompatibilityBlocker[],
  mappings: readonly SetupDatabaseMapping[] = [],
): SetupCompatibilityDisposition {
  if (blockers.length === 0) {
    return setupCompatibilityDispositionSchema.parse({ status: 'compatible', blockers: [], mappings });
  }
  const kinds = new Set(blockers.flatMap((item) => item.remediations.map(({ kind }) => kind)));
  const status = kinds.has('unsupported')
    ? 'unsupported'
    : kinds.has('migration') && kinds.has('translation')
      ? 'migration_or_translation_required'
      : kinds.has('migration')
        ? 'migration_required'
        : kinds.has('translation')
          ? 'translation_required'
          : 'unsupported';
  return setupCompatibilityDispositionSchema.parse({ status, blockers, mappings });
}

/**
 * Compare established PostgreSQL tables with Ablo's stable identity and
 * atomic-commit contracts. This function is pure so catalog, ORM, and
 * source-derived metadata all pass through the same compatibility rules.
 */
export function analyzeSetupCompatibility(input: {
  readonly columns: readonly SetupDatabaseColumn[];
  readonly requirements?: readonly SetupTransactionalRequirement[];
  readonly schemaEvidence?: SetupEvidence;
}): SetupCompatibilityDisposition {
  const columns = setupDatabaseColumnSchema.array().parse(input.columns);
  if (columns.length === 0) {
    return dispositionFor([blocker({
      code: 'database_schema_unavailable',
      table: null,
      field: null,
      observed: 'No database table metadata was available.',
      expected: 'Primary keys, database types, defaults, generation ownership, nullability, and declared fields.',
      remediations: [{ kind: 'unsupported', summary: 'Provide reviewed PostgreSQL catalog or ORM metadata before adapting writes.' }],
      evidence: input.schemaEvidence ?? sourceEvidence(
        'No usable CREATE TABLE or catalog metadata was discovered.',
        'repository',
      ),
    })]);
  }

  const blockers: SetupCompatibilityBlocker[] = [];
  const mappings: SetupDatabaseMapping[] = [];
  const byTable = new Map<string, SetupDatabaseColumn[]>();
  for (const column of columns) {
    const existing = byTable.get(column.table) ?? [];
    existing.push(column);
    byTable.set(column.table, existing);
  }

  for (const [table, tableColumns] of byTable) {
    const byName = new Map(tableColumns.map((column) => [column.column.toLowerCase(), column]));
    const id = byName.get('id');
    const tableEvidence = input.schemaEvidence ?? sourceEvidence(
      `Derived database columns for ${table}.`,
      table,
    );
    if (!id) {
      blockers.push(blocker({
        code: 'stable_identity_missing', table, field: 'id',
        observed: 'No id column.', expected: 'A stable logical identity.',
        remediations: [
          { kind: 'migration', summary: 'Add a stable identity column.' },
          { kind: 'translation', summary: 'Map an existing stable primary key to logical id.' },
        ], evidence: tableEvidence,
      }));
    } else {
      const databaseType = databaseIdentityType(id.dataType);
      if (!databaseType) {
        blockers.push(blocker({
          code: 'identity_type_unsupported', table, field: 'id',
          observed: `${id.column} is ${id.dataType}.`, expected: 'A canonical string-compatible identity.',
          remediations: [
            { kind: 'migration', summary: 'Migrate the database identity to a string-compatible type.' },
            { kind: 'translation', summary: 'Add lossless identity normalization at the database boundary.' },
          ], evidence: tableEvidence,
        }));
      } else {
        mappings.push({
          table,
          field: 'id',
          column: id.column,
          databaseType,
          generatedBy: id.generatedBy,
          status: 'ready',
          reason: id.generatedBy === 'database'
            ? 'Use the identity returned by the writing database transaction.'
            : 'Preserve the established application identity.',
          evidence: [tableEvidence],
        });
      }
    }

  }

  return dispositionFor(blockers, mappings);
}

function splitSqlColumns(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (char === ',' && depth === 0) {
      parts.push(body.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

/** Conservative source fallback. Catalog metadata should replace this when available. */
export function discoverDatabaseColumnsFromSqlSource(input: {
  readonly path: string;
  readonly source: string;
}): SetupDatabaseColumn[] {
  const columns: SetupDatabaseColumn[] = [];
  const tablePattern = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:["\w]+\.)?["']?([\w-]+)["']?\s*\(/gi;
  for (const match of input.source.matchAll(tablePattern)) {
    const table = match[1];
    if (!table || match.index === undefined) continue;
    const bodyStart = match.index + match[0].length;
    let depth = 1;
    let bodyEnd = bodyStart;
    let quote: "'" | '"' | null = null;
    for (; bodyEnd < input.source.length; bodyEnd += 1) {
      const char = input.source[bodyEnd];
      if (quote) {
        if (char === quote && input.source[bodyEnd + 1] === quote) {
          bodyEnd += 1;
        } else if (char === quote) {
          quote = null;
        }
        continue;
      }
      if (char === "'" || char === '"') {
        quote = char;
      } else if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) continue;
    const body = input.source.slice(bodyStart, bodyEnd);
    for (const definition of splitSqlColumns(body)) {
      const trimmed = definition.trim();
      if (!trimmed || /^(?:CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK)\b/i.test(trimmed)) continue;
      const columnMatch = /^["']?([\w-]+)["']?\s+([A-Za-z]+(?:\s+(?:without|with)\s+time\s+zone)?)/i.exec(trimmed);
      if (!columnMatch?.[1] || !columnMatch[2]) continue;
      const dataType = columnMatch[2].trim();
      const defaultMatch = /\bDEFAULT\s+([^,\s]+(?:\([^)]*\))?)/i.exec(trimmed);
      columns.push(setupDatabaseColumnSchema.parse({
        table,
        column: columnMatch[1],
        dataType,
        nullable: !/\bNOT\s+NULL\b/i.test(trimmed),
        defaultExpression: defaultMatch?.[1] ?? null,
        generatedBy: /\b(?:smallserial|serial|bigserial)\b/i.test(dataType) || /\bGENERATED\b[\s\S]*\bIDENTITY\b/i.test(trimmed)
          ? 'database'
          : 'application',
      }));
    }
  }
  return columns;
}

/** Detect only the transaction shape that setup must not weaken into remote CRUD calls. */
export function discoverTransactionalRequirementsFromSqlSource(input: {
  readonly path: string;
  readonly source: string;
}): SetupTransactionalRequirement[] {
  if (!/\bBEGIN\b/i.test(input.source) || !/\bCOMMIT\b/i.test(input.source)) return [];
  const createsDependentRow = /\bINSERT\s+INTO\b/i.test(input.source);
  const requirements: SetupTransactionalRequirement[] = [];
  const updates = input.source.matchAll(/\bUPDATE\s+["']?([\w-]+)["']?\s+SET\b([\s\S]*?)\bWHERE\b([\s\S]*?)(?:;|`|'|\")/gi);
  for (const match of updates) {
    const table = match[1];
    const predicate = match[3] ?? '';
    if (!table) continue;
    const equalityCount = [...predicate.matchAll(/(?:=|\bIS\s+NULL\b)/gi)].length;
    const returnsRow = /\bRETURNING\b/i.test(`${match[2] ?? ''} ${predicate}`) || /\bRETURNING\b/i.test(input.source);
    if (!createsDependentRow || (equalityCount < 2 && !returnsRow)) continue;
    requirements.push({
      table,
      conditionalAtomicMutation: equalityCount >= 2,
      transactionBoundTypedResult: returnsRow,
      evidence: sourceEvidence(
        'Detected a BEGIN/COMMIT transaction containing a conditional UPDATE, RETURNING, and a dependent INSERT.',
        input.path,
      ),
    });
  }
  return requirements;
}
