import {
  connectApplyPlan,
  passwordClause,
  effectsOnOthers,
} from '../connectPlan';
import { detectProvider, detectPooler, logicalReplicationGuidance } from '../dbProvider';
import {
  connectSetupSql,
  ABLO_PUBLICATION,
  ABLO_REPLICATION_ROLE,
  ABLO_WRITE_ROLE,
} from '../connectSetup';

const CREDS = { replicationClause: 'REPL_PW', writeClause: 'WRITE_PW' } as const;

/** The recipe statements that `--apply` must reuse verbatim (everything but the three heads it replaces). */
function expectedGrants(input: { tables?: readonly string[]; role?: string; writeRole?: string }): readonly string[] {
  return connectSetupSql(input).filter(
    (s) => !s.startsWith('ALTER SYSTEM SET wal_level') && !s.startsWith('CREATE PUBLICATION') && !s.startsWith('CREATE ROLE '),
  );
}

describe('connectApplyPlan — executable, idempotent, real-password plan', () => {
  const plan = connectApplyPlan({ credentials: CREDS });

  it('is the five stages in dependency order', () => {
    expect(plan.map((s) => s.key)).toEqual([
      'wal',
      'publication',
      'replication-role',
      'write-role',
      'grants',
    ]);
  });

  it('leads with an ownership stage carrying the inherit-grants, so apply fixes ownership itself', () => {
    // The seamless path: when the admin can self-grant inheritance of an owning
    // role, apply runs it as the first stage rather than stopping to ask — the
    // grant must land before publish/grants, which Postgres reserves for the owner.
    const withOwn = connectApplyPlan({
      credentials: CREDS,
      inheritGrants: ['GRANT "ablo_app" TO "neondb_owner" WITH INHERIT TRUE;'],
    });
    expect(withOwn[0]?.key).toBe('own');
    expect(withOwn[0]?.sql).toEqual(['GRANT "ablo_app" TO "neondb_owner" WITH INHERIT TRUE;']);
    expect(withOwn.findIndex((s) => s.key === 'own')).toBeLessThan(
      withOwn.findIndex((s) => s.key === 'publication'),
    );
    // No inherit-grants → no ownership stage; the ordinary plan is unchanged.
    expect(connectApplyPlan({ credentials: CREDS }).some((s) => s.key === 'own')).toBe(false);
  });

  it('reuses the recipe grants VERBATIM — the security-sensitive statements never drift', () => {
    // The whole point: `--apply` must grant exactly what `ablo connect` documents
    // and tests assert. If connectSetupSql changes a grant, this catches it.
    const grantsStep = plan.find((s) => s.key === 'grants');
    expect(grantsStep?.sql).toEqual(expectedGrants({}));
  });

  it('creates a role that is absent, and re-running never touches one that exists', () => {
    // `apply` is safe to re-run, which is NOT the same as "re-running re-keys".
    // A second apply against a database another connection is using must leave
    // that connection's credential working — the earlier shape recovered from
    // `duplicate_object` with an unconditional `ALTER ROLE … PASSWORD`, which
    // silently invalidated it.
    const roleSql = (key: 'replication-role' | 'write-role', p = plan) =>
      p.find((s) => s.key === key)?.sql.join('\n') ?? '';

    for (const key of ['replication-role', 'write-role'] as const) {
      const sql = roleSql(key);
      expect(sql).toContain('IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname =');
      expect(sql).toContain('CREATE ROLE');
      expect(sql).not.toContain('ALTER ROLE');
    }
    expect(roleSql('replication-role')).toContain('WITH REPLICATION LOGIN');
  });

  it('rotate is the one verb that re-keys an existing role', () => {
    const rotating = connectApplyPlan({ credentials: CREDS, rotate: true });
    for (const key of ['replication-role', 'write-role'] as const) {
      const sql = rotating.find((s) => s.key === key)?.sql.join('\n') ?? '';
      // Still creates when absent — rotate on a fresh database is a valid setup.
      expect(sql).toContain('CREATE ROLE');
      // …and re-keys when present, which is the whole point of the verb.
      expect(sql).toContain('ALTER ROLE');
      expect(sql).toContain('LOGIN PASSWORD');
    }
  });

  it('makes publication creation idempotent', () => {
    const pub = plan.find((s) => s.key === 'publication')?.sql.join('\n') ?? '';
    expect(pub).toContain(`CREATE PUBLICATION "${ABLO_PUBLICATION}"`);
    expect(pub).toContain('EXCEPTION WHEN duplicate_object THEN NULL');
  });

  it('substitutes the real password clause — no `<password>` placeholder survives', () => {
    const all = plan.flatMap((s) => s.sql).join('\n');
    expect(all).not.toContain('<password>');
    expect(all).not.toContain('<write-password>');
    expect(all).toContain('REPL_PW');
    expect(all).toContain('WRITE_PW');
  });

  it('threads a table subset and custom role names through both heads and grants', () => {
    const custom = connectApplyPlan({
      tables: ['tasks', 'projects'],
      role: 'my_reader',
      writeRole: 'my_writer',
      credentials: CREDS,
    });
    const pub = custom.find((s) => s.key === 'publication')?.sql.join('\n') ?? '';
    expect(pub).toContain('FOR TABLE "tasks", "projects"');
    expect(custom.find((s) => s.key === 'replication-role')?.sql.join('\n')).toContain('"my_reader"');
    expect(custom.find((s) => s.key === 'write-role')?.sql.join('\n')).toContain('"my_writer"');
    expect(custom.find((s) => s.key === 'grants')?.sql).toEqual(
      expectedGrants({ tables: ['tasks', 'projects'], role: 'my_reader', writeRole: 'my_writer' }),
    );
  });
});

