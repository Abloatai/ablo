/**
 * Turns a schema definition into the ordered Postgres DDL that provisions and
 * migrates its tables. A schema built with `defineSchema(...)` and serialized to
 * {@link SchemaJSON} is the single source of truth, and this module lowers it to
 * ordered SQL strings.
 *
 * The same generators run wherever tables are created — in a hosted server
 * applying them to the Postgres it manages, and in the `ablo migrate` CLI
 * applying them to a customer's own Postgres — so the SQL, from column types to
 * row-level security to enum checks, is identical no matter who runs it.
 *
 * Everything here is pure: it returns strings and touches no database. The
 * execution side — the transaction and advisory lock that actually run the
 * statements — lives with each caller, because it is coupled to that caller's
 * Postgres client and error types.
 *
 *  - {@link generateProvisionPlan} builds an additive, idempotent plan (CREATE
 *    and ADD … IF NOT EXISTS, plus row-level security) that never loses data —
 *    the "create my tables" primitive.
 *  - {@link generateMigrationPlan} is its destructive-aware counterpart, driven
 *    by a {@link diffSchema} step list: drops, renames, type casts, and
 *    backfills.
 */

import { AbloValidationError } from '../transaction/errors.js';
import type { SchemaJSON, ModelJSON } from './serialize.js';
import type { MigrationStep, BackfillValue, FieldType } from './diff.js';
import type { FieldMeta } from '../transaction/schema/field.js';
import { resolveTenancy, tenancyColumn } from '../transaction/schema/tenancy.js';

export interface ProvisionPlan {
  /** The Postgres schema the tables live in (`app_<id>` or `public`). */
  readonly appSchema: string;
  /** Ordered, idempotent DDL statements. Safe to run repeatedly. Executors run
   *  these together in one transaction. */
  readonly statements: readonly string[];
  /** Post-commit, non-transactional DDL (`VALIDATE CONSTRAINT`, `CREATE INDEX
   *  CONCURRENTLY`) — run after {@link statements} commit, each outside any
   *  transaction, best-effort. Keeps the lock-heavy and scan-heavy work off the
   *  main transaction so adding a foreign key never freezes a large, live table.
   *  Optional: when absent, there is nothing to run. */
  readonly concurrent?: readonly string[];
}

export interface ProvisionOptions {
  /**
   * Emit `DEFERRABLE INITIALLY DEFERRED` foreign-key constraints for the
   * belongsTo relations that opt in; see {@link foreignKeyStatements} for exactly
   * which relations qualify. Off by default, so soft references keep out-of-order
   * sync robust. Turn it on for a customer's own database, where a clean,
   * navigable relational schema is wanted and the database starts empty, so a
   * constraint has nothing to fail against.
   */
  readonly foreignKeys?: boolean;
}

export interface MigrationPlan {
  /** The app Postgres schema the DDL targets (`app_<id>` or `public`). */
  readonly appSchema: string;
  /** Ordered DDL statements (expand → contract). Run in one transaction. */
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
 * Converts snake_case to camelCase — the inverse of {@link camelToSnake}. This
 * is the read-side translation: a column read back from a customer's own
 * database maps to the same JavaScript field the SDK wrote, so
 * `camelToSnake('operatorId') === 'operator_id'` and
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

// ── Foreign keys (relation-driven, sync-safe) ────────────────────────────────

/**
 * A Postgres-identifier-safe constraint name ≤63 bytes. When the natural
 * `<table>_<col>_<suffix>` exceeds the limit, fall back to a deterministic
 * hashed form so the name stays stable and matches what Postgres actually stores
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
  /** Run after commit, each outside any transaction, best-effort: `VALIDATE
   *  CONSTRAINT` + `CREATE INDEX CONCURRENTLY` — validates existing rows and
   *  builds the child index without blocking writes on a large, live table. */
  readonly concurrent: string[];
}

