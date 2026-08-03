/**
 * Ledger migration tests.
 *
 * The `ablo_idempotency` column upgrades must be genuine no-ops on a re-run,
 * INCLUDING when the ledger was created by an earlier integration and is owned
 * by another role. `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` checks ownership
 * before the existence short-circuit, so the naive form errors "must be owner"
 * on a table it doesn't own even when the column is already there. These tests
 * pin the catalog-guarded form that avoids that.
 */

import { idempotencyLedgerMigrations, adapterTableMigrations } from '../migrations.js';

describe('idempotencyLedgerMigrations', () => {
  const ledger = idempotencyLedgerMigrations();
  const byName = (name: string): string => {
    const migration = ledger.find((m) => m.name === name);
    if (!migration) throw new Error(`no ledger migration named ${name}`);
    return migration.up;
  };

  it('keeps the three stable migration names in order', () => {
    expect(ledger.map((m) => m.name)).toEqual([
      'ablo_idempotency',
      'ablo_idempotency_request_hash',
      'ablo_idempotency_permanent_retention',
    ]);
  });

  it('creates the table with every current column, so a fresh setup needs no upgrade', () => {
    const create = byName('ablo_idempotency');
    // Schema-qualified and quoted: the generator targets an explicit schema so
    // the DDL is correct outside `public` and safe against reserved words.
    expect(create).toContain('CREATE TABLE IF NOT EXISTS "public"."ablo_idempotency"');
    expect(create).toContain('request_hash TEXT');
    expect(create).toContain("expires_at   TIMESTAMPTZ NOT NULL DEFAULT 'infinity'");
  });

  it('never uses bare ADD COLUMN IF NOT EXISTS — it checks ownership before the existence short-circuit', () => {
    for (const migration of ledger) {
      expect(migration.up).not.toContain('ADD COLUMN IF NOT EXISTS');
    }
  });

  it('guards the request_hash upgrade on the catalog so a no-op re-run never reaches the ALTER', () => {
    const up = byName('ablo_idempotency_request_hash');
    // Resolves the ledger through the search path and reads pg_attribute, which
    // is legible regardless of table ownership.
    expect(up).toContain(`to_regclass('"public"."ablo_idempotency"')`);
    expect(up).toContain('pg_attribute');
    expect(up).toContain("attname = 'request_hash'");
    // The ALTER runs only inside the "column absent" branch.
    expect(up).toContain('ALTER TABLE "public"."ablo_idempotency" ADD COLUMN "request_hash" TEXT');
    expect(up).toMatch(/IF ledger IS NOT NULL AND NOT EXISTS/);
  });

  it('guards the expires_at upgrade the same way, preserving the NOT NULL DEFAULT', () => {
    const up = byName('ablo_idempotency_permanent_retention');
    expect(up).toContain("attname = 'expires_at'");
    expect(up).toContain(
      `ALTER TABLE "public"."ablo_idempotency" ADD COLUMN "expires_at" TIMESTAMPTZ NOT NULL DEFAULT 'infinity'`,
    );
  });

  it('is the prefix of the full endpoint adapter migration set', () => {
    expect(adapterTableMigrations().slice(0, 3)).toEqual(ledger);
  });
});
