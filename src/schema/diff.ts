/**
 * Schema diff + migration planning — the pure core of the managed-migration loop.
 *
 * Given two serialized schemas (the active one and the one being pushed), produce
 * an ordered list of {@link MigrationStep}s describing how to evolve the database,
 * and a {@link MigrationClassification} splitting the risky parts into *warnings*
 * (execute but may lose/risk data) and *unexecutable* steps (fail on a non-empty
 * table without a backfill/default). SQL emission and execution live elsewhere
 * (server-side, where the type map + RLS live); this module is intentionally pure
 * and DB-free so it is exhaustively unit-testable and reusable by the CLI.
 *
 * Design borrowed from mature tools:
 *  - **Drizzle Kit**: keep the differ pure and inject RENAME decisions as data
 *    (the {@link RenameHints} resolver seam) rather than guessing — the same
 *    engine is then headless-testable and drivable by an interactive prompt.
 *  - **Prisma migration engine**: a two-tier destructive classification
 *    (warning vs unexecutable) and a type-change sub-tier
 *    (safe / risky / not-castable) that decides in-place `ALTER TYPE` vs a
 *    lossy drop-and-recreate.
 *  - **Atlas**: a single `alter_field` step carrying *which* facets changed
 *    (type / nullability / enum / index) instead of N discrete alter steps.
 *
 * Step ordering is the expand→contract sequence (add before drop, widen before
 * narrow): create models → rename → add columns (always nullable) → alter →
 * drop columns → drop models. NOT NULL is never set on add — it is an
 * `alter_field` nullability change that a backfill must precede.
 */

import type { FieldMeta } from './field.js';
import type { SchemaJSON, ModelJSON } from './serialize.js';

export type FieldType = FieldMeta['type'];

/** Whether a Postgres `ALTER COLUMN … TYPE` can preserve the existing data. */
export type CastSafety = 'safe' | 'risky' | 'notCastable';

export interface FieldTypeChange {
  readonly from: FieldType;
  readonly to: FieldType;
  /** `safe` → plain ALTER TYPE; `risky` → ALTER w/ USING (may fail per-row);
   *  `notCastable` → drop-and-recreate (data loss). */
  readonly cast: CastSafety;
}

/** `isOptional` transition. `true → false` is the dangerous direction. */
export interface NullabilityChange {
  readonly fromOptional: boolean;
  readonly toOptional: boolean;
}

export interface EnumValuesChange {
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

export interface IndexChange {
  readonly from: boolean;
  readonly to: boolean;
}

/** The facets of a single column that changed (Atlas-style bitmask, as data). */
export interface FieldChanges {
  readonly type?: FieldTypeChange;
  readonly nullability?: NullabilityChange;
  readonly enumValues?: EnumValuesChange;
  readonly indexed?: IndexChange;
}

export type MigrationStep =
  | { readonly kind: 'create_model'; readonly model: string; readonly tableName: string }
  | { readonly kind: 'drop_model'; readonly model: string; readonly tableName: string }
  | { readonly kind: 'rename_model'; readonly from: string; readonly to: string }
  | { readonly kind: 'add_field'; readonly model: string; readonly field: string; readonly meta: FieldMeta }
  | { readonly kind: 'drop_field'; readonly model: string; readonly field: string }
  | { readonly kind: 'rename_field'; readonly model: string; readonly from: string; readonly to: string }
  | { readonly kind: 'alter_field'; readonly model: string; readonly field: string; readonly changes: FieldChanges };

/**
 * Rename decisions, injected as data (Drizzle's resolver seam). Without a hint,
 * a removed+added pair reads as drop+add (lossy) — the same safe default Prisma
 * takes. `field.model` refers to the model key in the NEXT schema (post any
 * model rename).
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

function diffField(prev: FieldMeta, next: FieldMeta): FieldChanges | null {
  const changes: {
    type?: FieldTypeChange;
    nullability?: NullabilityChange;
    enumValues?: EnumValuesChange;
    indexed?: IndexChange;
  } = {};

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
    const changes = diffField(prevMeta, nextMeta);
    if (changes) steps.push({ kind: 'alter_field', model, field: name, changes });
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

// ── Destructive classification (Prisma two-tier) ───────────────────────────────

export type WarningCode =
  | 'drop_model'
  | 'drop_field'
  | 'risky_cast'
  | 'lossy_recreate'
  | 'enum_value_removed';

export type BlockerCode = 'required_field_added' | 'made_required';

export interface MigrationSignal {
  readonly code: WarningCode | BlockerCode;
  readonly model: string;
  readonly field?: string;
  readonly detail: string;
}

export interface MigrationClassification {
  /** Execute but may lose or risk data on a non-empty table. */
  readonly warnings: readonly MigrationSignal[];
  /** Will fail on a non-empty table unless a default/backfill is supplied. */
  readonly unexecutable: readonly MigrationSignal[];
}

/**
 * Classify a plan's steps into Prisma-style warnings vs unexecutable. The IR
 * carries no per-field default, so a non-optional `add_field` is conservatively
 * unexecutable (a backfill or default resolves it) — we cannot prove a default
 * exists. Classification is rule-based (schema-derived); the runtime layer can
 * downgrade a signal to a no-op when the target table is empty.
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

/** Convenience: a plan is safe to auto-apply iff it has no unexecutable steps. */
export function isAutoApplicable(classification: MigrationClassification): boolean {
  return classification.unexecutable.length === 0;
}

// ── Backfill ────────────────────────────────────────────────────────────────

/**
 * A constant value to seed into existing rows so an otherwise-`unexecutable`
 * step becomes safe: a required field added to a non-empty table, or a field
 * made required while NULLs exist. Deliberately a CONSTANT (not an SQL
 * expression) — arbitrary backfill logic is out of scope; this serves the
 * common "new column defaults to X" case only. `value` is typed to the field.
 */
export interface BackfillValue {
  readonly model: string;
  readonly field: string;
  readonly value: string | number | boolean;
}

/**
 * Does a provided backfill resolve this blocker? Only the two row-dependent
 * blockers (`required_field_added`, `made_required`) are backfill-resolvable; a
 * data-loss *warning* is not — that always needs `force`.
 */
export function isBlockerResolved(
  signal: MigrationSignal,
  backfills: readonly BackfillValue[],
): boolean {
  if (signal.code !== 'required_field_added' && signal.code !== 'made_required') return false;
  return backfills.some((b) => b.model === signal.model && b.field === signal.field);
}

/** The unexecutable signals NOT covered by a supplied backfill. Empty → the push
 *  can proceed (modulo the separate `warnings`/`force` gate). */
export function unresolvedBlockers(
  classification: MigrationClassification,
  backfills: readonly BackfillValue[],
): readonly MigrationSignal[] {
  return classification.unexecutable.filter((s) => !isBlockerResolved(s, backfills));
}
