import { z } from 'zod';

/**
 * Row/subject authorization for one model.
 *
 * A row is authorized exactly when the authenticated request carries the sync
 * group `${group}:${row[field]}`. Both values are plain schema data so the rule
 * survives serialization and can be compiled by every storage plane.
 */
export const subjectRuleSchema = z.strictObject({
  field: z.string().regex(
    /^[a-zA-Z_][a-zA-Z0-9_]*$/,
    'subject.field must name a model field',
  ),
  group: z.string().regex(
    /^[a-z][a-z0-9_]*$/,
    'subject.group must be a lowercase identifier, e.g. "workspace"',
  ),
});

export type SubjectRule = z.infer<typeof subjectRuleSchema>;

/** The exact trusted group a row must match, or null for a malformed row. */
export function subjectGroupForRow(
  rule: SubjectRule,
  row: Readonly<Record<string, unknown>>,
): string | null {
  const value = row[rule.field];
  return typeof value === 'string' && value.length > 0
    ? `${rule.group}:${value}`
    : null;
}

/** Fail-closed row check shared by endpoint adapters and in-memory log folds. */
export function subjectAuthorized(
  rule: SubjectRule | undefined,
  row: Readonly<Record<string, unknown>>,
  groups: readonly string[] | null | undefined,
): boolean {
  if (!rule) return true;
  const required = subjectGroupForRow(rule, row);
  return required !== null && (groups ?? []).includes(required);
}
