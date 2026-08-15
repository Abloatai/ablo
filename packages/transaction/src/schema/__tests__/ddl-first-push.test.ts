/**
 * First-push provisioning — the onboarding-critical plan shape.
 *
 * A fresh org's FIRST schema push (`prev = null`) lowers entirely through
 * `generateMigrationPlan` — there is no separate provisioning pass. The plan
 * must therefore create the tenant's `app_<orgId>` schema itself: stripping
 * `CREATE SCHEMA` (correct for later migrations of an existing tenant) made
 * statement 0 = `CREATE TABLE "app_…"."…"` and every new signup's `ablo dev`
 * died server-side with `3F000 invalid_schema_name`. Caught live by the
 * quickstart loop walk (2026-06-10).
 */

import { defineSchema } from '@abloatai/transaction/schema/schema';
import { model } from '@abloatai/transaction/schema/model';
import { field } from '@abloatai/transaction/schema/field';
import { toSchemaJSON } from '../serialize.js';
import { diffSchema, generateMigrationPlan } from '../index.js';

const schema = defineSchema({
  workspaces: model({ name: field.string() }),
  items: model({ title: field.string() }),
});
const next = toSchemaJSON(schema);

describe('generateMigrationPlan — first push (prev = null)', () => {
  const steps = diffSchema(null, next);

  it('creates the app schema BEFORE any table lands in it', () => {
    const plan = generateMigrationPlan(steps, {
      prev: null,
      next,
      targetSchema: 'app_org_fresh_1',
    });
    expect(plan.statements[0]).toBe('CREATE SCHEMA IF NOT EXISTS "app_org_fresh_1";');
    // …and exactly once — the per-model provisioner reuse must not repeat it.
    const creates = plan.statements.filter((s) => s.startsWith('CREATE SCHEMA'));
    expect(creates).toHaveLength(1);
    // Every table statement targets the now-existing schema.
    expect(plan.statements.some((s) => s.includes('"app_org_fresh_1"."workspaces"'))).toBe(true);
  });

  it('never emits CREATE SCHEMA for a dedicated tenant on `public`', () => {
    const plan = generateMigrationPlan(steps, { prev: null, next, targetSchema: 'public' });
    expect(plan.statements.some((s) => s.startsWith('CREATE SCHEMA'))).toBe(false);
  });

  it('provisions no application audit columns unless the model declares them', () => {
    const plan = generateMigrationPlan(steps, { prev: null, next, targetSchema: 'public' });
    const sql = plan.statements.join('\n');
    expect(sql).not.toContain('"created_by"');
    expect(sql).not.toContain('"created_at"');
    expect(sql).not.toContain('"updated_at"');
  });

  it('emits nothing for an empty step list', () => {
    const plan = generateMigrationPlan([], { prev: next, next, targetSchema: 'app_org_fresh_1' });
    expect(plan.statements).toHaveLength(0);
  });
});
