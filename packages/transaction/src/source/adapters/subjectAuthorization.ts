import { AbloPermissionError, AbloValidationError } from '../../errors.js';
import {
  composeEntitySyncGroups,
  syncGroupsForRow,
  InvalidRecordSubjectError,
  scopeKindOf,
  subjectAuthorized,
  type Schema,
  type SchemaRecord,
  type SubjectRule,
} from '../../schema/index.js';
import type { AdapterReadRequest, Row } from './adapter.js';
import type { ChangeSet, Operation } from './contract.js';

function sourceModelEntry<S extends SchemaRecord>(schema: Schema<S>, model: string) {
  return Object.entries(schema.models).find(([key, def]) =>
    key === model || key.toLowerCase() === model.toLowerCase() ||
    def.typename === model || def.typename?.toLowerCase() === model.toLowerCase(),
  );
}

function deny(): never {
  throw new AbloPermissionError('The resolved scope does not cover the requested row.', {
    code: 'capability_scope_denied',
    httpStatus: 403,
  });
}

export function sourceSubjectRule<S extends SchemaRecord>(
  schema: Schema<S>,
  model: string,
): SubjectRule | undefined {
  const entry = sourceModelEntry(schema, model);
  return entry?.[1].subject;
}

/** Derive the durable record routes while the row is transactionally visible. */
export function sourceSyncGroups<S extends SchemaRecord>(
  schema: Schema<S>,
  model: string,
  row: Row,
): readonly string[] {
  const entry = sourceModelEntry(schema, model);
  if (!entry) return [];
  const [key, definition] = entry;
  const parents: { kind: string; field: string }[] = [];
  const selfKind = scopeKindOf(definition, key);
  for (const relation of Object.values(definition.relations ?? {})) {
    if (relation.type !== 'belongsTo' || relation.options?.parent !== true) continue;
    const target = schema.models[relation.target];
    const kind = target && scopeKindOf(target, relation.target);
    if (kind) parents.push({ kind, field: relation.foreignKey });
  }
  try {
    return syncGroupsForRow(
      {
        selfKind,
        parents,
        ...(definition.subject
          ? { subject: { kind: definition.subject.group, field: definition.subject.field } }
          : {}),
      },
      row,
      composeEntitySyncGroups(row, definition),
    );
  } catch (error) {
    if (!(error instanceof InvalidRecordSubjectError)) throw error;
    throw new AbloValidationError(
      `Source row ${model}/${String(row.id ?? '')} lacks subject field "${error.field}".`,
      { code: 'source_event_invalid', cause: error },
    );
  }
}

/** Subject values represented by a trusted group set, preserving group order. */
export function sourceSubjectValues(
  rule: SubjectRule | undefined,
  groups: readonly string[] | undefined,
): readonly string[] | undefined {
  if (!rule) return undefined;
  const prefix = `${rule.group}:`;
  return [...new Set(
    (groups ?? [])
      .filter((group) => group.startsWith(prefix))
      .map((group) => group.slice(prefix.length))
      .filter((value) => value.length > 0),
  )];
}

/**
 * Stable absent-row lock keys for caller-selected subject-scoped CREATE ids.
 * Adapters acquire these in sorted order before loading current rows, so two
 * authorized writers cannot both observe an absent id. Database uniqueness is
 * still the final boundary against external writers that ignore this lock.
 */
function sourceSubjectCreateLockOperations<S extends SchemaRecord>(
  schema: Schema<S>,
  change: ChangeSet,
): readonly Operation[] {
  return change.operations
    .filter((operation) =>
      operation.type === 'CREATE' &&
      typeof operation.id === 'string' &&
      operation.id.length > 0 &&
      sourceSubjectRule(schema, operation.model) !== undefined)
    .sort((left, right) =>
      `${left.model.toLowerCase()}\u0000${left.id}`.localeCompare(
        `${right.model.toLowerCase()}\u0000${right.id}`,
      ));
}

export function sourceSubjectCreateLockKey(operation: Operation): string {
  return `ablo:subject-create:${operation.model.toLowerCase()}:${operation.id ?? ''}`;
}

/** Acquire every absent-key CREATE lock in canonical order. */
export async function lockSourceSubjectCreates<S extends SchemaRecord>(
  schema: Schema<S>,
  change: ChangeSet,
  acquire: (operation: Operation, key: string) => Promise<void>,
): Promise<void> {
  for (const operation of sourceSubjectCreateLockOperations(schema, change)) {
    await acquire(operation, sourceSubjectCreateLockKey(operation));
  }
}

function errorCode(error: unknown): unknown {
  return error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
}

/** Translate ORM/driver primary-key conflicts without exposing the winning row. */
export function rethrowStrictCreateConflict(error: unknown, operation: Operation): never {
  const code = errorCode(error) ?? errorCode(
    error && typeof error === 'object' ? (error as { cause?: unknown }).cause : undefined,
  );
  if (code === '23505' || code === 'P2002') {
    throw new AbloValidationError(
      `A row already exists for ${operation.model}/${operation.id ?? ''}.`,
      { code: 'entity_already_exists', httpStatus: 409, cause: error },
    );
  }
  throw error;
}

export function authorizeSourceRead<S extends SchemaRecord>(
  schema: Schema<S>,
  req: AdapterReadRequest,
  rows: readonly Row[],
): readonly Row[] {
  const rule = sourceSubjectRule(schema, req.model);
  if (!rule) return rows;
  const groups = req.scope?.syncGroups;
  const authorized = rows.filter((row) => subjectAuthorized(rule, row, groups));
  if (req.kind === 'load' && rows.length > 0 && authorized.length === 0) deny();
  return authorized;
}

function authorizePayload(rule: SubjectRule, row: Row, groups: readonly string[] | undefined): void {
  if (!subjectAuthorized(rule, row, groups)) deny();
}

export async function authorizeSourceChange<S extends SchemaRecord>(
  schema: Schema<S>,
  change: ChangeSet,
  load: (operation: Operation) => Promise<Row | null>,
): Promise<void> {
  for (const operation of change.operations) {
    const rule = sourceSubjectRule(schema, operation.model);
    if (!rule) continue;
    const current = operation.id ? await load(operation) : null;
    if (current) authorizePayload(rule, current, change.scope?.syncGroups);
    if (operation.type === 'CREATE') {
      authorizePayload(rule, operation.input ?? {}, change.scope?.syncGroups);
    } else if (!current) {
      deny();
    }
    if (current && operation.input && Object.hasOwn(operation.input, rule.field) &&
        !Object.is(current[rule.field], operation.input[rule.field])) {
      deny();
    }
  }
}
