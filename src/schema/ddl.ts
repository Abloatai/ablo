/**
 * Schema → Postgres DDL — the one pure SQL emitter shared by every consumer.
 *
 * `defineSchema(...)` (serialized to {@link SchemaJSON}) is the single source of
 * truth; this module lowers it to ordered DDL strings. Both the hosted server
 * (which applies it to Ablo-managed Postgres on `schema push`) and the
 * `ablo migrate` CLI (which applies it to a customer's own Postgres) call these
 * generators, so the SQL — column types, RLS, enum checks — is identical no
 * matter who runs it. There is no second type map.
 *
 * Everything here is pure (returns strings; no DB, no I/O); the execution side
 * (transaction + advisory lock) lives with each consumer because it's coupled
 * to that consumer's Postgres client and error type.
 *
 *  - `generateProvisionPlan` — additive + idempotent (CREATE/ADD … IF NOT
 *    EXISTS + RLS). Never loses data. The "create my tables" primitive.
 *  - `generateMigrationPlan` — the destructive-aware counterpart driven by the
 *    {@link diffSchema} step list (drops, renames, type casts, backfills).
 */

import { AbloValidationError } from '../errors.js';
import type { SchemaJSON, ModelJSON } from './serialize.js';
import type { MigrationStep, BackfillValue, FieldType } from './diff.js';
import type { FieldMeta } from './field.js';
import { resolveTenancy, tenancyColumn } from './tenancy.js';

export interface ProvisionPlan {
  /** The Postgres schema the tables live in (`app_<id>` or `public`). */
  readonly appSchema: string;
  /** Ordered, idempotent DDL statements. Safe to run repeatedly. Executors run
   *  these together in ONE transaction. */
  readonly statements: readonly string[];
  /** Post-commit, NON-transactional DDL (`VALIDATE CONSTRAINT`, `CREATE INDEX
   *  CONCURRENTLY`) — run AFTER {@link statements} commit, each outside any
   *  transaction, best-effort. Keeps the lock-heavy / scan-heavy work off the
   *  main transaction so adding a foreign key never freezes a large, live BYO
   *  table. Optional + back-compat: absent = nothing to run. */
  readonly concurrent?: readonly string[];
}

export interface ProvisionOptions {
  /**
   * Emit `DEFERRABLE INITIALLY DEFERRED` FOREIGN KEY constraints for every
   * `parent: true` belongsTo relation (true ownership edges only — see
   * {@link foreignKeyStatements}). Off by default: the soft-reference model keeps
   * out-of-order sync robust on Ablo-managed tables. Turn on for a customer's own
   * (BYO / dedicated) database, where a clean, navigable relational schema is
   * wanted and the DB starts empty (nothing for the constraint to fail against).
   */
  readonly foreignKeys?: boolean;
}

export interface MigrationPlan {
  /** The app Postgres schema the DDL targets (`app_<id>` or `public`). */
  readonly appSchema: string;
  /** Ordered DDL statements (expand → contract). Run in ONE transaction. */
  readonly statements: readonly string[];
  /** Post-commit, non-transactional DDL — see {@link ProvisionPlan.concurrent}. */
  readonly concurrent?: readonly string[];
}

// ── Identifier safety ────────────────────────────────────────────────────────

/** Postgres unquoted-identifier-safe slug: lowercase `[a-z0-9_]`, ≤50 chars. */
function slug(raw: string): string {
  const s = raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return s.slice(0, 50) || 'x';
}

/** Per-app schema name for an app (organization) id. */
export function appSchemaName(organizationId: string): string {
  return `app_${slug(organizationId)}`;
}

export function camelToSnake(identifier: string): string {
  return identifier.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}

/**
 * Pure snake_case → camelCase — the inverse of {@link camelToSnake}, matching
 * `postgres.toCamel` semantics. Read-side translation: a column read back from a
 * BYO database (e.g. via `drizzleDataSource`) maps to the same JS field the SDK
 * wrote, so `camelToSnake('operatorId') === 'operator_id'` and
 * `snakeToCamel('operator_id') === 'operatorId'` round-trip.
 */
