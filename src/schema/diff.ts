/**
 * Computes the migration plan that turns one schema into another. Given two
 * serialized schemas — the one currently active and the one being pushed — it
 * produces an ordered list of {@link MigrationStep}s describing how to evolve the
 * database, and a {@link MigrationClassification} that separates the risky parts
 * into warnings (they run, but may lose or risk data on a non-empty table) and
 * unexecutable steps (they fail on a non-empty table unless a backfill or default
 * is supplied). This module only plans: it has no database dependency and emits no
 * SQL, so it can be unit-tested exhaustively and reused by the command-line tools.
 * Turning a step into SQL and running it happens in the host implementation, which
 * owns the column-type mapping and row-security rules.
 *
 * A few design choices worth knowing about:
 *  - Renames are supplied as data through {@link RenameHints}, not guessed. Without
 *    a hint, a removed field plus an added field reads as a drop followed by an add,
 *    which is the safe (lossy) default; a hint tells the planner they are the same
 *    field under a new name.
 *  - Destructive changes fall into two tiers — warnings versus unexecutable — and a
 *    type change carries its own sub-tier ({@link CastSafety}: safe, risky, or not
 *    castable) that decides between an in-place `ALTER COLUMN … TYPE` and a lossy
 *    drop-and-recreate.
 *  - A single {@link FieldChanges} value records which facets of a column changed
 *    (type, nullability, enum values, index) so one `alter_field` step covers them
 *    all instead of several separate steps.
 *
 * Steps come back in expand-then-contract order — add before drop, widen before
 * narrow: create models, rename, add columns (always nullable), alter, drop columns,
 * drop models. A newly added column is never created `NOT NULL`; making a column
 * required is a separate nullability change that a backfill must run before.
 */

import type { FieldMeta } from './field.js';
import type { SchemaJSON, ModelJSON } from './serialize.js';

export type FieldType = FieldMeta['type'];

/** Whether a Postgres `ALTER COLUMN … TYPE` can preserve the existing data. */
export type CastSafety = 'safe' | 'risky' | 'notCastable';

/** Records a column's type change and how safely Postgres can carry it out. */
export interface FieldTypeChange {
  readonly from: FieldType;
  readonly to: FieldType;
  /** How the type change is carried out: `safe` runs a plain `ALTER COLUMN … TYPE`;
   *  `risky` runs one with a `USING` cast that may fail on some rows; `notCastable`
   *  drops and recreates the column, losing its data. */
  readonly cast: CastSafety;
}

/** Records a change to whether a field is optional. Going from optional to required
 *  (`true → false`) is the dangerous direction: it fails if any existing row holds
 *  a null. */
export interface NullabilityChange {
  readonly fromOptional: boolean;
  readonly toOptional: boolean;
}

/** Records which allowed values an enum field gained and lost. Removing a value is
 *  the risky part — existing rows still holding it violate the new constraint. */
