import { parseConnectArgs, auditTenantSyncInfra } from '../connect';
import {
  connectSetupSql as buildConnectSetupSql,
  reconcilePublicationPlan as buildPublicationPlan,
  registerDirectDataSource,
  ABLO_PUBLICATION,
  ABLO_REPLICATION_ROLE,
  ABLO_WRITE_ROLE,
  type PublicationState,
} from '../connectSetup';
import {
  ABLO_REPLICATION_SLOT,
  ABLO_IDEMPOTENCY_TABLE,
  ABLO_OUTBOX_TABLE,
} from '@abloatai/transaction/footprint';
import * as dbRole from '../dbRole';

const connectSetupSql = (
  input: Omit<Parameters<typeof buildConnectSetupSql>[0], 'publication'> & {
    readonly publication?: string;
  },
) => buildConnectSetupSql({ ...input, publication: input.publication ?? ABLO_PUBLICATION });

const reconcilePublicationPlan = (
  current: PublicationState,
  desiredTables: readonly string[],
) => buildPublicationPlan(current, desiredTables, { publication: ABLO_PUBLICATION });

describe('parseConnectArgs', () => {
  it('parses the locate subcommand — the who-holds-this question', () => {
    const args = parseConnectArgs(['locate', '--url', 'postgres://u:p@h/db']);
    expect(args.locate).toBe(true);
    expect(args.url).toBe('postgres://u:p@h/db');
    expect(args.apply).toBe(false);
  });

  it('applies sensible defaults', () => {
    const a = parseConnectArgs([]);
    expect(a.check).toBe(false);
    expect(a.scan).toBe(false);
    expect(a.tables).toEqual([]);
    expect(a.schema).toBe('public');
    expect(a.role).toBe(ABLO_REPLICATION_ROLE);
    expect(a.writeRole).toBe(ABLO_WRITE_ROLE);
    expect(a.route).toBe('public-allowlist');
    expect(a.apply).toBe(false);
    expect(a.rotate).toBe(false);
    expect(a.resnapshot).toBe(false);
    expect(a.url).toBeUndefined();
    expect(a.manual).toBe(false);
    expect(a.json).toBe(false);
  });

  it('parses --manual, the escape hatch back to the printed recipe', () => {
    expect(parseConnectArgs(['--manual']).manual).toBe(true);
    // A bare invocation defaults to running the setup, so `--manual` is the one
    // flag that keeps today's print-the-SQL behaviour.
    expect(parseConnectArgs([]).manual).toBe(false);
  });

  it('parses an explicit env file without silently loading one by default', () => {
    expect(parseConnectArgs(['rotate', '--env-file', '.env.local']).envFile).toBe('.env.local');
    expect(parseConnectArgs(['rotate']).envFile).toBeUndefined();
  });

  it('parses stable JSON output mode', () => {
    expect(parseConnectArgs(['apply', '--json', '--yes']).json).toBe(true);
  });

  it('selects modes by subcommand', () => {
    expect(parseConnectArgs(['register']).register).toBe(true);
    expect(parseConnectArgs(['check']).check).toBe(true);
    expect(parseConnectArgs(['apply']).apply).toBe(true);
    expect(parseConnectArgs(['rotate']).rotate).toBe(true);
    expect(parseConnectArgs(['resnapshot']).resnapshot).toBe(true);
    expect(parseConnectArgs(['scan']).scan).toBe(true);
  });

  it('accepts modifiers after a subcommand', () => {
    const a = parseConnectArgs([
      'apply',
      '--url',
      'postgres://admin@host:5432/db',
      '--schema',
      'mail',
      '--yes',
    ]);
    expect(a.apply).toBe(true);
    expect(a.url).toBe('postgres://admin@host:5432/db');
    expect(a.yes).toBe(true);
    expect(a.schema).toBe('mail');
  });

  it('rejects the retired mode flags — subcommands only now', () => {
    expect(() => parseConnectArgs(['--register'])).toThrow(/unknown flag/);
    expect(() => parseConnectArgs(['--check'])).toThrow(/unknown flag/);
    expect(() => parseConnectArgs(['--audit-infra'])).toThrow(/unknown flag/);
  });

  it('rejects an unknown subcommand and names the valid ones', () => {
    expect(() => parseConnectArgs(['bogus'])).toThrow(/unknown connect subcommand/);
    expect(() => parseConnectArgs(['bogus'])).toThrow(/deregister/);
    expect(() => parseConnectArgs(['bogus'])).toThrow(/scan/);
  });

  it('parses --tables into a trimmed, non-empty list', () => {
    const a = parseConnectArgs(['--tables', 'records, projects ,, users']);
    expect(a.tables).toEqual(['records', 'projects', 'users']);
  });

  it('parses --role', () => {
    expect(parseConnectArgs(['--role', 'my_reader']).role).toBe('my_reader');
  });

  it('parses the separate writer role and direct network route', () => {
    const a = parseConnectArgs(['--write-role', 'my_writer', '--route', 'privatelink']);
    expect(a.writeRole).toBe('my_writer');
    expect(a.route).toBe('privatelink');
  });

  it('parses a subcommand with modifier flags together', () => {
    const a = parseConnectArgs(['check', '--tables', 'a,b', '--role', 'r']);
    expect(a.check).toBe(true);
    expect(a.tables).toEqual(['a', 'b']);
    expect(a.role).toBe('r');
  });

  it('throws on an unknown flag', () => {
    expect(() => parseConnectArgs(['--nope'])).toThrow(/unknown flag/);
  });

  it('rejects a non-direct route and privilege collapse onto one role', () => {
    expect(() => parseConnectArgs(['--route', 'endpoint'])).toThrow(/invalid direct route/);
    expect(() => parseConnectArgs(['--role', 'same', '--write-role', 'same'])).toThrow(
      /must be different/
    );
  });
});

