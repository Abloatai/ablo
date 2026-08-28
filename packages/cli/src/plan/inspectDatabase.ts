import postgres from 'postgres';
import {
  deploymentFingerprint,
  foldPostgresCatalog,
  postgresNullCountSql,
  POSTGRES_COLUMN_CATALOG_SQL,
  POSTGRES_FOREIGN_KEY_CATALOG_SQL,
  POSTGRES_INDEX_CATALOG_SQL,
  resolveTenancy,
  tenancyColumn,
  type DatabaseSnapshot,
  type PostgresColumnCatalogRow,
  type PostgresForeignKeyCatalogRow,
  type PostgresIndexCatalogRow,
  type SchemaJSON,
} from '@abloatai/transaction/schema';

function databaseSubject(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return `${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname}`;
  } catch {
    return 'configured PostgreSQL database';
  }
}

/** CLI transport adapter for the shared PostgreSQL catalog observation. */
export async function inspectDatabase(
  connectionString: string,
  appSchema = 'public',
  schema?: SchemaJSON,
): Promise<DatabaseSnapshot> {
  const sql = postgres(connectionString, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const [columnRows, indexRows, foreignKeyRows] = await Promise.all([
      sql.unsafe<PostgresColumnCatalogRow[]>(POSTGRES_COLUMN_CATALOG_SQL, [appSchema] as never[]),
      sql.unsafe<PostgresIndexCatalogRow[]>(POSTGRES_INDEX_CATALOG_SQL, [appSchema] as never[]),
      sql.unsafe<PostgresForeignKeyCatalogRow[]>(POSTGRES_FOREIGN_KEY_CATALOG_SQL, [appSchema] as never[]),
    ]);
    const tables = foldPostgresCatalog(appSchema, columnRows, indexRows, foreignKeyRows);

    if (schema) {
      for (const [modelKey, model] of Object.entries(schema.models)) {
        const column = tenancyColumn(resolveTenancy(model));
        const tableName = model.tableName ?? modelKey;
        const actual = column ? tables[tableName]?.columns[column] : undefined;
        if (!column || !actual) continue;
        try {
          const result = await sql.unsafe<{ n: number }[]>(
            postgresNullCountSql(appSchema, tableName, column),
          );
          actual.nullCount = result[0]?.n ?? 0;
        } catch {
          actual.nullCount = null;
        }
      }
    }

    const subject = databaseSubject(connectionString);
    return {
      observedAt: new Date().toISOString(),
      subject,
      fingerprint: deploymentFingerprint({ appSchema, subject, tables }),
      appSchema,
      ownership: 'application',
      tables,
    };
  } finally {
    await sql.end({ timeout: 2 });
  }
}
