/**
 * Canonical per-model read configuration — how one model's rows are located,
 * scoped to a tenant, and decoded back into the types the schema declared.
 *
 * {@link ReadModelShape} is the definition site for those facts. Every read seam
 * needs the same set, and each one that restated the set drifted from the
 * others: `json` decoding reached three of them, `number` decoding reached none,
 * and the where-clause `boolean` list reached exactly one — so a `bigint`-backed
 * field left one seam as a decimal string and its `int4` neighbour left the next
 * as a number. Adding a declared type is now one edit here rather than a
 * remembered sweep.
 *
 * The descriptors below carry that shape plus the facts only they need. They
 * disagree on one thing, deliberately: the model's own name. A bootstrap
 * descriptor spells it `name`, the server's read-model descriptor spells it
 * `typename`. `name` is part of the published data-adapter contract, so the two
 * spellings stay and the shape they share owns everything else.
 *
 * Plain data, no database driver — it feeds the read side of the data adapter
 * contract, and your query builder reads it to load a model's initial rows.
 */
import type { SubjectRule } from '../schema/subject.js';


/** A mapping from a declared field to a physical column, with the alias to apply after a `SELECT *`. */
export interface ColumnOverride {
  readonly field: string;
  readonly column: string;
  readonly alias: string;
}

/**
 * Parent-table tenancy scoping for rows that have no `organization_id` column
 * of their own, mirroring the schema's `scopedVia` option. A read carrying this
 * adds:
 *
 *   WHERE <table>.<localKey> IN
 *     (SELECT <parentKey> FROM <parentTable> WHERE <parentOrgColumn> = $1)
 *
 * It applies on top of whatever `orgScoped` dictates, so a table can carry its
 * own `organization_id` and still narrow through a parent. The common case is
 * `orgScoped: false` together with this on a table that lacks the column —
 * without it, such a table reads every tenant's rows.
 */
export interface ParentScope {
  readonly localKey: string;
  readonly parentTable: string;
  readonly parentKey?: string;
  readonly parentOrgColumn?: string;
}

/**
 * Everything a read seam needs to know about one model except what it is called.
 *
 * Split from the descriptors that carry it because the two of them name the
 * model differently and agree on all of this. A seam that only decodes, or only
 * compiles SQL, projects the members it uses with `Pick` rather than declaring
 * its own near-copy.
 */
export interface ReadModelShape {
  /**
   * Extra names accepted when a request looks up or filters this model. When the
   * physical table name is canonical, the descriptor's own name stays that table
   * name and the aliases cover generated compatibility names such as
   * `WeatherReports` or `weatherReports`.
   */
  readonly aliases?: readonly string[];
  /**
   * The schema key used by source endpoints. The descriptor's own name stays the
   * wire and result model name (usually the typename), while source handlers are
   * keyed by the developer's schema key, such as `files` or `blocks`.
   */
  readonly sourceModel?: string;
  readonly table: string;
  /** Whether the table has organization_id. Default: true. */
  readonly orgScoped?: boolean;
  /**
   * The model derives its tenant from the connected data source (`policy:
   * { by: 'source' }`) rather than a row column — the source registration is the
   * tenant boundary. Distinct from `orgScoped: false` (a `none`/global model): a
   * source-scoped model IS tenant-scoped, just not by a column. It carries no
   * tenant predicate on a log plane, so every read and bootstrap site fails it
   * closed with `source_tenancy_not_enforced` rather than treating it as global
   * — serving it now would return every row to every tenant. When the
   * write-through connect path can resolve the org from the source registration,
   * this same flag routes to that resolution.
   */
  readonly sourceScoped?: boolean;
  /** Physical tenancy column (default `organization_id`, configurable per model). */
  readonly orgColumn?: string;
  /** Parent-table scoping for rows with no tenancy column of their own. */
  readonly scopedVia?: ParentScope;
  /** Credential-bound row authorization compiled by every read plane. */
  readonly subject?: SubjectRule;
  /** Client-facing field name → physical DB column for declared fields. */
  readonly fieldColumns?: Readonly<Record<string, string>>;
  /** Physical-column aliases needed after SELECT * for `.from(...)` fields. */
  readonly columnOverrides?: readonly ColumnOverride[];
  /**
   * Physical columns the schema declares as JSON (via `field.json()`). A JSON
   * field stored in a text column comes back serialized, so a read reparses these
   * to make the wire value the canonical object regardless of the physical column
   * type. A `jsonb` column already returns an object, so reparsing it is a no-op.
   */
  readonly jsonColumns?: readonly string[];
  /**
   * Physical columns the schema declares as a boolean (via `field.boolean()`).
   * Two seams need the list. A where-clause parameter is coerced to a real JS
   * boolean before binding, because the driver's bool encoder is a strict
   * `=== true` and a string `'t'` would silently bind as `'f'` — an INVERTED
   * filter, not an error. A row read back from the log is coerced the same way,
   * because a value echoed from a customer's database arrives as PG's text
   * literal rather than as `true`.
   */
  readonly boolColumns?: readonly string[];
  /**
   * Physical columns the schema declares as a number (via `field.number()`).
   * Postgres has four integer widths where JavaScript has one, so a column too
   * wide to always fit a JS number comes back as decimal text. A read decodes
   * these so a `bigint`-backed field and an `int4`-backed one reach the client as
   * the same JS type.
   */
  readonly numberColumns?: readonly string[];
}

/**
 * Read configuration for one model at bootstrap: {@link ReadModelShape} plus the
 * facts only the initial payload needs — which models are in it, how much of
 * each, and in what order.
 */
export interface BootstrapModel extends ReadModelShape {
  /** The wire and result model name. `ModelMeta.typename` is the same fact. */
  readonly name: string;
  readonly syncGroups?: readonly string[];
  readonly enabled?: boolean;
  /** Max rows to return. Omit for unlimited. Maps to schema's bootstrapLimit. */
  readonly limit?: number;
  /** SQL ORDER BY clause. Default: 'id'. Maps to schema's bootstrapOrderBy. */
  readonly orderBy?: string;
}