describe('replication credential resolution — one canonical name, no fallback (DATABASE_URL sunset in 0.32.0)', () => {
  const saved = {
    canonical: process.env.ABLO_REPLICATION_DATABASE_URL,
    legacy: process.env.ABLO_DATABASE_URL,
    generic: process.env.DATABASE_URL,
  };
  afterEach(() => {
    process.env.ABLO_REPLICATION_DATABASE_URL = saved.canonical;
    process.env.ABLO_DATABASE_URL = saved.legacy;
    process.env.DATABASE_URL = saved.generic;
    if (saved.canonical === undefined) delete process.env.ABLO_REPLICATION_DATABASE_URL;
    if (saved.legacy === undefined) delete process.env.ABLO_DATABASE_URL;
    if (saved.generic === undefined) delete process.env.DATABASE_URL;
  });

  it('reads exactly one name — the canonical replication variable', () => {
    expect(dbRole.REPLICATION_URL_VARS).toEqual(['ABLO_REPLICATION_DATABASE_URL']);
  });

  it('reads the canonical ABLO_REPLICATION_DATABASE_URL and ignores a set DATABASE_URL', () => {
    process.env.ABLO_REPLICATION_DATABASE_URL = 'postgres://repl@h/db';
    process.env.DATABASE_URL = 'postgres://app@h/db';
    expect(dbRole.readProjectReplicationUrlWithSource('/nonexistent')).toEqual({
      url: 'postgres://repl@h/db',
      variable: 'ABLO_REPLICATION_DATABASE_URL',
    });
  });

  it('does NOT fall back to DATABASE_URL (sunset in 0.32.0) — returns null so the caller refuses', () => {
    delete process.env.ABLO_REPLICATION_DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://app@h/db';
    expect(dbRole.readProjectReplicationUrlWithSource('/nonexistent')).toBeNull();
  });

  it('does NOT read the deleted ABLO_DATABASE_URL fossil', () => {
    delete process.env.ABLO_REPLICATION_DATABASE_URL;
    delete process.env.DATABASE_URL;
    process.env.ABLO_DATABASE_URL = 'postgres://legacy@h/db';
    expect(dbRole.readProjectReplicationUrlWithSource('/nonexistent')).toBeNull();
  });
});

