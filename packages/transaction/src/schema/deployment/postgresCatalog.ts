import type { DatabaseTableSnapshot } from './contracts.js';

export interface PostgresColumnCatalogRow {
  tableName: string;
  columnName: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string | null;
  primary: boolean;
  uniqueColumn: boolean;
  rowLevelSecurity: boolean;
  forceRowLevelSecurity: boolean;
  replicaIdentity: string;
  publicationMember: boolean;
}

export interface PostgresIndexCatalogRow {
  tableName: string;
  indexName: string;
  columns: string[];
  uniqueIndex: boolean;
  valid: boolean;
  ready: boolean;
  predicate: string | null;
}

export interface PostgresForeignKeyCatalogRow {
  tableName: string;
  constraintName: string;
  columns: string[];
  referencedSchema: string;
  referencedTable: string;
  referencedColumns: string[];
  validated: boolean;
}

export const POSTGRES_COLUMN_CATALOG_SQL = `
  SELECT c.relname AS "tableName", a.attname AS "columnName",
    format_type(a.atttypid, a.atttypmod) AS "dataType", NOT a.attnotnull AS nullable,
    pg_get_expr(d.adbin, d.adrelid) AS "defaultValue",
    EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'p' AND cardinality(k.conkey) = 1 AND a.attnum = ANY(k.conkey)) AS primary,
    EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype IN ('p','u') AND cardinality(k.conkey) = 1 AND a.attnum = ANY(k.conkey)) AS "uniqueColumn",
    c.relrowsecurity AS "rowLevelSecurity", c.relforcerowsecurity AS "forceRowLevelSecurity",
    c.relreplident::text AS "replicaIdentity",
    EXISTS (SELECT 1 FROM pg_publication_tables p WHERE p.schemaname = n.nspname AND p.tablename = c.relname) AS "publicationMember"
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
  WHERE n.nspname = $1 AND c.relkind IN ('r','p') ORDER BY c.relname, a.attnum
`;

export const POSTGRES_INDEX_CATALOG_SQL = `
  SELECT t.relname AS "tableName", i.relname AS "indexName",
    ARRAY(SELECT a.attname FROM unnest(ix.indkey) WITH ORDINALITY keys(attnum, ord) JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = keys.attnum ORDER BY keys.ord) AS columns,
    ix.indisunique AS "uniqueIndex", ix.indisvalid AS valid, ix.indisready AS ready,
    pg_get_expr(ix.indpred, ix.indrelid) AS predicate
  FROM pg_index ix JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_class i ON i.oid = ix.indexrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = $1 ORDER BY t.relname, i.relname
`;

export const POSTGRES_FOREIGN_KEY_CATALOG_SQL = `
  SELECT t.relname AS "tableName", c.conname AS "constraintName",
    ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY keys(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = keys.attnum ORDER BY keys.ord) AS columns,
    rn.nspname AS "referencedSchema", rt.relname AS "referencedTable",
    ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY keys(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = keys.attnum ORDER BY keys.ord) AS "referencedColumns",
    c.convalidated AS validated
  FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_class rt ON rt.oid = c.confrelid JOIN pg_namespace rn ON rn.oid = rt.relnamespace
  WHERE c.contype = 'f' AND n.nspname = $1 ORDER BY t.relname, c.conname
`;

export function quotePostgresIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function postgresNullCountSql(appSchema: string, table: string, column: string): string {
  const qualified = `${quotePostgresIdentifier(appSchema)}.${quotePostgresIdentifier(table)}`;
  return `SELECT count(*)::int AS n FROM (SELECT 1 FROM ${qualified} WHERE ${quotePostgresIdentifier(column)} IS NULL LIMIT 501) unstamped`;
}

export function foldPostgresCatalog(
  appSchema: string,
  columns: readonly PostgresColumnCatalogRow[],
  indexes: readonly PostgresIndexCatalogRow[],
  foreignKeys: readonly PostgresForeignKeyCatalogRow[],
): Record<string, DatabaseTableSnapshot> {
  const tables: Record<string, DatabaseTableSnapshot> = {};
  for (const row of columns) {
    const table = tables[row.tableName] ?? {
      schema: appSchema,
      name: row.tableName,
      columns: {},
      indexes: [],
      foreignKeys: [],
      rowLevelSecurity: row.rowLevelSecurity,
      forceRowLevelSecurity: row.forceRowLevelSecurity,
      replicaIdentity: row.replicaIdentity,
      publicationMember: row.publicationMember,
    };
    table.columns[row.columnName] = {
      name: row.columnName,
      dataType: row.dataType,
      nullable: row.nullable,
      default: row.defaultValue,
      primary: row.primary,
      unique: row.uniqueColumn,
    };
    tables[row.tableName] = table;
  }
  for (const row of indexes) {
    tables[row.tableName]?.indexes?.push({
      name: row.indexName,
      columns: row.columns,
      unique: row.uniqueIndex,
      valid: row.valid,
      ready: row.ready,
      predicate: row.predicate,
    });
  }
  for (const row of foreignKeys) {
    tables[row.tableName]?.foreignKeys?.push({
      name: row.constraintName,
      columns: row.columns,
      referencedSchema: row.referencedSchema,
      referencedTable: row.referencedTable,
      referencedColumns: row.referencedColumns,
      validated: row.validated,
    });
  }
  return tables;
}
