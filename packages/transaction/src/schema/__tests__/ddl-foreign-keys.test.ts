/**
 * Foreign-key emission (opt-in, marker-driven, lock-safe). FK constraints are
 * emitted ONLY for belongsTo relations marked `{ fk: true }` — DECOUPLED from
 * `{ parent: true }` (visibility, not a DB constraint). The constraint is added
 * `NOT VALID` INSIDE the transaction (instant, no scan) and its `VALIDATE` +
 * `CREATE INDEX CONCURRENTLY` are returned in `plan.concurrent` (run after commit,
 * outside any transaction) so a large live BYO table is never frozen. Each FK is
 * DEFERRABLE INITIALLY DEFERRED + ON DELETE NO ACTION and self-heals a divergent
 * same-named constraint. Off by default. Pure.
 */

import { z } from 'zod';
import { model } from '@ablo/transaction/schema/model';
import { relation } from '@ablo/transaction/schema/relation';
import { defineSchema } from '@ablo/transaction/schema/schema';
import { toSchemaJSON } from '../serialize.js';
import { generateProvisionPlan, generateMigrationPlan } from '../ddl.js';

const schema = defineSchema({
  projects: model({ name: z.string() }, { tableName: 'projects' }),
  tasks: model(
    {
      title: z.string(),
      projectId: z.string().optional(),
      parentId: z.string().optional(),
      ownerId: z.string().optional(),
      sourceId: z.string().optional(),
    },
    {
      relations: {
        project: relation.belongsTo('projects', 'projectId', { fk: true }), // fk only
        self: relation.belongsTo('tasks', 'parentId', { fk: true, parent: true }), // both axes
        owner: relation.belongsTo('projects', 'ownerId', { parent: true }), // parent ONLY → NO fk
        source: relation.belongsTo('tasks', 'sourceId'), // soft reference — neither
        comments: relation.hasMany('comments', 'taskId'), // inverse — FK lives on the other table
      },
      tableName: 'tasks',
    }),
});
const json = toSchemaJSON(schema);

