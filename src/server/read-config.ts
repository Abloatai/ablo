/**
 * `@abloatai/ablo/server` — per-model READ configuration the bootstrap
 * reader consumes. Host-side type config (physical table, tenancy column,
 * parent-scoping) — pure data, no `postgres` — so it lives in the server
 * subpath and feeds the `DataAdapter` read contract. The SQL that consumes it
 * (the bootstrap query builder) stays host-side.
 */

/** A field→column mapping with an explicit post-`SELECT *` alias. */
export interface ColumnOverride {
  readonly field: string;
  readonly column: string;
  readonly alias: string;
}

export interface BootstrapModel {
  name: string;
  /**
   * Additional names accepted for request-side lookup/filtering. In DB-canonical
   * mode `name` stays the physical table name, while aliases cover generated
   * compatibility names such as `WeatherReports` / `weatherReports`.
   */
  aliases?: readonly string[];
  /**
   * Schema key used by source endpoints. `name` remains the wire/result model
   * name, usually the typename; source handlers are keyed by the developer's
   * schema object (`files`, `slideLayers`, ...).
   */
  sourceModel?: string;
  table: string;
  syncGroups?: string[];
  enabled?: boolean;
  /** Max rows to return. Omit for unlimited. Maps to schema's bootstrapLimit. */
  limit?: number;
  /** SQL ORDER BY clause. Default: 'id'. Maps to schema's bootstrapOrderBy. */
  orderBy?: string;
  /** Whether the table has organization_id. Default: true. */
  orgScoped?: boolean;
  /** Physical tenancy column (default `organization_id`, configurable per model). */
  orgColumn?: string;
  /**
   * Parent-table scoping for rows with no `organization_id` column. Mirrors the
   * schema's `scopedVia` option. When set, the bootstrap query emits:
   *
   *   WHERE <table>.<localKey> IN
   *     (SELECT <parentKey> FROM <parentTable> WHERE <parentOrgColumn> = $1)
   *
   * Applied IN ADDITION TO whatever `orgScoped` dictates — so a table can have
   * its own `organization_id` AND further narrow via a parent, though the common
   * use is `orgScoped: false` + `scopedVia` on tables that lack the column.
   */
  scopedVia?: {
    localKey: string;
    parentTable: string;
    parentKey?: string;
    parentOrgColumn?: string;
  };
  /** Client-facing field name → physical DB column for declared fields. */
  fieldColumns?: Record<string, string>;
  /** Physical-column aliases needed after SELECT * for `.from(...)` fields. */
  columnOverrides?: readonly ColumnOverride[];
}
