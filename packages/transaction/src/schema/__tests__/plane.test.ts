/**
 * P1 plane axis — a model defaults to the `tenant` plane, the value round-trips
 * through `toSchemaJSON`, and `generateProvisionPlan` emits only tenant-plane
 * models (control-plane models are never provisioned into a tenant DB). Pure.
 */

import { z } from 'zod';
import { model } from '@abloatai/transaction/schema/model';
import { defineSchema } from '@abloatai/transaction/schema/schema';
import { toSchemaJSON } from '../serialize.js';
import { generateProvisionPlan } from '../ddl.js';

describe('plane axis (P1)', () => {
  it('defaults to `tenant` and provisions tenant-plane models', () => {
    const schema = defineSchema({
      docs: model({ title: z.string() }, { tableName: 'docs' }),
    });
    const json = toSchemaJSON(schema);
    expect(json.models.docs?.plane).toBe('tenant');

    const plan = generateProvisionPlan(json, 'public');
    expect(plan.statements.some((s) => s.includes('"docs"'))).toBe(true);
  });

  it('carries an explicit `control` plane through serialize and SKIPS it in provisioning', () => {
    const schema = defineSchema({
      docs: model({ title: z.string() }, { tableName: 'docs' }),
      syncLog: model({ data: z.string() }, { tableName: 'sync_deltas', plane: 'control' }),
    });
    const json = toSchemaJSON(schema);
    expect(json.models.syncLog?.plane).toBe('control');
    expect(json.models.docs?.plane).toBe('tenant');

    const sql = generateProvisionPlan(json, 'public').statements.join('\n');
    expect(sql).toContain('"docs"'); // tenant-plane → emitted
    expect(sql).not.toContain('sync_deltas'); // control-plane → skipped
  });
});
