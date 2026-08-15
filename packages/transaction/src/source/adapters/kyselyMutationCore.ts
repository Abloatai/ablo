/**
 * Reusable Kysely row-mutation core.
 *
 * This is the single schema-field ↔ database-column translation used by both
 * Kysely transports. It deliberately knows nothing about outboxes, logical
 * markers, or idempotency: wrappers compose those transaction policies around
 * the same `applyOperation` implementation, so direct and endpoint DML cannot
 * drift into separate hand-written mappers.
 */

import { AbloValidationError } from '../../errors.js';
import type { Schema, SchemaRecord } from '../../schema/schema.js';
import { toSchemaJSON } from '../../schema/serialize.js';
import { camelToSnake, snakeToCamel } from '../../schema/ddl.js';
import { tenancyColumn } from '../../schema/tenancy.js';
import type { AdapterReadRequest, Row } from '../adapter.js';
import type { Operation } from '../contract.js';

/** The subset of a Kysely instance, or transaction handle, used by the core. */
export interface KyselyLike {
  selectFrom(table: string): KyselySelectBuilder;
  insertInto(table: string): KyselyInsertBuilder;
  updateTable(table: string): KyselyUpdateBuilder;
  deleteFrom(table: string): KyselyDeleteBuilder;
  /** Execute a precompiled raw query on this exact transaction handle. */
  executeQuery(query: KyselyCompiledQuery): Promise<{ readonly rows: readonly Row[] }>;
  transaction(): KyselyTransactionBuilder;
}