export function snakeToCamel(identifier: string): string {
  return identifier.replace(/_+([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
}

/** Quote an identifier (defense-in-depth; inputs are already slug/snake). */
export function q(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

// ── Field type mapping ───────────────────────────────────────────────────────

export function sqlType(fieldType: ModelJSON['fields'][string]['type']): string {
  switch (fieldType) {
    case 'string':
    case 'enum':
      return 'TEXT';
    case 'number':
      // DOUBLE PRECISION, not INTEGER — a Zod `number` may be fractional and
      // truncating to INTEGER is silent data loss.
      return 'DOUBLE PRECISION';
    case 'boolean':
      return 'BOOLEAN';
    case 'date':
      return 'TIMESTAMPTZ';
    case 'json':
    default:
      return 'JSONB';
  }
}

const BASE_COLUMNS = new Set(['id', 'organization_id', 'created_by', 'created_at', 'updated_at']);

// ── JSON column drift reconciliation ─────────────────────────────────────────

/**
 * Detect and repair `field.json()` columns that exist in the live database as a
 * NON-jsonb type, and emit a salvaging in-place `ALTER … TYPE jsonb`.
 *
 * Why this is needed: provisioning uses `ADD COLUMN IF NOT EXISTS` and
 * `CREATE TABLE IF NOT EXISTS` (idempotent by design). When `ablo push` adopts
 * a table/column that PRE-EXISTS with a different type — e.g. a `content TEXT`
 * column from a legacy table — the additive DDL is a no-op and the column
 * silently stays `text`. The pure schema-to-schema differ
 * ({@link generateMigrationPlan}) can't see this: the schema says `json` on
 * both sides, so it emits no change. The drift is only visible by INTROSPECTING
 * the live database and comparing to the declared type — the drizzle-kit
 * `pull` discipline. A `json` value bound to a `text` column corrupts to the
 * literal `"[object Object]"`, so leaving the drift unrepaired is silent data
 * loss.
 *
 * The cast is SALVAGING, never aborting (Postgres won't auto-cast text→jsonb;
 * invalid rows would otherwise fail the whole ALTER): a row that `IS JSON`
 * parses to jsonb, anything else (including already-corrupted
 * `"[object Object]"`) is wrapped as a jsonb string via `to_jsonb`, and NULL
 * stays NULL. The `IS JSON` predicate requires Postgres 16+ (the fleet runs
 * 17); on an older engine the ALTER fails LOUD with a structured
 * `migration_failed` rather than silently — acceptable, since silent corruption
 * is the thing we're eliminating. See
 * https://echobind.com/post/safely-alter-postgres-columns-with-using.
 *
 * Pure + idempotent: emits a statement ONLY for a json field whose live column
 * type is present and not already `jsonb`/`json`. A correctly-provisioned schema
 * yields zero statements, so this is a no-op on every push after the first
 * repair. Columns absent from `liveColumnTypes` are left to the additive
 * provisioner (which adds them as jsonb).
 *
 * @param liveColumnTypes table name → (column name → information_schema
 *   `data_type`), as introspected from the target schema.
 */
export function generateJsonColumnReconciliation(
  schema: SchemaJSON,
  liveColumnTypes: ReadonlyMap<string, ReadonlyMap<string, string>>,
  targetSchema: string,
): string[] {
  const qs = q(targetSchema);
  const statements: string[] = [];
  for (const [key, model] of Object.entries(schema.models)) {
    const table = model.tableName ?? key;
    const liveCols = liveColumnTypes.get(table);
    if (!liveCols) continue; // table not provisioned yet — nothing to reconcile
    const qt = `${qs}.${q(table)}`;
    for (const [fieldName, meta] of Object.entries(model.fields)) {
      if (meta.type !== 'json') continue;
      const col = meta.column ?? camelToSnake(fieldName);
      const liveType = liveCols.get(col);
      if (liveType === undefined) continue; // column absent — provisioner adds jsonb
      if (liveType === 'jsonb' || liveType === 'json') continue; // already correct
      const c = q(col);
      statements.push(
        `ALTER TABLE ${qt} ALTER COLUMN ${c} TYPE jsonb USING (\n` +
          `  CASE\n` +
          `    WHEN ${c} IS NULL THEN NULL\n` +
          `    WHEN ${c}::text IS JSON THEN ${c}::text::jsonb\n` +
          `    ELSE to_jsonb(${c}::text)\n` +
          `  END\n` +
          `);`,
      );
    }
  }
  return statements;
}

// ── Foreign keys (relation-driven, sync-safe) ────────────────────────────────

/**
 * A Postgres-identifier-safe constraint name ≤63 bytes. When the natural
 * `<table>_<col>_<suffix>` exceeds the limit, fall back to a deterministic
 * hashed form so the name stays stable AND matches what Postgres actually stores
 * — a silently-truncated name would never match the DO-block existence guard,
 * breaking idempotency (re-adds every push) and risking prefix collisions.
 */
function constraintName(table: string, col: string, suffix: string): string {
  const full = `${table}_${col}_${suffix}`;
  if (full.length <= 63) return full;
  let h = 5381;
  for (let i = 0; i < full.length; i++) h = ((h * 33) + full.charCodeAt(i)) >>> 0;
  const hash = h.toString(36);
  const prefix = full.slice(0, Math.max(1, 63 - suffix.length - hash.length - 2));
  return `${prefix}_${hash}_${suffix}`;
}

interface ForeignKeyDdl {
  /** Run inside the provisioning transaction — instant `ADD ... NOT VALID` (no
   *  child-table scan, only a brief lock), plus the authoritative drop/recreate
   *  guard. */
  readonly statements: string[];
  /** Run AFTER commit, each outside any transaction, best-effort: `VALIDATE
   *  CONSTRAINT` + `CREATE INDEX CONCURRENTLY` — validates existing rows and
   *  builds the child index WITHOUT blocking writes on a large, live table. */
  readonly concurrent: string[];
}

/**
 * Foreign-key constraints for a model's belongsTo relations marked `{ fk: true }`.
 *
 * Emission is driven by an explicit `fk` marker, DECOUPLED from `parent`
 * (`parent` = sync-group fan-out / visibility, control plane; `fk` = physical
 * referential integrity, data plane — orthogonal axes, per Drizzle's
 * relations()-vs-references() split and the Zanzibar "parent is permission-only"
 * rule). A relation sets `fk` only when its target is co-located in the same DB
 * AND written in the same commit, and is a strong / contained entity. Soft
 * references (provenance / template pointers, e.g. `sourceSlideId`, `templateId`)
 * stay plain columns — a hard FK there would reject a write pointing cross-scope
 * or at an absent row and break sync.
 *
 * LIVE / POPULATED tables: a plain ADD CONSTRAINT takes SHARE ROW EXCLUSIVE on
 * both tables and scans the whole child table — freezing writes on a customer's
 * production DB. So the constraint is added `NOT VALID` (instant, no scan, brief
 * lock) INSIDE the transaction, and the existing-row check (`VALIDATE
 * CONSTRAINT`, SHARE UPDATE EXCLUSIVE — allows writes) plus the child index
 * (`CREATE INDEX CONCURRENTLY`) are returned SEPARATELY in {@link
 * ForeignKeyDdl.concurrent}, run after commit, outside any transaction, and are
 * best-effort: if existing data violates a freshly-added FK the VALIDATE is
 * skipped (logged, never fatal), the constraint still enforces all new writes,
 * and nothing is destroyed.
 *
 * The key is a pure `DEFERRABLE INITIALLY DEFERRED` **integrity guard** with
 * `ON DELETE NO ACTION`: it NEVER mutates a child row itself. (SET NULL / CASCADE
 * would change data server-side with NO sync_delta — invisible to other clients
 * until re-bootstrap — and would override the app-layer ModelRegistry onDelete
 * contract.) The app layer owns deletes + nullification and emits the deltas; the
 * deferred check just verifies — at COMMIT, so same-batch child-before-parent and
 * the app's own cascade both pass — that integrity holds, failing loudly only if
 * the app left a dangling reference.
 *
 * Authoritative + idempotent: a same-named constraint that isn't deferrable or
 * carries the wrong delete action (a hand-added or legacy FK) is dropped and
 * recreated; an already-correct one is left untouched (no re-validation cost).
 * Emitted in a final pass, after every referenced table exists.
 *
 * The FK column is resolved the SAME way the table loop names columns
 * (`fieldMeta.column ?? camelToSnake(field)`), not from `rel.foreignKeyColumn` —
 * the table loop ignores relation casing, so trusting `foreignKeyColumn` would
 * mismatch the real column whenever `casing` is unset.
 */
function foreignKeyStatements(
  table: string,
  model: ModelJSON,
  models: SchemaJSON['models'],
  qs: string,
): ForeignKeyDdl {
  const qt = `${qs}.${q(table)}`;
  // The model's provisioned column set — guard so a relation whose FK field
  // isn't actually declared (no column) never produces a broken ALTER.
  const orgCol = tenancyColumn(resolveTenancy(model));
  const columns = new Set<string>(['id', 'created_by', 'created_at', 'updated_at']);
  if (orgCol) columns.add(orgCol);
  for (const [fieldName, meta] of Object.entries(model.fields)) {
    columns.add(meta.column ?? camelToSnake(fieldName));
  }

  const statements: string[] = [];
  const concurrent: string[] = [];
  for (const rel of Object.values(model.relations)) {
    if (rel.type !== 'belongsTo') continue; // only relations whose FK column lives on THIS table
    if (rel.options?.fk !== true) continue; // explicit `fk` marker — decoupled from `parent` (visibility)
    const targetModel = models[rel.target];
    if (!targetModel) continue; // target not provisioned into this DB → can't reference it
    if ((targetModel.plane ?? 'tenant') === 'control') continue; // control-plane table absent in a tenant DB
    const col = model.fields[rel.foreignKey]?.column ?? camelToSnake(rel.foreignKey);
    if (!columns.has(col)) continue; // FK field isn't a provisioned column
    const targetTable = targetModel.tableName ?? rel.target;
    const cname = constraintName(table, col, 'fkey');
    const lit = cname.replace(/'/g, "''");
    const iname = constraintName(table, col, 'idx');
    const targetQt = `${qs}.${q(targetTable)}`;
    // In-tx: authoritative create as NOT VALID — instant, no child-table scan,
    // only a brief lock. confdeltype 'a' = NO ACTION; recreate only when absent /
    // not deferrable / wrong delete action, so a correct constraint is untouched.
    statements.push(
      `DO $$ BEGIN\n` +
        `  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${lit}' AND (NOT condeferrable OR confdeltype <> 'a')) THEN\n` +
        `    ALTER TABLE ${qt} DROP CONSTRAINT ${q(cname)};\n` +
        `  END IF;\n` +
        `  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${lit}') THEN\n` +
        `    ALTER TABLE ${qt} ADD CONSTRAINT ${q(cname)} FOREIGN KEY (${q(col)}) ` +
        `REFERENCES ${targetQt} (${q('id')}) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED NOT VALID;\n` +
        `  END IF;\nEND $$;`,
    );
    // Post-commit, non-blocking: validate existing rows (SHARE UPDATE EXCLUSIVE,
    // allows concurrent writes) then index the child column (Postgres does NOT
    // auto-index the referencing column → parent deletes would seq-scan it).
    concurrent.push(`ALTER TABLE ${qt} VALIDATE CONSTRAINT ${q(cname)};`);
    concurrent.push(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${q(iname)} ON ${qt} (${q(col)});`);
  }
  return { statements, concurrent };
}

// ── Provisioning (additive, idempotent) ─────────────────────────────────────

/**
 * Build the additive, idempotent provisioning plan for an app. Pure — no DB
 * access.
 *
 * `targetSchema` is where the tables live: the app's schema `app_<id>` on the
 * shared tier, or `public` on a dedicated tenant's own database (where the DB
 * itself is the isolation boundary). For `public` the `CREATE SCHEMA` is
 * skipped (it always exists).
 */
export function generateProvisionPlan(
  schema: SchemaJSON,
  targetSchema: string,
  opts: ProvisionOptions = {},
): ProvisionPlan {
  const appSchema = targetSchema;
  const qs = q(appSchema);
  const statements: string[] = appSchema === 'public' ? [] : [`CREATE SCHEMA IF NOT EXISTS ${qs};`];
  const concurrent: string[] = [];

  for (const [key, model] of Object.entries(schema.models)) {
    // Control-plane models (Ablo's own sync log / attribution / audit) are never
    // emitted into a tenant database — only `tenant`-plane models are. Absent
    // plane = `tenant` (back-compat). This declared boundary is what makes "what
    // a BYO customer DB gets" derivable instead of hand-coded.
    if ((model.plane ?? 'tenant') === 'control') continue;

    // Default the physical table to the model key when `tableName` is omitted —
    // same fallback the migration path uses (`tableOfModel: m.tableName ?? key`).
    // Without this, a schema that doesn't set `tableName` (e.g. the `ablo init`
    // starter) provisions zero tables.
    const table = model.tableName ?? key;
    const qt = `${qs}.${q(table)}`;

    // Base columns are schema-driven, not blanket. `organization_id` (and its
    // index + tenant-isolation RLS below) is emitted only for org-scoped models.
    // A model that declares `orgScoped: false` (users, organizations, and other
    // tables scoped via a FK / app layer) genuinely has no `organization_id`
    // column — forcing one would add a NOT NULL column that fails on existing
    // rows and contradicts the model's own declaration.
    // Tenancy column: present only for column-scoped models, with the
    // configured name (default `organization_id`). `parent`/`none` tenancy emit
    // no tenancy column — they're scoped via a parent FK or not at all.
    const orgCol = tenancyColumn(resolveTenancy(model));
    const baseColumns = [
      `  ${q('id')} TEXT PRIMARY KEY,`,
      ...(orgCol ? [`  ${q(orgCol)} TEXT NOT NULL,`] : []),
      `  ${q('created_by')} TEXT,`,
      `  ${q('created_at')} TIMESTAMPTZ NOT NULL DEFAULT NOW(),`,
      `  ${q('updated_at')} TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    ];
    statements.push(`CREATE TABLE IF NOT EXISTS ${qt} (\n${baseColumns.join('\n')}\n);`);

    for (const [fieldName, meta] of Object.entries(model.fields)) {
      const col = meta.column ?? camelToSnake(fieldName);
      if (BASE_COLUMNS.has(col) || col === orgCol) continue;
      statements.push(`ALTER TABLE ${qt} ADD COLUMN IF NOT EXISTS ${q(col)} ${sqlType(meta.type)};`);
      if (meta.type === 'enum' && meta.enumValues && meta.enumValues.length > 0) {
        const cname = `${table}_${col}_enum`;
        const allowed = meta.enumValues.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');
        statements.push(
          `DO $$ BEGIN\n` +
            `  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${cname}') THEN\n` +
            `    ALTER TABLE ${qt} ADD CONSTRAINT ${q(cname)} CHECK (${q(col)} IN (${allowed}));\n` +
            `  END IF;\n` +
            `END $$;`,
        );
      }
    }

    // Org index + tenant-isolation RLS only where there's an `organization_id`
    // to isolate on. Non-org-scoped tables rely on FK/app-layer scoping.
    if (orgCol) {
      statements.push(
        `CREATE INDEX IF NOT EXISTS ${q(`${table}_${orgCol}_idx`)} ON ${qt} (${q(orgCol)});`,
      );
      statements.push(`ALTER TABLE ${qt} ENABLE ROW LEVEL SECURITY;`);
      statements.push(`ALTER TABLE ${qt} FORCE ROW LEVEL SECURITY;`);
      const policy = `${table}_tenant_isolation`;
      const predicate = `${q(orgCol)} = current_setting('app.current_org_id', true)`;
      statements.push(`DROP POLICY IF EXISTS ${q(policy)} ON ${qt};`);
      statements.push(`CREATE POLICY ${q(policy)} ON ${qt}\n  USING (${predicate})\n  WITH CHECK (${predicate});`);
    }
  }

  // Foreign keys (opt-in) — a final pass so every referenced table already
  // exists when its constraint is added.
  if (opts.foreignKeys) {
    for (const [key, m] of Object.entries(schema.models)) {
      if ((m.plane ?? 'tenant') === 'control') continue;
      const t = m.tableName ?? key;
      const fk = foreignKeyStatements(t, m, schema.models, qs);
      statements.push(...fk.statements);
      concurrent.push(...fk.concurrent);
    }
  }

  return { appSchema, statements, concurrent };
}

// ── Migration (destructive-aware, diff-driven) ──────────────────────────────

function enumCheckStatements(table: string, col: string, qt: string, values: readonly string[]): string[] {
  const cname = `${table}_${col}_enum`;
  const stmts = [`ALTER TABLE ${qt} DROP CONSTRAINT IF EXISTS ${q(cname)};`];
  if (values.length > 0) {
    const allowed = values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');
    stmts.push(`ALTER TABLE ${qt} ADD CONSTRAINT ${q(cname)} CHECK (${q(col)} IN (${allowed}));`);
  }
  return stmts;
}

function indexName(table: string, col: string): string {
  return `${table}_${col}_idx`;
}

function columnNameOf(fieldName: string, meta: Pick<FieldMeta, 'column'> | undefined): string {
  return meta?.column ?? camelToSnake(fieldName);
}

/**
 * Encode a constant backfill value as a typed SQL literal. Inputs are operator-
 * supplied (via the authed push), but we still encode by the field's declared
 * type and escape strings rather than interpolate raw — defense-in-depth.
 */
function sqlLiteral(value: BackfillValue['value'], fieldType: FieldType): string {
  switch (fieldType) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new AbloValidationError(`backfill for a number field must be a finite number, got ${JSON.stringify(value)}`, { code: 'schema_definition_invalid' });
      }
      return String(value);
    case 'boolean':
      return value ? 'TRUE' : 'FALSE';
    case 'date':
      return `'${String(value).replace(/'/g, "''")}'::timestamptz`;
    case 'json':
      return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
    case 'string':
    case 'enum':
    default:
      return `'${String(value).replace(/'/g, "''")}'`;
  }
}

/**
 * Lower an ordered migration step list to DDL. `next` is the schema being pushed
 * (the target column shapes are read from it), `prev` the active one (used to
 * resolve the *old* table name on a model rename).
 */
export function generateMigrationPlan(
  steps: readonly MigrationStep[],
  opts: {
    readonly prev: SchemaJSON | null;
    readonly next: SchemaJSON;
    readonly targetSchema: string;
    /** Constant seed values that let a required-field add / made-required step
     *  set NOT NULL on a non-empty table. Keyed by (model, field). */
    readonly backfills?: readonly BackfillValue[];
    /** Emit DEFERRABLE FK constraints for `parent: true` edges of newly-created
     *  models. Off by default — see {@link ProvisionOptions.foreignKeys}. */
    readonly foreignKeys?: boolean;
  },
): MigrationPlan {
  const { prev, next, targetSchema, backfills = [], foreignKeys = false } = opts;
  const qs = q(targetSchema);
  const statements: string[] = [];
  const concurrent: string[] = [];

  // The app schema must exist before any statement targets it. On a fresh
  // org's FIRST push (`prev = null`) the migration plan IS the provisioning —
  // `app_<orgId>` has never been created, and skipping this line made every
  // first push die with `3F000 invalid_schema_name` at statement 0. Idempotent
  // (`IF NOT EXISTS`), so emitting it on every later migration is free.
  if (steps.length > 0 && targetSchema !== 'public') {
    statements.push(`CREATE SCHEMA IF NOT EXISTS ${qs};`);
  }

  const qtFor = (table: string) => `${qs}.${q(table)}`;
  const tableOfModel = (schema: SchemaJSON | null, key: string): string | null => {
    const m = schema?.models[key];
    if (!m) return null;
    return m.tableName ?? key;
  };
  const backfillFor = (model: string, field: string): BackfillValue | undefined =>
    backfills.find((b) => b.model === model && b.field === field);

  for (const step of steps) {
    switch (step.kind) {
      case 'create_model': {
        // Reuse the provisioner for the full table (base cols + fields + enum
        // checks + RLS), minus its `CREATE SCHEMA` (the plan header above
        // already emitted it once — don't repeat it per model).
        const def = next.models[step.model];
        if (!def) break;
        const sub: SchemaJSON = { v: next.v, models: { [step.model]: def }, identityRoles: next.identityRoles };
        for (const s of generateProvisionPlan(sub, targetSchema).statements) {
          if (!s.startsWith('CREATE SCHEMA')) statements.push(s);
        }
        break;
      }

      case 'drop_model':
        statements.push(`DROP TABLE IF EXISTS ${qtFor(step.tableName)};`);
        break;

      case 'rename_model': {
        const fromTable = tableOfModel(prev, step.from);
        const toTable = tableOfModel(next, step.to);
        // A logical model rename only needs SQL when the physical table name
        // actually changes; if tableName is unchanged the rename is metadata.
        if (fromTable && toTable && fromTable !== toTable) {
          statements.push(`ALTER TABLE ${qtFor(fromTable)} RENAME TO ${q(toTable)};`);
        }
        break;
      }

      case 'add_field': {
        const table = tableOfModel(next, step.model);
        if (!table) break;
        const qt = qtFor(table);
        const col = columnNameOf(step.field, step.meta);
        // Added nullable first (the column is born NULL on every existing row).
        statements.push(`ALTER TABLE ${qt} ADD COLUMN IF NOT EXISTS ${q(col)} ${sqlType(step.meta.type)};`);
        if (step.meta.type === 'enum' && step.meta.enumValues?.length) {
          statements.push(...enumCheckStatements(table, col, qt, step.meta.enumValues));
        }
        // Backfill + enforce NOT NULL only with a supplied seed value. Without
        // one, a required field stays nullable (gated `unexecutable` upstream).
        const addBf = backfillFor(step.model, step.field);
        if (addBf !== undefined) {
          statements.push(`UPDATE ${qt} SET ${q(col)} = ${sqlLiteral(addBf.value, step.meta.type)} WHERE ${q(col)} IS NULL;`);
          if (!step.meta.isOptional) {
            statements.push(`ALTER TABLE ${qt} ALTER COLUMN ${q(col)} SET NOT NULL;`);
          }
        }
        if (step.meta.isIndexed) {
          statements.push(`CREATE INDEX IF NOT EXISTS ${q(indexName(table, col))} ON ${qt} (${q(col)});`);
        }
        break;
      }

      case 'drop_field': {
        const table = tableOfModel(next, step.model);
        if (!table) break;
        const prevMeta = prev?.models[step.model]?.fields[step.field];
        statements.push(`ALTER TABLE ${qtFor(table)} DROP COLUMN IF EXISTS ${q(columnNameOf(step.field, prevMeta))};`);
        break;
      }

      case 'rename_field': {
        const table = tableOfModel(next, step.model);
        if (!table) break;
        const prevMeta = prev?.models[step.model]?.fields[step.from];
        const nextMeta = next.models[step.model]?.fields[step.to];
        const fromCol = columnNameOf(step.from, prevMeta);
        const toCol = columnNameOf(step.to, nextMeta);
        if (fromCol === toCol) break;
        statements.push(`ALTER TABLE ${qtFor(table)} RENAME COLUMN ${q(fromCol)} TO ${q(toCol)};`);
        break;
      }

      case 'alter_field': {
        const table = tableOfModel(next, step.model);
        if (!table) break;
        const qt = qtFor(table);
        const nextMeta = next.models[step.model]?.fields[step.field];
        let col = columnNameOf(step.field, nextMeta);
        const ch = step.changes;

        // 0. Physical column rename. Subsequent alterations must address
        // the new name.
        if (ch.column) {
          statements.push(`ALTER TABLE ${qt} RENAME COLUMN ${q(ch.column.from)} TO ${q(ch.column.to)};`);
          col = ch.column.to;
        }

        // 1. Type — in-place cast or lossy drop-and-recreate.
        if (ch.type) {
          const target = sqlType(ch.type.to);
          if (ch.type.cast === 'notCastable') {
            statements.push(`ALTER TABLE ${qt} DROP COLUMN IF EXISTS ${q(col)};`);
            statements.push(`ALTER TABLE ${qt} ADD COLUMN IF NOT EXISTS ${q(col)} ${target};`);
          } else {
            statements.push(`ALTER TABLE ${qt} ALTER COLUMN ${q(col)} TYPE ${target} USING ${q(col)}::${target};`);
          }
        }

        // 2. Enum CHECK — drop when leaving enum; (re)build when arriving at or
        //    re-valuing an enum. Reads the full target value set from `next`.
        if (ch.type?.from === 'enum' && nextMeta?.type !== 'enum') {
          statements.push(`ALTER TABLE ${qt} DROP CONSTRAINT IF EXISTS ${q(`${table}_${col}_enum`)};`);
        } else if (nextMeta?.type === 'enum' && (ch.enumValues || ch.type)) {
          statements.push(...enumCheckStatements(table, col, qt, nextMeta.enumValues ?? []));
        }

        // 3. Nullability. DROP NOT NULL is always safe. SET NOT NULL is gated
        //    upstream (unexecutable on a table with NULLs); a supplied backfill
        //    seeds the existing NULLs first so the constraint can take.
        if (ch.nullability) {
          if (ch.nullability.toOptional) {
            statements.push(`ALTER TABLE ${qt} ALTER COLUMN ${q(col)} DROP NOT NULL;`);
          } else {
            const bf = backfillFor(step.model, step.field);
            if (bf !== undefined && nextMeta) {
              statements.push(`UPDATE ${qt} SET ${q(col)} = ${sqlLiteral(bf.value, nextMeta.type)} WHERE ${q(col)} IS NULL;`);
            }
            statements.push(`ALTER TABLE ${qt} ALTER COLUMN ${q(col)} SET NOT NULL;`);
          }
        }

        // 4. Index.
        if (ch.indexed) {
          statements.push(
            ch.indexed.to
              ? `CREATE INDEX IF NOT EXISTS ${q(indexName(table, col))} ON ${qt} (${q(col)});`
              : `DROP INDEX IF EXISTS ${qs}.${q(indexName(table, col))};`,
          );
        }
        break;
      }
    }
  }

  // Foreign keys (opt-in). Reconcile against the FULL `next` schema, not just
  // create_model steps: a parent edge ADDED to an existing model surfaces only as
  // an add_field (relation changes aren't diffed), so a create_model-only pass
  // would never materialize its FK. The DO-block is authoritative + idempotent
  // (a no-op when the constraint is already correct), so emitting the full set
  // each push is cheap and self-healing. Appended after every table/column step.
  if (foreignKeys) {
    for (const [key, def] of Object.entries(next.models)) {
      if ((def.plane ?? 'tenant') === 'control') continue;
      const table = def.tableName ?? key;
      const fk = foreignKeyStatements(table, def, next.models, qs);
      statements.push(...fk.statements);
      concurrent.push(...fk.concurrent);
    }
  }

  return { appSchema: targetSchema, statements, concurrent };
}