describe('auditTenantSyncInfra', () => {
  /** A fake that answers "present" for a named set and records every lookup. */
  const auditWith = (present: ReadonlySet<string>) => {
    const calls: { query: string; values: unknown[] }[] = [];
    const sql = {
      unsafe: async (query: string, values: unknown[]) => {
        calls.push({ query, values });
        return [{ present: present.has(values[0] as string) }];
      },
    };
    return { sql: sql as never, calls };
  };

  it('looks for everything Ablo installs today, not only an older release', async () => {
    const { sql } = auditWith(new Set());
    const looked = (await auditTenantSyncInfra(sql)).map((a) => a.name);

    // The drift this replaced: the audit knew only the retired tables, so a
    // customer asking what Ablo had in their database was told "nothing" while
    // a publication, two roles, a ledger and a replication slot sat there.
    expect(looked).toEqual(
      expect.arrayContaining([
        ABLO_PUBLICATION,
        ABLO_REPLICATION_SLOT,
        ABLO_REPLICATION_ROLE,
        ABLO_WRITE_ROLE,
        ABLO_IDEMPOTENCY_TABLE,
        ABLO_OUTBOX_TABLE,
      ]),
    );
    // …and still finds what an older Ablo left, which is what nobody thinks to look for.
    expect(looked).toEqual(expect.arrayContaining(['sync_deltas', 'mutation_log']));
  });

  it('resolves each object where Postgres actually keeps it', async () => {
    const { sql, calls } = auditWith(new Set());
    await auditTenantSyncInfra(sql);
    const query = (name: string) => calls.find((c) => (c.values[0] as string).endsWith(name))?.query;

    // Tables and types go through the search path; a slot, role, or publication
    // is cluster-wide and has no schema to qualify it with.
    expect(query(ABLO_IDEMPOTENCY_TABLE)).toContain('to_regclass');
    expect(calls.find((c) => c.values[0] === `public.${ABLO_IDEMPOTENCY_TABLE}`)).toBeDefined();
    expect(query(ABLO_REPLICATION_SLOT)).toContain('pg_replication_slots');
    expect(query(ABLO_WRITE_ROLE)).toContain('pg_roles');
    expect(query(ABLO_PUBLICATION)).toContain('pg_publication');
  });

  it('carries the slot hazard through, and never mutates', async () => {
    const { sql, calls } = auditWith(new Set([ABLO_REPLICATION_SLOT]));
    const artifacts = await auditTenantSyncInfra(sql);

    const slot = artifacts.find((a) => a.name === ABLO_REPLICATION_SLOT);
    expect(slot).toMatchObject({ present: true, kind: 'slot' });
    // A leftover slot holds the write-ahead log back — the report has to say so,
    // because the object's name does not.
    expect(slot?.hazard).toMatch(/fills the disk/);

    expect(artifacts.filter((a) => a.present).map((a) => a.name)).toEqual([ABLO_REPLICATION_SLOT]);
    expect(calls.every((c) => /^SELECT/i.test(c.query.trim()))).toBe(true);
  });

  it('separates what Ablo installs now from what an older release left', async () => {
    const { sql } = auditWith(new Set());
    const artifacts = await auditTenantSyncInfra(sql);
    const retired = artifacts.filter((a) => a.retired).map((a) => a.name);

    expect(retired).toContain('sync_deltas');
    expect(retired).toContain(ABLO_PUBLICATION);
    // Every entry explains itself; the report is read by someone deciding
    // whether to drop it.
    expect(artifacts.every((a) => a.purpose.length > 0)).toBe(true);
  });
});

