/**
 * Live round-trip proof that `ablo migrate` (generateProvisionPlan) and
 * `drizzleDataSource` COMPOSE: provision a table from the schema (snake_case
 * columns), then drive the SHIPPED adapter (dist) against a real Postgres
 * (PGlite / WASM, real interactive transactions) and assert the physical
 * columns are snake_case while the adapter's public surface stays field-keyed.
 *
 * Run: node_modules/.bin/tsx scripts/verify-drizzle-roundtrip.mts
 */

import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import {
  defineSchema,
  model,
  field,
  toSchemaJSON,
  generateProvisionPlan,
} from '../dist/schema/index.js';
import { drizzleDataSource } from '../dist/source/adapters/drizzle.js';

const pass: string[] = [];
const ok = (label: string): void => {
  pass.push(label);
  console.log(`  ✓ ${label}`);
};

// One schema. Fields diverge from columns three ways: default rule
// (operatorId→operator_id), explicit override (legacyName→display_label),
// base tenancy column (organizationId→organization_id).
const schema = defineSchema({
  station: model({
    title: field.string(),
    operatorId: field.string().optional(),
    legacyName: field.string().from('display_label').optional(),
    archivedAt: field.date().optional(),
  }),
});

const client = new PGlite();
const db = drizzle(client);
const adapter = drizzleDataSource(db, schema);

// 1. Provision with the REAL `ablo migrate` DDL + the adapter-owned tables.
const plan = generateProvisionPlan(toSchemaJSON(schema), 'public');
for (const stmt of plan.statements) await client.exec(stmt);
for (const m of adapter.migrations()) await client.exec(m.up);
ok('provisioned via generateProvisionPlan + adapter.migrations() (no errors)');

// RLS is FORCE-enabled by the provisioner; satisfy the org predicate.
await client.exec("SET app.current_org_id = 'org1'");

// 2. The physical table has SNAKE_CASE columns (not camelCase fields).
const colRows = (await client.query<{ column_name: string }>(
  "SELECT column_name FROM information_schema.columns WHERE table_name = 'station'",
)).rows.map((r) => r.column_name).sort();
for (const expected of ['operator_id', 'display_label', 'organization_id', 'archived_at', 'created_at', 'updated_at']) {
  assert.ok(colRows.includes(expected), `expected column "${expected}" — got ${colRows.join(', ')}`);
}
for (const forbidden of ['operatorId', 'legacyName', 'organizationId', 'archivedAt']) {
  assert.ok(!colRows.includes(forbidden), `column "${forbidden}" should NOT exist (provisioner is snake_case)`);
}
ok(`provisioned columns are snake_case: ${colRows.join(', ')}`);

// 3. CREATE through the adapter (camelCase input) writes those snake columns.
const created = await adapter.commit({
  clientTxId: 'tx-1',
  operations: [
    {
      type: 'CREATE',
      model: 'station',
      id: 's1',
      input: { title: 'Alpha', operatorId: 'op-1', legacyName: 'Legacy', organizationId: 'org1' },
    },
  ],
});
const row = created.rows[0];
assert.equal(row.operatorId, 'op-1');
assert.equal(row.legacyName, 'Legacy');
assert.equal(row.organizationId, 'org1');
assert.ok(!('operator_id' in row) && !('display_label' in row), 'commit rows must be field-keyed, not column-keyed');
ok('CREATE: camelCase input → snake columns → field-keyed rows back');

// 4. The row physically landed under snake_case columns.
const raw = (await client.query<Record<string, unknown>>(
  "SELECT operator_id, display_label, organization_id FROM station WHERE id = 's1'",
)).rows[0];
assert.equal(raw.operator_id, 'op-1');
assert.equal(raw.display_label, 'Legacy');
assert.equal(raw.organization_id, 'org1');
ok('row stored under operator_id / display_label / organization_id');

// 5. Read maps snake columns back to camelCase fields.
const loaded = await adapter.read({ kind: 'load', model: 'station', id: 's1' });
assert.equal(loaded[0].operatorId, 'op-1');
assert.equal(loaded[0].legacyName, 'Legacy');
assert.ok(!('operator_id' in loaded[0]), 'read must surface field keys, not column keys');
ok('READ: snake columns → camelCase fields');

// 6. ARCHIVE writes archived_at (snake), driven by the camelCase archivedAt field.
await adapter.commit({ clientTxId: 'tx-2', operations: [{ type: 'ARCHIVE', model: 'station', id: 's1', input: {} }] });
const archived = (await client.query<{ archived_at: unknown }>(
  "SELECT archived_at FROM station WHERE id = 's1'",
)).rows[0];
assert.ok(archived.archived_at != null, 'archived_at should be set');
ok('ARCHIVE: archivedAt → archived_at column set');

// 7. Outbox events carry field-keyed data.
const page = await adapter.events(null, 50);
assert.ok(page.events.length >= 2, 'expected outbox events for CREATE + ARCHIVE');
const createEvent = page.events.find((e) => e.type === 'CREATE');
assert.ok(createEvent && createEvent.data && (createEvent.data as Record<string, unknown>).operatorId === 'op-1',
  'outbox data must be field-keyed (operatorId), so Ablo fans out the SDK shape');
ok('OUTBOX: events carry field-keyed data (operatorId, not operator_id)');

// 8. Idempotency: replaying the same clientTxId returns the original, no double-write.
const replay = await adapter.commit({
  clientTxId: 'tx-1',
  operations: [
    {
      type: 'CREATE',
      model: 'station',
      id: 's1',
      input: { title: 'Alpha', operatorId: 'op-1', legacyName: 'Legacy', organizationId: 'org1' },
    },
  ],
});
assert.equal(replay.rows[0].operatorId, 'op-1');
const count = (await client.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM station")).rows[0].n;
assert.equal(count, 1, 'idempotent replay must NOT insert a second row');
ok('IDEMPOTENCY: duplicate clientTxId replays, no double-write');

await client.close();
console.log(`\nALL ${pass.length} CHECKS PASSED — ablo migrate DDL + drizzleDataSource compose end-to-end.`);
