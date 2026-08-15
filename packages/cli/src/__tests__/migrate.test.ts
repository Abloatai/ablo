import { parseMigrateArgs, planFor } from '../migrate';
import { defineSchema, model, z } from '@abloatai/transaction/schema';

describe('parseMigrateArgs', () => {
  it('applies sensible defaults', () => {
    const a = parseMigrateArgs([]);
    expect(a.schemaPath).toBe('ablo/schema.ts');
    expect(a.exportName).toBe('schema');
    expect(a.targetSchema).toBe('public');
    expect(a.dryRun).toBe(false);
    expect(a.outputFile).toBeNull();
  });

  it('parses every flag', () => {
    const a = parseMigrateArgs(['--dry-run', '--output', 'x.sql', '--schema', 'p.ts', '--export', 's', '--app-schema', 'app_x']);
    expect(a.dryRun).toBe(true);
    expect(a.outputFile).toBe('x.sql');
    expect(a.schemaPath).toBe('p.ts');
    expect(a.exportName).toBe('s');
    expect(a.targetSchema).toBe('app_x');
  });

  it('throws on an unknown flag', () => {
    expect(() => parseMigrateArgs(['--nope'])).toThrow(/unknown flag/);
  });
});

const schema = defineSchema({
  records: model(
    { title: z.string(), priority: z.number(), status: z.enum(['todo', 'done']) },
    { typename: 'Record', tableName: 'records', mutable: true }),
});

describe('planFor — the shared schema-SQL engine (same as hosted)', () => {
  const sql = planFor(schema, 'public').statements.join('\n');

  it('maps a Zod number to DOUBLE PRECISION (not INTEGER — the old CLI drift)', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "priority" DOUBLE PRECISION');
    expect(sql).not.toContain('INTEGER');
  });

  it('creates the table with platform base columns', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "public"."records"');
    expect(sql).toContain('"organization_id" TEXT NOT NULL');
  });

  it('emits RLS with the org GUC predicate', () => {
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain("current_setting('app.current_org_id', true)");
  });

  it('emits the enum CHECK constraint', () => {
    expect(sql).toContain(`CHECK ("status" IN ('todo', 'done'))`);
  });

  it('skips CREATE SCHEMA for the public schema', () => {
    expect(sql).not.toContain('CREATE SCHEMA');
  });
});

describe('planFor — schema without an explicit tableName (the `ablo init` starter)', () => {
  // The init template defines models with no `tableName`; the table must
  // default to the model key, or `ablo migrate` provisions zero tables.
  const starter = defineSchema({
    workspaces: model({ name: z.string() }),
    records: model({ title: z.string(), workspaceId: z.string().optional() }),
  });

  it('still provisions a table per model, named after the model key', () => {
    const plan = planFor(starter, 'public');
    expect(plan.statements.length).toBeGreaterThan(0);
    const sql = plan.statements.join('\n');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "public"."workspaces"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "public"."records"');
  });
});