describe('foreign-key emission (marker-driven, lock-safe, opt-in)', () => {
  it('emits NO foreign keys by default (back-compat)', () => {
    const plan = generateProvisionPlan(json, 'public');
    expect(plan.statements.some((s) => s.includes('FOREIGN KEY'))).toBe(false);
    expect((plan.concurrent ?? []).length).toBe(0);
  });

  it('emits in-tx FKs for `fk: true` edges only — decoupled from `parent`', () => {
    const plan = generateProvisionPlan(json, 'public', { foreignKeys: true });
    const fks = plan.statements.filter((s) => s.includes('FOREIGN KEY'));

    expect(
      fks.some((s) => s.includes('"tasks_project_id_fkey"') && s.includes('REFERENCES "public"."projects" ("id")')),
    ).toBe(true);
    expect(
      fks.some((s) => s.includes('"tasks_parent_id_fkey"') && s.includes('REFERENCES "public"."tasks" ("id")')),
    ).toBe(true);

    // DECOUPLING: `parent: true` WITHOUT `fk` (owner) must NOT emit; soft ref + hasMany never do
    expect(fks.some((s) => s.includes('owner_id'))).toBe(false);
    expect(fks.some((s) => s.includes('source_id'))).toBe(false);
    expect(fks.length).toBe(2);

    // pure deferred integrity guard, added NOT VALID (no scan in-tx), self-healing
    expect(
      fks.every(
        (s) =>
          s.includes('ON DELETE NO ACTION') && s.includes('DEFERRABLE INITIALLY DEFERRED') && s.includes('NOT VALID'),
      ),
    ).toBe(true);
    expect(fks.every((s) => s.includes('DROP CONSTRAINT') && s.includes('condeferrable'))).toBe(true);
  });

  it('defers VALIDATE + CONCURRENTLY index to plan.concurrent (off the main transaction)', () => {
    const plan = generateProvisionPlan(json, 'public', { foreignKeys: true });
    const concurrent = plan.concurrent ?? [];

    // existing-row validation + child index live in the post-commit, non-tx pass
    expect(concurrent.some((s) => s.includes('VALIDATE CONSTRAINT "tasks_project_id_fkey"'))).toBe(true);
    expect(
      concurrent.some((s) => s.includes('CREATE INDEX CONCURRENTLY IF NOT EXISTS "tasks_project_id_idx"')),
    ).toBe(true);
    // 2 FKs × (validate + index)
    expect(concurrent.length).toBe(4);

    // the lock-heavy bits must NOT be in the in-transaction statements
    expect(plan.statements.some((s) => s.includes('CONCURRENTLY') || s.includes('VALIDATE CONSTRAINT'))).toBe(false);
  });

  it('orders in-tx FK statements after every CREATE TABLE', () => {
    const plan = generateProvisionPlan(json, 'public', { foreignKeys: true });
    const lastCreate = plan.statements.reduce((acc, s, i) => (s.startsWith('CREATE TABLE') ? i : acc), -1);
    const firstFk = plan.statements.findIndex((s) => s.includes('FOREIGN KEY'));
    expect(firstFk).toBeGreaterThan(lastCreate);
  });

  it('skips FKs whose target is a control-plane model', () => {
    const withControl = defineSchema({
      syncLog: model({ data: z.string() }, { tableName: 'sync_deltas', plane: 'control' }),
      events: model(
        { name: z.string(), logId: z.string().optional() },
        {
          relations: { log: relation.belongsTo('syncLog', 'logId', { fk: true }) },
          tableName: 'events',
        }),
    });
    const plan = generateProvisionPlan(toSchemaJSON(withControl), 'public', { foreignKeys: true });
    expect(plan.statements.some((s) => s.includes('FOREIGN KEY'))).toBe(false);
    expect((plan.concurrent ?? []).length).toBe(0);
  });

  it('reconciles the FULL next schema even with no create_model step (relation added later)', () => {
    const plan = generateMigrationPlan([], { prev: json, next: json, targetSchema: 'public', foreignKeys: true });
    expect(plan.statements.some((s) => s.includes('"tasks_project_id_fkey"') && s.includes('FOREIGN KEY'))).toBe(true);
    expect((plan.concurrent ?? []).some((s) => s.includes('VALIDATE CONSTRAINT "tasks_project_id_fkey"'))).toBe(true);
  });

  it('migration emits no FKs when not opted in', () => {
    const steps = [{ kind: 'create_model', model: 'projects', tableName: 'projects' }] as const;
    const plan = generateMigrationPlan(steps, { prev: null, next: json, targetSchema: 'public' });
    expect(plan.statements.some((s) => s.includes('FOREIGN KEY'))).toBe(false);
    expect((plan.concurrent ?? []).length).toBe(0);
  });
});

describe('safe-migration invariants (in-repo lint gate, mirrors Squawk rules)', () => {
  // Encodes Squawk's constraint-missing-not-valid + require-concurrent-index-creation
  // + ban-concurrent-index-creation-in-transaction on the DDL our engine emits, so
  // a regression that drops a safety property fails the build. (CI also runs the
  // real squawk-cli over the dumped plan — see docs.)
  const plan = generateProvisionPlan(json, 'public', { foreignKeys: true });

  it('every FOREIGN KEY is added NOT VALID (no full-table scan inside the txn)', () => {
    const fkAdds = [...plan.statements, ...(plan.concurrent ?? [])].filter(
      (s) => s.includes('ADD CONSTRAINT') && s.includes('FOREIGN KEY'),
    );
    expect(fkAdds.length).toBeGreaterThan(0);
    expect(fkAdds.every((s) => s.includes('NOT VALID'))).toBe(true);
  });

  it('FK indexes are built CONCURRENTLY; any in-tx index is idempotent; no CONCURRENTLY in-tx', () => {
    const indexes = (plan.concurrent ?? []).filter((s) => s.includes('CREATE INDEX'));
    expect(indexes.length).toBeGreaterThan(0);
    expect(indexes.every((s) => s.includes('CONCURRENTLY'))).toBe(true);
    // CONCURRENTLY can never appear inside the transaction (Postgres forbids it).
    expect(plan.statements.some((s) => s.includes('CONCURRENTLY'))).toBe(false);
    // The only in-tx index is the org index, emitted with its CREATE TABLE on a
    // fresh/empty table — and it is IF NOT EXISTS (idempotent, never rebuilds).
    expect(
      plan.statements.filter((s) => s.includes('CREATE INDEX')).every((s) => s.includes('IF NOT EXISTS')),
    ).toBe(true);
  });
});