describe('connectSetupSql — the one prescriptive recipe (logical replication)', () => {
  const sql = connectSetupSql({});
  const joined = sql.join('\n');

  it('turns on logical decoding', () => {
    expect(joined).toContain(`ALTER SYSTEM SET wal_level = 'logical';`);
  });

  it('creates the canonical publication FOR ALL TABLES by default', () => {
    expect(joined).toContain(`CREATE PUBLICATION "${ABLO_PUBLICATION}" FOR ALL TABLES;`);
    expect(joined).not.toContain('FOR TABLE');
  });

  it('creates a least-privilege REPLICATION LOGIN role with a placeholder password', () => {
    expect(joined).toContain(
      `CREATE ROLE "${ABLO_REPLICATION_ROLE}" WITH NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE REPLICATION NOINHERIT LOGIN PASSWORD '<password>';`
    );
  });

  it('keeps the replication role SELECT-only', () => {
    expect(joined).toContain(
      `GRANT SELECT ON ALL TABLES IN SCHEMA "public" TO "${ABLO_REPLICATION_ROLE}";`
    );
    expect(joined).toContain(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA "public" GRANT SELECT ON TABLES TO "${ABLO_REPLICATION_ROLE}";`
    );
    expect(joined).not.toContain(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${ABLO_REPLICATION_ROLE}"`
    );
  });

  it('creates a distinct DML-only writer with RLS and no DDL capability', () => {
    expect(joined).toContain(
      `CREATE ROLE "${ABLO_WRITE_ROLE}" WITH LOGIN PASSWORD '<write-password>' ` +
        `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;`
    );
    expect(joined).toContain(`ALTER ROLE "${ABLO_WRITE_ROLE}" SET row_security = on;`);
    expect(joined).toContain(`GRANT USAGE ON SCHEMA "public" TO "${ABLO_WRITE_ROLE}";`);
    expect(joined).not.toContain(`GRANT CREATE ON SCHEMA public TO "${ABLO_WRITE_ROLE}"`);
    expect(joined).not.toContain('OWNER TO');
    // Ablo does not alter permissions of roles it doesn't own: it never revokes
    // the schema-level CREATE the customer's own roles rely on.
    expect(joined).not.toContain('REVOKE CREATE ON SCHEMA public');
  });

  it('removes the database-level create/temp defaults so the write gate accepts a stock database', () => {
    // Postgres grants TEMP on every database to PUBLIC by default, and PUBLIC
    // grants apply regardless of NOINHERIT — without this revoke the engine's
    // DML-only write gate refuses a recipe-perfect writer on day one. Database
    // level only; the schema-level policy above still holds.
    expect(joined).toContain(
      `REVOKE TEMPORARY, CREATE ON DATABASE %I FROM PUBLIC', current_database()`
    );
  });

  it('scopes every grant to the named tables — no schema-wide reach — with --tables', () => {
    const scoped = connectSetupSql({ tables: ['records'] }).join('\n');
    // Replicator reads only the published table, and gains no default-privilege
    // grant that would reach tables added later.
    expect(scoped).toContain(`GRANT SELECT ON TABLE "public"."records" TO "${ABLO_REPLICATION_ROLE}";`);
    expect(scoped).not.toContain('ON ALL TABLES IN SCHEMA public');
    expect(scoped).not.toContain('ALTER DEFAULT PRIVILEGES');
    // Writer DML is limited to the named table.
    expect(scoped).toContain(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "public"."records" TO "${ABLO_WRITE_ROLE}";`
    );
    // Sequences are the ones those tables own, resolved from the catalog — not
    // every sequence in the schema.
    expect(scoped).not.toContain('ON ALL SEQUENCES IN SCHEMA public');
    expect(scoped).toContain('FROM pg_depend');
    expect(scoped).toContain("t.relname IN ('records')");
  });

  it('provisions the permanent direct ledger but no endpoint outbox', () => {
    expect(joined).toContain('CREATE TABLE IF NOT EXISTS "public"."ablo_idempotency"');
    expect(joined).toContain('request_hash TEXT');
    expect(joined).toContain("expires_at   TIMESTAMPTZ NOT NULL DEFAULT 'infinity'");
    expect(joined).toContain(
      `GRANT SELECT, INSERT, UPDATE ON TABLE "public"."ablo_idempotency" TO "${ABLO_WRITE_ROLE}";`
    );
    expect(joined).toContain(
      `REVOKE DELETE ON TABLE "public"."ablo_idempotency" FROM "${ABLO_WRITE_ROLE}";`
    );
    expect(joined).not.toContain('ablo_outbox');
  });

  it('scopes the publication to a subset with --tables', () => {
    const scoped = connectSetupSql({ tables: ['records', 'projects'] }).join('\n');
    expect(scoped).toContain(
      `CREATE PUBLICATION "${ABLO_PUBLICATION}" FOR TABLE "public"."records", "public"."projects";`
    );
    expect(scoped).not.toContain('FOR ALL TABLES');
  });

  it('keeps every per-project object inside the configured schema', () => {
    const scoped = connectSetupSql({
      schema: 'content',
      publication: 'ablo_publication_branch',
      tables: ['records'],
    }).join('\n');
    expect(scoped).toContain(
      'CREATE PUBLICATION "ablo_publication_branch" FOR TABLE "content"."records";'
    );
    expect(scoped).toContain('GRANT USAGE ON SCHEMA "content"');
    expect(scoped).toContain('CREATE TABLE IF NOT EXISTS "content"."ablo_idempotency"');
    expect(scoped).not.toContain('"public"."records"');
    expect(scoped).not.toContain('"public"."ablo_idempotency"');
  });

  it('honors a custom role name everywhere it appears', () => {
    const custom = connectSetupSql({ role: 'my_reader', writeRole: 'my_writer' }).join('\n');
    expect(custom).toContain(
      `CREATE ROLE "my_reader" WITH NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE REPLICATION NOINHERIT LOGIN`
    );
    expect(custom).toContain(`GRANT SELECT ON ALL TABLES IN SCHEMA "public" TO "my_reader";`);
    expect(custom).toContain(`CREATE ROLE "my_writer" WITH LOGIN`);
    expect(custom).toContain(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "public" TO "my_writer";`
    );
    expect(custom).not.toContain(ABLO_REPLICATION_ROLE);
    expect(custom).not.toContain(ABLO_WRITE_ROLE);
  });

  it('quotes identifiers safely (no injection through --role / --tables)', () => {
    const sneaky = connectSetupSql({
      role: 'r"; DROP',
      writeRole: 'w"; DROP',
      tables: ['t"; DROP'],
    }).join('\n');
    expect(sneaky).toContain('"r""; DROP"');
    expect(sneaky).toContain('"w""; DROP"');
    expect(sneaky).toContain('"t""; DROP"');
  });
});