export interface EnumValuesChange {
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

/** Records a change to whether a field is indexed (`from` was, `to` will be). */
export interface IndexChange {
  readonly from: boolean;
  readonly to: boolean;
}

/** Records a change to the physical database column name backing a field whose
 *  logical name stayed the same. */
export interface FieldColumnChange {
  readonly from: string;
  readonly to: string;
}

/** The set of facets of a single column that changed. Each optional member is
 *  present only when that facet actually changed, so one `alter_field` step can
 *  describe several simultaneous changes to the same column. */
export interface FieldChanges {
  readonly column?: FieldColumnChange;
  readonly type?: FieldTypeChange;
  readonly nullability?: NullabilityChange;
  readonly enumValues?: EnumValuesChange;
  readonly indexed?: IndexChange;
}

/** One step in a migration plan. The `kind` tag names the operation and the
 *  remaining fields carry its target and payload. {@link diffSchema} emits these in
 *  expand-then-contract order, and the host implementation lowers each to SQL. */
export type MigrationStep =
  | { readonly kind: 'create_model'; readonly model: string; readonly tableName: string }
  | { readonly kind: 'drop_model'; readonly model: string; readonly tableName: string }
  | { readonly kind: 'rename_model'; readonly from: string; readonly to: string }
  | { readonly kind: 'add_field'; readonly model: string; readonly field: string; readonly meta: FieldMeta }
  | { readonly kind: 'drop_field'; readonly model: string; readonly field: string }
  | { readonly kind: 'rename_field'; readonly model: string; readonly from: string; readonly to: string }
  | { readonly kind: 'alter_field'; readonly model: string; readonly field: string; readonly changes: FieldChanges };

/**
 * Tells {@link diffSchema} which removed-and-added pairs are really renames. Supply
 * these as data because the planner cannot safely guess: without a hint, a field
 * that disappears and a field that appears read as a drop followed by an add, which
 * loses the column's data. Each field rename names its model by the model's key in
 * the new schema, after any model rename has been applied.
 */
export interface RenameHints {
  readonly models?: readonly { readonly from: string; readonly to: string }[];
  readonly fields?: readonly { readonly model: string; readonly from: string; readonly to: string }[];
}

// ── Cast safety matrix ────────────────────────────────────────────────────────
// Keyed `${from}->${to}` over the 6 sync field types. Targets that map to TEXT
// (`string`) accept any scalar losslessly; tightening into an `enum` adds a CHECK
// that existing rows may violate (risky); narrowing into number/bool/date/json
// is risky (USING cast can fail per-row) or impossible (notCastable).
const CAST: Readonly<Record<string, CastSafety>> = {
  // → string (TEXT): always safe
  'number->string': 'safe', 'boolean->string': 'safe', 'date->string': 'safe',
  'enum->string': 'safe', 'json->string': 'safe',
  // → enum (TEXT + CHECK): constraint over existing data is risky
  'string->enum': 'risky', 'number->enum': 'risky', 'boolean->enum': 'risky',
  'date->enum': 'risky', 'json->enum': 'notCastable',
  // → number (DOUBLE PRECISION)
  'string->number': 'risky', 'enum->number': 'risky', 'boolean->number': 'notCastable',
  'date->number': 'notCastable', 'json->number': 'notCastable',
  // → boolean
  'string->boolean': 'risky', 'enum->boolean': 'risky', 'number->boolean': 'risky',
  'date->boolean': 'notCastable', 'json->boolean': 'notCastable',
  // → date (TIMESTAMPTZ)
  'string->date': 'risky', 'enum->date': 'risky', 'number->date': 'notCastable',
  'boolean->date': 'notCastable', 'json->date': 'notCastable',
  // → json (JSONB)
  'string->json': 'risky', 'enum->json': 'risky', 'number->json': 'notCastable',
  'boolean->json': 'notCastable', 'date->json': 'notCastable',
};

/** Reports how safely a field's type can change from `from` to `to`. The same type
 *  in and out is always safe; anything else is looked up in the cast-safety matrix
 *  and defaults to `notCastable` when no entry exists. */
export function classifyCast(from: FieldType, to: FieldType): CastSafety {
  if (from === to) return 'safe';
  return CAST[`${from}->${to}`] ?? 'notCastable';
}

// ── Diff ──────────────────────────────────────────────────────────────────────

function diffEnumValues(
  from: readonly string[] | undefined,
  to: readonly string[] | undefined,
): EnumValuesChange | undefined {
  const a = new Set(from ?? []);
  const b = new Set(to ?? []);
  const added = [...b].filter((v) => !a.has(v));
  const removed = [...a].filter((v) => !b.has(v));
  if (added.length === 0 && removed.length === 0) return undefined;
  return { added, removed };
}

function camelToSnake(identifier: string): string {
  return identifier.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}

function columnNameOf(fieldName: string, meta: FieldMeta): string {
  return meta.column ?? camelToSnake(fieldName);
}

function diffField(prevFieldName: string, nextFieldName: string, prev: FieldMeta, next: FieldMeta): FieldChanges | null {
  const changes: {
    column?: FieldColumnChange;
    type?: FieldTypeChange;
    nullability?: NullabilityChange;
    enumValues?: EnumValuesChange;
    indexed?: IndexChange;
  } = {};

  const prevColumn = columnNameOf(prevFieldName, prev);
  const nextColumn = columnNameOf(nextFieldName, next);
  if (prevColumn !== nextColumn) {
    changes.column = { from: prevColumn, to: nextColumn };
  }
  if (prev.type !== next.type) {
    changes.type = { from: prev.type, to: next.type, cast: classifyCast(prev.type, next.type) };
  }
  if (prev.isOptional !== next.isOptional) {
    changes.nullability = { fromOptional: prev.isOptional, toOptional: next.isOptional };
  }
  // Enum value drift only matters while the field is (still) an enum; a type
  // change away from enum is already captured by `type`.
  if (prev.type === 'enum' && next.type === 'enum') {
    const ev = diffEnumValues(prev.enumValues, next.enumValues);
    if (ev) changes.enumValues = ev;
  }
  if (prev.isIndexed !== next.isIndexed) {
    changes.indexed = { from: prev.isIndexed, to: next.isIndexed };
  }

  return Object.keys(changes).length === 0 ? null : changes;
}

function tableNameOf(model: ModelJSON, key: string): string {
  return model.tableName ?? key;
}

function diffModelFields(
  model: string,
  prev: ModelJSON,
  next: ModelJSON,
  fieldRenames: readonly { from: string; to: string }[],
): MigrationStep[] {
  const steps: MigrationStep[] = [];

  const renameByNewName = new Map(fieldRenames.map((r) => [r.to, r.from]));
  const renamedFromNames = new Set(fieldRenames.map((r) => r.from));

  // Renames first (so subsequent alter steps reference the new name).
  for (const { from, to } of fieldRenames) {
    if (from in prev.fields && to in next.fields) {
      steps.push({ kind: 'rename_field', model, from, to });
    }
  }

  // Added (present in next, not in prev, and not the target of a rename).
  for (const [name, meta] of Object.entries(next.fields)) {
    if (name in prev.fields) continue;
    if (renameByNewName.has(name)) continue;
    steps.push({ kind: 'add_field', model, field: name, meta });
  }

  // Altered: every field present in both (directly or via rename).
  for (const [name, nextMeta] of Object.entries(next.fields)) {
    const prevName = renameByNewName.get(name) ?? name;
    const prevMeta = prev.fields[prevName];
    if (!prevMeta) continue;
    const changes = diffField(prevName, name, prevMeta, nextMeta);
    if (changes?.column && renameByNewName.has(name)) {
      // A hinted logical field rename already emits `rename_field`, whose
      // lowering renames the physical column when needed. Do not emit a
      // second `alter_field.column` for the same transition.
      delete (changes as { column?: FieldColumnChange }).column;
    }
    if (changes && Object.keys(changes).length > 0) {
      steps.push({ kind: 'alter_field', model, field: name, changes });
    }
  }

  // Dropped (present in prev, not in next, and not renamed away).
  for (const name of Object.keys(prev.fields)) {
    if (name in next.fields) continue;
    if (renamedFromNames.has(name)) continue;
    steps.push({ kind: 'drop_field', model, field: name });
  }

  return steps;
}

/**
 * Diff two serialized schemas into an ordered, expand→contract migration plan.
 * `prev` is the active schema (`null` for a first push → all creates). Rename
 * decisions are supplied via {@link RenameHints}; anything not hinted reads as
 * drop+add.
 */
export function diffSchema(
  prev: SchemaJSON | null,
  next: SchemaJSON,
  hints: RenameHints = {},
): MigrationStep[] {
  if (!prev) {
    // First push: every model is created, with its fields carried in the
    // create (no per-field add steps — the table is born with them).
    return Object.entries(next.models).map(([model, def]) => ({
      kind: 'create_model' as const,
      model,
      tableName: tableNameOf(def, model),
    }));
  }

  const modelRenames = hints.models ?? [];
  const renameByNewModel = new Map(modelRenames.map((r) => [r.to, r.from]));
  const renamedFromModels = new Set(modelRenames.map((r) => r.from));
  const fieldHints = hints.fields ?? [];

  const creates: MigrationStep[] = [];
  const renames: MigrationStep[] = [];
  const fieldSteps: MigrationStep[] = [];
  const drops: MigrationStep[] = [];

  // New + renamed models, and per-model field diffs.
  for (const [model, nextDef] of Object.entries(next.models)) {
    const prevModelKey = renameByNewModel.get(model) ?? model;
    const prevDef = prev.models[prevModelKey];

    if (!prevDef) {
      creates.push({ kind: 'create_model', model, tableName: tableNameOf(nextDef, model) });
      continue;
    }

    if (renameByNewModel.has(model)) {
      renames.push({ kind: 'rename_model', from: prevModelKey, to: model });
    }

    const myFieldRenames = fieldHints
      .filter((f) => f.model === model)
      .map((f) => ({ from: f.from, to: f.to }));
    fieldSteps.push(...diffModelFields(model, prevDef, nextDef, myFieldRenames));
  }

  // Dropped models (in prev, not in next, not renamed away).
  for (const [model, prevDef] of Object.entries(prev.models)) {
    if (model in next.models) continue;
    if (renamedFromModels.has(model)) continue;
    drops.push({ kind: 'drop_model', model, tableName: tableNameOf(prevDef, model) });
  }

  // Expand → contract ordering. Within fieldSteps the per-model helper already
  // emits rename → add → alter → drop_field, which preserves the same invariant.
  return [...creates, ...renames, ...fieldSteps, ...drops];
}

// ── Destructive-change classification ───────────────────────────────────────────

/**
 * Why a migration step is flagged as a warning — a change that runs but may lose or
 * risk data on a non-empty table. Each code corresponds to one destructive step
 * kind that {@link classifyMigration} recognizes.
 */
export type WarningCode =
  | 'drop_model'
  | 'drop_field'
  | 'risky_cast'
  | 'lossy_recreate'
  | 'enum_value_removed'
  /** A model stops being served to readers even though no table is dropped. This is
   *  raised when a push is accepted, not by {@link classifyMigration}, and the loss
   *  is visibility, not data — the underlying rows are left untouched. */
  | 'remove_model';

/** Why a migration step is unexecutable — it fails on a non-empty table unless a
 *  default or backfill is supplied. Both cases introduce a requirement that existing
 *  rows might not satisfy. */
export type BlockerCode = 'required_field_added' | 'made_required';

/**
 * One flagged change in a classified migration plan. {@link code} says what kind of
 * risk it is, {@link model} and the optional {@link field} say where, and
 * {@link detail} is a human-readable explanation suitable for showing to a
 * developer.
 */
export interface MigrationSignal {
  readonly code: WarningCode | BlockerCode;
  readonly model: string;
  readonly field?: string;
  readonly detail: string;
  /**
   * Extra context for a removal signal: the previously active schema this push was
   * compared against. Tools use it to show which baseline made the push look
   * incompatible — its version and when it was pushed — so the warning is not a
   * mystery.
   */
  readonly shadowed?: {
    readonly environment: string;
    readonly version: number;
    /** ISO 8601 timestamp when the compared-against schema was pushed, or null. */
    readonly pushedAt: string | null;
    /** Who pushed the compared-against schema, or null. */
    readonly pushedBy: string | null;
  };
}

/** The result of classifying a migration plan: its flagged changes split by
 *  severity. Produced by {@link classifyMigration} and read by
 *  {@link isAutoApplicable} and {@link unresolvedBlockers}. */
export interface MigrationClassification {
  /** Changes that run but may lose or risk data on a non-empty table. */
  readonly warnings: readonly MigrationSignal[];
  /** Changes that fail on a non-empty table unless a default or backfill is supplied. */
  readonly unexecutable: readonly MigrationSignal[];
}

/**
 * Sorts a plan's steps into {@link MigrationClassification.warnings} and
 * {@link MigrationClassification.unexecutable}. Because a step carries no per-field
 * default, adding a required field is treated conservatively as unexecutable — the
 * classifier cannot prove a default exists, so a backfill or default must resolve
 * it. The classification is derived from the schema alone; whoever runs the plan can
 * still downgrade a flagged step to a no-op once it finds the target table is empty.
 */
export function classifyMigration(steps: readonly MigrationStep[]): MigrationClassification {
  const warnings: MigrationSignal[] = [];
  const unexecutable: MigrationSignal[] = [];

  for (const step of steps) {
    switch (step.kind) {
      case 'drop_model':
        warnings.push({ code: 'drop_model', model: step.model, detail: `drops table for "${step.model}" (data loss)` });
        break;
      case 'drop_field':
        warnings.push({ code: 'drop_field', model: step.model, field: step.field, detail: `drops column "${step.field}" (data loss)` });
        break;
      case 'add_field':
        if (!step.meta.isOptional) {
          unexecutable.push({
            code: 'required_field_added',
            model: step.model,
            field: step.field,
            detail: `adds required column "${step.field}" — needs a default or backfill on a non-empty table`,
          });
        }
        break;
      case 'alter_field': {
        const { changes } = step;
        if (changes.nullability && changes.nullability.fromOptional && !changes.nullability.toOptional) {
          unexecutable.push({
            code: 'made_required',
            model: step.model,
            field: step.field,
            detail: `makes "${step.field}" required — fails if existing rows are NULL`,
          });
        }
        if (changes.type) {
          if (changes.type.cast === 'risky') {
            warnings.push({ code: 'risky_cast', model: step.model, field: step.field, detail: `${changes.type.from} → ${changes.type.to} may fail per-row` });
          } else if (changes.type.cast === 'notCastable') {
            warnings.push({ code: 'lossy_recreate', model: step.model, field: step.field, detail: `${changes.type.from} → ${changes.type.to} requires drop-and-recreate (data loss)` });
          }
        }
        if (changes.enumValues && changes.enumValues.removed.length > 0) {
          warnings.push({
            code: 'enum_value_removed',
            model: step.model,
            field: step.field,
            detail: `removes enum value(s) ${changes.enumValues.removed.join(', ')} — rows using them violate the new CHECK`,
          });
        }
        break;
      }
      // create_model, rename_model, rename_field, add optional field: non-destructive.
      default:
        break;
    }
  }

  return { warnings, unexecutable };
}

/** Whether a plan is safe to apply automatically — true when it has no unexecutable
 *  steps. Warnings do not block auto-apply; only unexecutable steps do. */
export function isAutoApplicable(classification: MigrationClassification): boolean {
  return classification.unexecutable.length === 0;
}

// ── Backfill ────────────────────────────────────────────────────────────────

/**
 * A constant value to write into existing rows so an otherwise-unexecutable step can
 * run: a required field added to a non-empty table, or a field made required while
 * some rows hold null. This is intentionally a single constant, not an SQL
 * expression — it covers the common "new column defaults to X" case; anything more
 * elaborate is out of scope.
 */
export interface BackfillValue {
  readonly model: string;
  readonly field: string;
  readonly value: string | number | boolean;
}

/**
 * Reports whether a supplied backfill resolves this blocker. Only the two
 * row-dependent blockers — `required_field_added` and `made_required` — can be
 * resolved with a backfill; a data-loss warning cannot, and must be accepted
 * explicitly instead.
 */
export function isBlockerResolved(
  signal: MigrationSignal,
  backfills: readonly BackfillValue[],
): boolean {
  if (signal.code !== 'required_field_added' && signal.code !== 'made_required') return false;
  return backfills.some((b) => b.model === signal.model && b.field === signal.field);
}

/** The unexecutable signals that the supplied backfills do not cover. An empty
 *  result means no blocker remains, though any warnings are still gated separately. */
export function unresolvedBlockers(
  classification: MigrationClassification,
  backfills: readonly BackfillValue[],
): readonly MigrationSignal[] {
  return classification.unexecutable.filter((s) => !isBlockerResolved(s, backfills));
}