/**
 * Builds the foreign-key constraints for a model's belongsTo relations that opt
 * in by setting `{ fk: true }`.
 *
 * The `fk` marker is deliberately separate from `parent`: `parent` controls
 * sync-group fan-out and visibility, while `fk` requests physical referential
 * integrity in the database. A relation sets `fk` only when its target lives in
 * the same database, is written in the same commit, and is a strong, contained
 * entity. Soft references — provenance or template pointers such as
 * `sourceSlideId` or `templateId` — stay plain columns; a hard foreign key there
 * would reject a write that points across scopes or at an absent row and break
 * sync.
 *
 * On a live, populated table a plain `ADD CONSTRAINT` takes a heavy lock and
 * scans the whole child table, which would freeze writes on a customer's
 * production database. To avoid that, the constraint is added `NOT VALID`
 * (instant, no scan, brief lock) inside the transaction, and the existing-row
 * check (`VALIDATE CONSTRAINT`, which allows concurrent writes) plus the child
 * index (`CREATE INDEX CONCURRENTLY`) are returned separately in {@link
 * ForeignKeyDdl.concurrent}, to run after commit, outside any transaction, and
 * best-effort: if existing data violates a freshly added constraint the
 * validation is skipped (logged, never fatal), the constraint still enforces
 * every new write, and nothing is destroyed.
 *
 * The constraint is a `DEFERRABLE INITIALLY DEFERRED` integrity guard with `ON
 * DELETE NO ACTION`; it never mutates a child row itself. A `SET NULL` or
 * `CASCADE` action would change data in the database with no matching
 * sync_delta — invisible to other clients until they re-bootstrap — and would
 * override the application layer's own onDelete handling. The application layer
 * owns deletes and nullification and emits the deltas; the deferred check only
 * verifies, at commit time (so a same-batch child-before-parent write and the
 * application's own cascade both pass), that integrity holds, failing loudly
 * only when a dangling reference is left behind.
 *
 * Emission is idempotent and authoritative: a same-named constraint that is not
 * deferrable or carries the wrong delete action (a hand-added or older foreign
 * key) is dropped and recreated, while an already-correct one is left untouched
 * with no revalidation cost. It runs in a final pass, after every referenced
 * table exists.
 *
 * The foreign-key column is resolved the same way the table loop names columns
 * (`fieldMeta.column ?? camelToSnake(field)`), not from `rel.foreignKeyColumn`:
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
    if (rel.type !== 'belongsTo') continue; // only relations whose FK column lives on this table
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
    // allows concurrent writes) then index the child column (Postgres does not
    // auto-index the referencing column → parent deletes would seq-scan it).
    concurrent.push(`ALTER TABLE ${qt} VALIDATE CONSTRAINT ${q(cname)};`);
    concurrent.push(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${q(iname)} ON ${qt} (${q(col)});`);
  }
  return { statements, concurrent };
}

// ── Provisioning (additive, idempotent) ─────────────────────────────────────

/**
 * Builds the additive, idempotent provisioning plan for an app. Pure — it does
 * not touch a database.
 *
 * `targetSchema` is where the tables live: a per-app Postgres schema such as
 * `app_<id>`, or `public` when the database itself is the isolation boundary
 * (for example a customer's own database). For `public` the `CREATE SCHEMA`
 * statement is skipped, since it always exists.
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
    // Control-plane models (the engine's own sync log, attribution, and audit
    // tables) are never emitted into a tenant database — only `tenant`-plane
    // models are. A model with no declared plane defaults to `tenant`. This
    // declared boundary is what makes the set of tables a customer's own
    // database receives derivable instead of hand-coded.
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
    /** Emit deferrable foreign-key constraints for the relations that opt in.
     *  Off by default — see {@link ProvisionOptions.foreignKeys}. */
    readonly foreignKeys?: boolean;
  },
): MigrationPlan {
  const { prev, next, targetSchema, backfills = [], foreignKeys = false } = opts;
  const qs = q(targetSchema);
  const statements: string[] = [];
  const concurrent: string[] = [];

  // The app schema must exist before any statement targets it. On a fresh
  // org's first push (`prev = null`) the migration plan is the provisioning —
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

  // Foreign keys (opt-in). Reconcile against the full `next` schema, not just
  // create_model steps: a parent edge added to an existing model surfaces only as
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