describe('reconcilePublicationPlan — keep the publication equal to --tables', () => {
  const scoped = (tables: string[]): PublicationState => ({
    exists: true,
    allTables: false,
    tables,
  });

  it('creates the publication when none exists (scoped)', () => {
    const r = reconcilePublicationPlan({ exists: false, allTables: false, tables: [] }, [
      'records',
    ]);
    expect(r.sql).toEqual([`CREATE PUBLICATION "${ABLO_PUBLICATION}" FOR TABLE "public"."records";`]);
    expect(r.added).toEqual(['records']);
    expect(r.removed).toEqual([]);
    expect(r.recreated).toBe(false);
  });

  it('creates FOR ALL TABLES when none exists and no --tables given', () => {
    const r = reconcilePublicationPlan({ exists: false, allTables: false, tables: [] }, []);
    expect(r.sql).toEqual([`CREATE PUBLICATION "${ABLO_PUBLICATION}" FOR ALL TABLES;`]);
    expect(r.recreated).toBe(false);
  });

  it('is a no-op when the scoped set already matches', () => {
    const r = reconcilePublicationPlan(scoped(['records']), ['records']);
    expect(r.sql).toEqual([]);
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
  });

  it('SET TABLEs the full desired list on a scoped→scoped change (add + drop at once)', () => {
    const r = reconcilePublicationPlan(scoped(['a', 'b']), ['a', 'c']);
    expect(r.sql).toEqual([`ALTER PUBLICATION "${ABLO_PUBLICATION}" SET TABLE "public"."a", "public"."c";`]);
    expect(r.added).toEqual(['c']);
    expect(r.removed).toEqual(['b']);
    expect(r.recreated).toBe(false);
  });

  it('reproduces the adopter bug: stale cb_* publication reconciled to records', () => {
    // The exact state that produced "writer not ready": a pre-existing publication
    // publishing the CollabBench tables while `apply --tables records` ran.
    const r = reconcilePublicationPlan(scoped(['cb_agent_runs', 'cb_documents', 'cb_tasks']), [
      'records',
    ]);
    expect(r.sql).toEqual([`ALTER PUBLICATION "${ABLO_PUBLICATION}" SET TABLE "public"."records";`]);
    expect(r.added).toEqual(['records']);
    expect(r.removed).toEqual(['cb_agent_runs', 'cb_documents', 'cb_tasks']);
  });

  it('drops+recreates for a mode flip (FOR ALL TABLES → scoped)', () => {
    const r = reconcilePublicationPlan({ exists: true, allTables: true, tables: [] }, ['records']);
    expect(r.sql).toEqual([
      `DROP PUBLICATION IF EXISTS "${ABLO_PUBLICATION}";`,
      `CREATE PUBLICATION "${ABLO_PUBLICATION}" FOR TABLE "public"."records";`,
    ]);
    expect(r.recreated).toBe(true);
    expect(r.added).toEqual(['records']);
  });

  it('drops+recreates for a mode flip (scoped → FOR ALL TABLES) and reports the removals', () => {
    const r = reconcilePublicationPlan(scoped(['a', 'b']), []);
    expect(r.sql).toEqual([
      `DROP PUBLICATION IF EXISTS "${ABLO_PUBLICATION}";`,
      `CREATE PUBLICATION "${ABLO_PUBLICATION}" FOR ALL TABLES;`,
    ]);
    expect(r.recreated).toBe(true);
    expect(r.removed).toEqual(['a', 'b']);
  });

  it('is a no-op when already FOR ALL TABLES and still want all', () => {
    const r = reconcilePublicationPlan({ exists: true, allTables: true, tables: [] }, []);
    expect(r.sql).toEqual([]);
    expect(r.recreated).toBe(false);
  });
});