/** Structural slice of Kysely's public `CompiledQuery` shape. */
export interface KyselyCompiledQuery {
  readonly query: {
    readonly kind: 'RawNode';
    readonly sqlFragments: readonly string[];
    readonly parameters: readonly [];
  };
  readonly queryId: { readonly queryId: string };
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

export interface KyselyTransactionBuilder {
  execute<T>(fn: (trx: KyselyLike) => Promise<T>): Promise<T>;
}

export interface KyselySelectBuilder {
  selectAll(): KyselySelectBuilder;
  where(column: string, operator: string, value: unknown): KyselySelectBuilder;
  orderBy(column: string, direction: 'asc' | 'desc'): KyselySelectBuilder;
  limit(limit: number): KyselySelectBuilder;
  execute(): Promise<readonly Row[]>;
}

export interface KyselyReturningExecutable {
  execute(): Promise<readonly Row[]>;
}

export interface KyselyInsertBuilder {
  values(row: Row): KyselyInsertValuesBuilder;
}

export interface KyselyInsertValuesBuilder {
  returningAll(): KyselyReturningExecutable;
  execute(): Promise<unknown>;
}

export interface KyselyUpdateBuilder {
  set(patch: Row): KyselyUpdateSetBuilder;
}

export interface KyselyUpdateSetBuilder {
  where(column: string, operator: string, value: unknown): KyselyUpdateSetBuilder;
  returningAll(): KyselyReturningExecutable;
}

export interface KyselyDeleteBuilder {
  where(column: string, operator: string, value: unknown): KyselyDeleteBuilder;
  returningAll(): KyselyReturningExecutable;
}

interface ModelColumns {
  readonly table: string;
  readonly fieldToColumn: ReadonlyMap<string, string>;
  readonly columnToField: ReadonlyMap<string, string>;
}

function buildColumnMaps(schema: Schema): ReadonlyMap<string, ModelColumns> {
  const json = toSchemaJSON(schema);
  const out = new Map<string, ModelColumns>();
  for (const [key, model] of Object.entries(json.models)) {
    const fieldToColumn = new Map<string, string>();
    const columnToField = new Map<string, string>();
    const register = (field: string, column: string): void => {
      if (column === camelToSnake(field)) return;
      fieldToColumn.set(field, column);
      columnToField.set(column, field);
    };
    for (const [field, meta] of Object.entries(model.fields)) {
      if (meta.column) register(field, meta.column);
    }
    const orgColumn = tenancyColumn(model.tenancy);
    if (orgColumn) register('organizationId', orgColumn);
    const columns = {
      table: model.tableName ?? key,
      fieldToColumn,
      columnToField,
    };
    // The public clients normalize operation model names to lowercase before
    // they cross the wire. Preserve the authored key for direct adapter users,
    // but resolve the same lowercase key/typename aliases as the server's
    // schema-derived ModelMap. Without these aliases, a camelCase schema key
    // such as `collaborationWorkItems` validates at the server boundary and
    // then fails here as an unknown customer model.
    out.set(key, columns);
    out.set(key.toLowerCase(), columns);
    if (model.typename) {
      out.set(model.typename, columns);
      out.set(model.typename.toLowerCase(), columns);
    }
  }
  return out;
}

/** Resolve the stable row id required by every source operation. */
export function kyselyOperationRowId(operation: Operation): string {
  const id = operation.id ?? (operation.input?.id as string | undefined);
  if (typeof id !== 'string' || id.length === 0) {
    throw new AbloValidationError(
      `operation on "${operation.model}" requires an id`,
      { code: 'source_operation_id_required' },
    );
  }
  return id;
}

function suppliedOperationRowId(operation: Operation): string | undefined {
  const id = operation.id ?? operation.input?.id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** The transport-independent Kysely field/column mutation boundary. */
export interface KyselyMutationCore {
  read(request: AdapterReadRequest): Promise<readonly Row[]>;
  applyOperation(transaction: KyselyLike, operation: Operation): Promise<Row>;
}

export function createKyselyMutationCore<S extends SchemaRecord>(
  db: KyselyLike,
  schema: Schema<S>,
): KyselyMutationCore {
  const maps = buildColumnMaps(schema);
  const modelColumns = (model: string): ModelColumns => {
    const columns = maps.get(model);
    if (!columns) {
      throw new AbloValidationError(
        `kysely mutation core: no model "${model}" in schema`,
        { code: 'source_adapter_misconfigured' },
      );
    }
    return columns;
  };

  const columnFor = (columns: ModelColumns, field: string): string =>
    columns.fieldToColumn.get(field) ?? camelToSnake(field);
  const fieldFor = (columns: ModelColumns, column: string): string =>
    columns.columnToField.get(column) ?? snakeToCamel(column);
  const toColumns = (columns: ModelColumns, row: Row): Row => {
    const out: Row = {};
    for (const key of Object.keys(row)) {
      out[columnFor(columns, key)] = row[key];
    }
    return out;
  };

  const toFields = (columns: ModelColumns, row: Row): Row => {
    const out: Row = {};
    for (const key of Object.keys(row)) {
      const field = fieldFor(columns, key);
      const value = row[key];
      out[field] = field === 'id' && value !== null && value !== undefined
        ? String(value)
        : value;
    }
    return out;
  };

  return {
    async read(request): Promise<readonly Row[]> {
      const columns = modelColumns(request.model);
      if (request.kind === 'load') {
        const rows = await db
          .selectFrom(columns.table)
          .selectAll()
          .where(columnFor(columns, 'id'), '=', request.id)
          .limit(1)
          .execute();
        return rows.map((row) => toFields(columns, row));
      }
      const rows = await db
        .selectFrom(columns.table)
        .selectAll()
        .limit(request.query?.limit ?? 1000)
        .execute();
      return rows.map((row) => toFields(columns, row));
    },

    async applyOperation(transaction, operation): Promise<Row> {
      const columns = modelColumns(operation.model);
      const input = operation.input ?? {};
      if (operation.where && operation.type !== 'UPDATE') {
        throw new AbloValidationError('where is supported only for UPDATE operations', {
          code: 'commit_operation_invalid',
          param: 'where',
        });
      }

      if (operation.type === 'CREATE') {
        const suppliedId = suppliedOperationRowId(operation);
        const createInput = operation.id == null
          ? Object.fromEntries(Object.entries(input).filter(([field]) => field !== 'id'))
          : input;
        const inserted = await transaction
          .insertInto(columns.table)
          .values(toColumns(columns, {
            ...createInput,
            ...(operation.id == null
              ? {}
              : suppliedId
                ? { id: suppliedId }
                : {}),
          }))
          .returningAll()
          .execute();
        if (!inserted[0]) {
          throw new AbloValidationError(
            `${operation.type} on "${operation.model}" returned no source row`,
            { code: 'source_adapter_misconfigured' },
          );
        }
        const row = toFields(columns, inserted[0]);
        if (typeof row.id !== 'string' || row.id.length === 0) {
          throw new AbloValidationError(
            `${operation.type} on "${operation.model}" did not return a canonical id`,
            { code: 'source_adapter_misconfigured' },
          );
        }
        return row;
      }

      const id = kyselyOperationRowId(operation);

      if (operation.type === 'DELETE') {
        const deleted = await transaction
          .deleteFrom(columns.table)
          .where(columnFor(columns, 'id'), '=', id)
          .returningAll()
          .execute();
        if (!deleted[0]) {
          throw new AbloValidationError(
            `${operation.type} on "${operation.model}/${id}" matched no source row`,
            { code: 'entity_not_found' },
          );
        }
        return toFields(columns, deleted[0]);
      }

      const patch = toColumns(columns, {
        ...input,
        ...(operation.type === 'ARCHIVE' ? { archivedAt: new Date() } : {}),
        ...(operation.type === 'UNARCHIVE' ? { archivedAt: null } : {}),
      });
      let update = transaction
        .updateTable(columns.table)
        .set(patch)
        .where(columnFor(columns, 'id'), '=', id);
      for (const [column, value] of Object.entries(toColumns(columns, operation.where ?? {}))) {
        update = update.where(column, '=', value);
      }
      const updated = await update.returningAll().execute();
      if (!updated[0]) {
        throw new AbloValidationError(
          operation.where
            ? `The conditional ${operation.type} on "${operation.model}/${id}" did not match`
            : `${operation.type} on "${operation.model}/${id}" matched no source row`,
          { code: operation.where ? 'precondition_failed' : 'mutate_update_entity_not_found' },
        );
      }
      return toFields(columns, updated[0]);
    },
  };
}
