/**
 * Per-model read configuration consumed when a client bootstraps. Each
 * {@link BootstrapModel} maps a model to its physical table, its tenancy column, and
 * any parent scoping — plain data with no database driver. It feeds the read side of
 * the data adapter contract; your query builder reads it to load a model's initial
 * rows.
 */

/** A mapping from a declared field to a physical column, with the alias to apply after a `SELECT *`. */
export interface ColumnOverride {
  readonly field: string;
  readonly column: string;
  readonly alias: string;
}

/** Read configuration for one model: how to locate its rows and scope them to a tenant. */
export interface BootstrapModel {
  name: string;
  /**
   * Extra names accepted when a request looks up or filters this model. When the
   * physical table name is canonical, `name` stays that table name and the aliases
   * cover generated compatibility names such as `WeatherReports` or `weatherReports`.
   */
  aliases?: readonly string[];
  /**
   * The schema key used by source endpoints. `name` stays the wire and result model
   * name (usually the typename), while source handlers are keyed by the developer's
   * schema key, such as `files` or `blocks`.
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
  /**
   * The model derives its tenant from the connected data source (`policy:
   * { by: 'source' }`) rather than a row column. It carries no tenant predicate on a
   * log plane, so it is excluded from the bootstrap set entirely until the
   * write-through connect path can resolve the org from the source registration —
   * serving it now would return every row to every tenant. Kept on the type as a
   * defense-in-depth marker so a source-scoped model that reaches `getBootstrapData`
   * fails closed rather than bootstrapping unscoped.
   */
  sourceScoped?: boolean;
  /** Physical tenancy column (default `organization_id`, configurable per model). */
  orgColumn?: string;
  /**
   * Parent-table scoping for rows that have no `organization_id` column, mirroring
   * the schema's `scopedVia` option. When set, the bootstrap query adds:
   *
   *   WHERE <table>.<localKey> IN
   *     (SELECT <parentKey> FROM <parentTable> WHERE <parentOrgColumn> = $1)
   *
   * This applies on top of whatever `orgScoped` dictates, so a table can carry its
   * own `organization_id` and still narrow through a parent. The common case,
   * though, is `orgScoped: false` together with `scopedVia` on a table that lacks the
   * column.
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
  /**
   * Physical columns the schema declares as JSON (via `field.json()`). A JSON field
   * stored in a text column comes back from `row_to_json` as a serialized string, so
   * the bootstrap reparses these columns to make the wire value the canonical object
   * regardless of the physical column type. A `jsonb` column already returns an
   * object, so reparsing it is a no-op.
   */
  jsonColumns?: readonly string[];
}