describe('registerDirectDataSource — renders the server readiness checklist (envelope contract)', () => {
  // The engine's canonical error object (AbloError.toJSON, the shape app.onError
  // emits) SPREADS its domain `details` at the TOP level. A readiness rejection
  // therefore arrives as `{ code, message, failures: [...] }` — NOT nested under a
  // `details` key. This is the shape apps/sync-server's errors.ts test pins; the CLI
  // must read it from the top level. (The earlier bug read `body.details.failures`
  // and silently dropped the whole checklist.)
  const realFetch = globalThis.fetch;
  const realError = console.error;
  const realLog = console.log;
  let errors: string[];

  beforeEach(() => {
    errors = [];
    console.error = (...a: unknown[]): void => {
      errors.push(a.map(String).join(' '));
    };
    console.log = (): void => undefined;
  });
  afterEach(() => {
    console.error = realError;
    console.log = realLog;
    globalThis.fetch = realFetch;
  });

  // Only the members registerDirectDataSource reads — a 400 (so `ok` is false)
  // whose `json()` yields the wire body. `Response` isn't a global in this jest
  // environment, so we shape the subset the code touches rather than construct one.
  const stubFetch = (body: unknown): void => {
    const res: Pick<Response, 'ok' | 'status' | 'json'> = {
      ok: false,
      status: 400,
      json: () => Promise.resolve(body),
    };
    globalThis.fetch = (): Promise<Response> => Promise.resolve(res as Response);
  };

  const register = (): Promise<boolean> =>
    registerDirectDataSource({
      apiUrl: 'https://api.abloatai.com',
      apiKey: 'sk_test',
      replicationUrl: 'postgres://r@h/db',
      writeUrl: 'postgres://w@h/db',
      route: 'public-allowlist',
    });

  it('renders each failing invariant from a TOP-LEVEL failures array, in plain language', async () => {
    stubFetch({
      type: 'invalid_request_error',
      code: 'data_source_blocked',
      message: 'The direct-write role is not ready.',
      failures: [
        {
          item: 'table_privileges',
          actual: 'public.cb_documents, public.cb_agent_runs, public.cb_tasks',
          fix: 'Grant SELECT, INSERT, UPDATE, DELETE on the published application tables to ablo_writer.',
        },
      ],
    });
    const ok = await register();
    const out = errors.join('\n');
    expect(ok).toBe(false);
    // The same label `connect check` prints — one rendering of the checklist,
    // never the raw internal item name.
    expect(out).toContain(`the writer login can't write to your tables yet`);
    expect(out).not.toContain('table_privileges');
    expect(out).toContain('public.cb_documents');
    expect(out).toContain('Grant SELECT, INSERT, UPDATE, DELETE');
  });

  it('still renders a nested details.failures body (proxy/older-engine fallback)', async () => {
    stubFetch({
      code: 'data_source_blocked',
      message: 'The direct-write role is not ready.',
      details: { failures: [{ item: 'logical_marker', fix: 'Grant EXECUTE on pg_logical_emit_message.' }] },
    });
    const ok = await register();
    const out = errors.join('\n');
    expect(ok).toBe(false);
    expect(out).toContain('confirm a write landed');
    expect(out).toContain('pg_logical_emit_message');
  });

  it('treats localhost-first projects as supported connector development, not as an exposure demand', async () => {
    stubFetch({
      code: 'database_loopback_requires_connector',
      message: 'Ablo Cloud cannot open a direct PostgreSQL connection to localhost.',
      topology: 'localhost',
      recommended_commands: ['ablo migrate', 'ablo dev --local'],
    });
    const ok = await register();
    const out = errors.join('\n');
    expect(ok).toBe(false);
    expect(out).toContain('Recommended for this localhost-first project');
    expect(out).toContain('npx ablo migrate');
    expect(out).toContain('npx ablo dev --local');
    expect(out).toContain('raw SQL');
    expect(out).toContain('not a transaction pooler');
    expect(out).not.toContain('expose Postgres');
  });
});