describe('the write-ahead-log step per provider', () => {
  it('drops the WAL step entirely when the cluster is already logical', () => {
    const plan = connectApplyPlan({ credentials: CREDS, walAlreadyLogical: true });
    expect(plan.map((s) => s.key)).toEqual([
      'publication',
      'replication-role',
      'write-role',
      'grants',
    ]);
  });

  it('shows a managed provider a console action, not an ALTER SYSTEM it cannot run', () => {
    const plan = connectApplyPlan({ credentials: CREDS, provider: 'neon' });
    const wal = plan.find((s) => s.key === 'wal');
    expect(wal?.sql).toEqual([]); // no SQL — enabling it is a settings action
    expect(wal?.detail).toMatch(/Neon project settings/);
  });

  it('keeps the runnable ALTER SYSTEM for self-hosted (generic) Postgres', () => {
    const plan = connectApplyPlan({ credentials: CREDS });
    const wal = plan.find((s) => s.key === 'wal');
    expect(wal?.sql).toEqual([`ALTER SYSTEM SET wal_level = 'logical';`]);
  });
});

describe('effectsOnOthers — what the plan reaches beyond Ablo\'s own objects', () => {
  const REVOKE = [
    `DO $$ BEGIN\n  EXECUTE format('REVOKE TEMPORARY, CREATE ON DATABASE %I FROM PUBLIC', current_database());\nEND $$;`,
  ];

  it('names the database revoke, because it takes from roles Ablo did not create', () => {
    const effects = effectsOnOthers({ grants: REVOKE, allTables: false });
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatch(/every role in this database/i);
    // The way back has to travel with the warning, not live in the docs.
    expect(effects[0]).toMatch(/GRANT TEMPORARY ON DATABASE/);
  });

  it('names an all-tables publication, which enlists other tools\' tables', () => {
    const effects = effectsOnOthers({ grants: [], allTables: true });
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatch(/other tools/i);
    expect(effects[0]).toMatch(/--tables/);
  });

  it('says nothing when the plan only touches Ablo\'s own objects', () => {
    // A scoped publication plus grants on Ablo's roles reaches nobody else,
    // and a notice that fires every run stops being read.
    expect(
      effectsOnOthers({ grants: ['GRANT USAGE ON SCHEMA public TO "ablo_writer";'], allTables: false }),
    ).toEqual([]);
  });

  it('is derived from the SQL, so a recipe that drops the revoke drops the notice', () => {
    // Pinning the derivation, not a hand-kept list: the failure this prevents is
    // a notice that keeps describing a statement no longer in the plan.
    const withRevoke = effectsOnOthers({ grants: REVOKE, allTables: false });
    const without = effectsOnOthers({ grants: REVOKE.map(() => 'GRANT USAGE ON SCHEMA public TO "x";'), allTables: false });
    expect(withRevoke).toHaveLength(1);
    expect(without).toEqual([]);
  });
});

describe('passwordClause', () => {
  it('produces a PostgreSQL SCRAM-SHA-256 verifier by default (plaintext never reaches the statement log)', () => {
    expect(passwordClause('hunter2', 'scram-verifier')).toMatch(/^SCRAM-SHA-256\$4096:.+\$.+:.+$/);
  });

  it('escapes a single quote for the plaintext fallback', () => {
    expect(passwordClause("a'b", 'plaintext')).toBe("a''b");
  });
});
