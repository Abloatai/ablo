/**
 * Scoped-role bootstrap — the CLI side of the server's RLS gate.
 * Pins the SQL recipe (must match the documented one), URL rewriting, and
 * password hygiene. The driver-facing `createScopedRole` is exercised live
 * against real Postgres in the quickstart loop, not mocked here.
 */

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  persistDatabaseUrl,
  scopedRoleStatements,
  rewriteDatabaseUrl,
  generateRolePassword,
  readProjectAdminDatabaseUrl,
  readProjectReplicationUrlWithSource,
  readProjectWriteDatabaseUrl,
  DEFAULT_SCOPED_ROLE,
} from '../dbRole';

describe('scopedRoleStatements', () => {
  it('emits the documented recipe: scoped role + database/schema grants', () => {
    const stmts = scopedRoleStatements({ database: 'neondb', password: 'pw' });
    expect(stmts).toHaveLength(3);
    expect(stmts[0]).toContain('NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE');
    expect(stmts[0]).toContain(`"${DEFAULT_SCOPED_ROLE}"`);
    expect(stmts[1]).toBe(`GRANT CREATE, CONNECT ON DATABASE "neondb" TO "${DEFAULT_SCOPED_ROLE}";`);
    expect(stmts[2]).toBe(`GRANT CREATE, USAGE ON SCHEMA public TO "${DEFAULT_SCOPED_ROLE}";`);
  });

  it('is rerun-safe: an existing role rotates its password instead of erroring', () => {
    const [create] = scopedRoleStatements({ database: 'db', password: 'pw' });
    expect(create).toContain('EXCEPTION WHEN duplicate_object THEN');
    expect(create).toContain('ALTER ROLE');
  });

  it('NEVER embeds the plaintext password — a SCRAM verifier goes to the server', () => {
    // `CREATE ROLE ... PASSWORD '<plaintext>'` lands verbatim in the server's
    // statement log under `log_statement` — the client-side verifier (what
    // psql's \\password computes) keeps the secret off the wire and the logs.
    const stmts = scopedRoleStatements({
      database: 'we"ird',
      role: 'ro"le',
      password: "p'w-plaintext",
    });
    expect(stmts[0]).not.toContain('p\'w-plaintext');
    expect(stmts[0]).toMatch(/PASSWORD 'SCRAM-SHA-256\$4096:/);
    expect(stmts[1]).toContain('"we""ird"');
    expect(stmts[0]).toContain('"ro""le"');
  });
});

describe('rewriteDatabaseUrl', () => {
  it('swaps only the credentials — host, db, and params survive', () => {
    const out = rewriteDatabaseUrl(
      'postgresql://neondb_owner:oldpw@ep-x-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
      'ablo_app',
      'newpw',
    );
    const url = new URL(out);
    expect(url.username).toBe('ablo_app');
    expect(url.password).toBe('newpw');
    expect(url.hostname).toBe('ep-x-pooler.eu-central-1.aws.neon.tech');
    expect(url.pathname).toBe('/neondb');
    expect(url.searchParams.get('sslmode')).toBe('require');
    expect(url.searchParams.get('channel_binding')).toBe('require');
  });
});

describe('generateRolePassword', () => {
  it('is long, URL-safe (no escaping needed in a connection string), and unique', () => {
    const a = generateRolePassword();
    const b = generateRolePassword();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

/**
 * Each credential is reached by a function that names it, and no reader crosses
 * into another's variable. `ablo migrate` regressed exactly here: it read the
 * DDL credential through an alias that resolved the replication chain, so when
 * the deprecated `DATABASE_URL` entry left `REPLICATION_URL_VARS`, migrate
 * stopped seeing `DATABASE_URL` while still naming it in the failure.
 *
 * `NO_ENV_FILES` points the file fallback at a directory with no `.env` in it,
 * so these assertions are about the process environment alone.
 */
describe('credential resolution — one variable per reader', () => {
  const NO_ENV_FILES = '/nonexistent-ablo-cli-test-cwd';
  const VARS = ['DATABASE_URL', 'ABLO_REPLICATION_DATABASE_URL', 'ABLO_WRITE_DATABASE_URL'] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const v of VARS) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
  });
  afterEach(() => {
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  });

  it('migrate reads DATABASE_URL from the process environment', () => {
    process.env.DATABASE_URL = 'postgresql://app@host/db';
    expect(readProjectAdminDatabaseUrl(NO_ENV_FILES)).toBe('postgresql://app@host/db');
  });

  it('migrate does NOT fall back to the replication credential', () => {
    process.env.ABLO_REPLICATION_DATABASE_URL = 'postgresql://replicator@host/db';
    expect(readProjectAdminDatabaseUrl(NO_ENV_FILES)).toBeNull();
  });

  it('replication does NOT fall back to DATABASE_URL', () => {
    process.env.DATABASE_URL = 'postgresql://app@host/db';
    expect(readProjectReplicationUrlWithSource(NO_ENV_FILES)).toBeNull();
  });

  it('the writer reads its own variable and nothing else', () => {
    process.env.DATABASE_URL = 'postgresql://app@host/db';
    process.env.ABLO_REPLICATION_DATABASE_URL = 'postgresql://replicator@host/db';
    expect(readProjectWriteDatabaseUrl(NO_ENV_FILES)).toBeNull();
    process.env.ABLO_WRITE_DATABASE_URL = 'postgresql://writer@host/db';
    expect(readProjectWriteDatabaseUrl(NO_ENV_FILES)).toBe('postgresql://writer@host/db');
  });
});

/**
 * A connection string carries `&` between query parameters, and an env file is
 * not only read by a framework's parser — people `source` it. Written unquoted,
 * the shell reads that `&` as a background-job operator and refuses the WHOLE
 * file with a parse error, taking every other variable down with it.
 */
describe('persistDatabaseUrl — the value survives a shell that reads the file', () => {
  const URL_WITH_PARAMS =
    'postgresql://u:p@ep-x.neon.tech/db?sslmode=verify-full&channel_binding=require';
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ablo-dbrole-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('quotes the value, so an `&` in the query string cannot end the statement', () => {
    writeFileSync(join(dir, '.env.local'), 'OTHER=1\n');
    persistDatabaseUrl(URL_WITH_PARAMS, dir);
    const written = readFileSync(join(dir, '.env.local'), 'utf8');
    expect(written).toContain(`DATABASE_URL="${URL_WITH_PARAMS}"`);
  });

  it('round-trips: the CLI reads back exactly what it wrote, quotes stripped', () => {
    writeFileSync(join(dir, '.env.local'), 'OTHER=1\n');
    persistDatabaseUrl(URL_WITH_PARAMS, dir);
    expect(readProjectAdminDatabaseUrl(dir)).toBe(URL_WITH_PARAMS);
  });

  it('replaces an existing line rather than appending a second one', () => {
    writeFileSync(join(dir, '.env.local'), 'DATABASE_URL=postgres://old\nOTHER=1\n');
    persistDatabaseUrl(URL_WITH_PARAMS, dir);
    const written = readFileSync(join(dir, '.env.local'), 'utf8');
    expect(written.match(/^DATABASE_URL=/gm)).toHaveLength(1);
    expect(written).toContain('OTHER=1');
  });
});
