import {
  connectApplyPlan,
  passwordClause,
  postRegistrationOutcome,
  ROTATE_STRANDED_CREDENTIALS_NOTICE,
  detectProvider,
  detectPooler,
  logicalReplicationGuidance,
} from '../connectApply';
import {
  ownershipBlockers,
  ownershipRemediation,
  formatUnresolvedOwnership,
  type OwnedRelationRow,
} from '../connectOwnership';
import { connectSetupSql, ABLO_PUBLICATION } from '../connectSetup';

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

describe('provider detection and the write-ahead-log step', () => {
  it('identifies managed providers from the host, and everything else as generic', () => {
    expect(detectProvider('ep-tiny-fire-aj1gvf1c.c-3.us-east-2.aws.neon.tech/neondb')).toBe('neon');
    expect(detectProvider('db.abcdefgh.supabase.co/postgres')).toBe('supabase');
    expect(detectProvider('mydb.abc123.us-east-1.rds.amazonaws.com/app')).toBe('rds');
    expect(detectProvider('10.0.0.5:5432/app')).toBe('generic');
    expect(detectProvider('localhost/app')).toBe('generic');
  });

  it('tells a pooled host from the database itself, and derives the direct host where it can', () => {
    // A pooler refuses the session with the same wording as a wrong password,
    // so this is what keeps a correct credential from being blamed.
    expect(detectPooler('ep-tiny-fire-aj1gvf1c-pooler.c-3.us-east-2.aws.neon.tech/neondb')).toEqual({
      provider: 'neon',
      direct: 'ep-tiny-fire-aj1gvf1c.c-3.us-east-2.aws.neon.tech/neondb',
    });
    // Supabase's pooler is a different host entirely, so there is none to derive.
    expect(detectPooler('aws-0-eu-central-1.pooler.supabase.com/postgres')).toEqual({
      provider: 'supabase',
    });
    expect(detectPooler('mydb.proxy-abc123.us-east-1.rds.amazonaws.com/app')).toEqual({
      provider: 'rds',
    });
  });

  it('stays silent on a direct host, so a real credential failure still reads as one', () => {
    expect(detectPooler('ep-tiny-fire-aj1gvf1c.c-3.us-east-2.aws.neon.tech/neondb')).toBeNull();
    expect(detectPooler('db.abcdefgh.supabase.co/postgres')).toBeNull();
    expect(detectPooler('mydb.abc123.us-east-1.rds.amazonaws.com/app')).toBeNull();
    expect(detectPooler('localhost/app')).toBeNull();
  });

  it('gives each managed provider its real path to logical replication — not an ALTER SYSTEM', () => {
    expect(logicalReplicationGuidance('neon')).toMatch(/Neon project settings/);
    expect(logicalReplicationGuidance('supabase')).toMatch(/Supabase/);
    expect(logicalReplicationGuidance('rds')).toMatch(/rds\.logical_replication = 1/);
    expect(logicalReplicationGuidance('generic')).toMatch(/ALTER SYSTEM/);
  });

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

describe('ownershipBlockers — the shared ownership preflight decision', () => {
  const row = (over: Partial<OwnedRelationRow>): OwnedRelationRow => ({
    relation: 'public.documents',
    owner: 'ablo_app',
    can_manage: false,
    is_superuser: false,
    can_grant_inherit: false,
    ...over,
  });

  it('passes when the admin can manage every relation', () => {
    expect(ownershipBlockers([row({ owner: 'neondb_owner', can_manage: true })])).toEqual([]);
  });

  it('passes when the admin INHERITs the owning role (managed-Postgres common case)', () => {
    // The throwaway case: `documents` is owned by `ablo_app`, but the admin is an
    // inheriting member of it, so `pg_has_role(…, 'USAGE')` is true and the grant
    // succeeds. This must NOT be flagged, or a working setup would be blocked.
    expect(ownershipBlockers([row({ can_manage: true, can_grant_inherit: true })])).toEqual([]);
  });

  it('passes when the admin is a superuser', () => {
    expect(ownershipBlockers([row({ is_superuser: true })])).toEqual([]);
  });

  it('reports relations the admin can neither own nor act as owner for, carrying the self-grant flag', () => {
    // The adopter case: `documents` owned by a legacy `ablo_app` the admin reaches
    // only through a NOINHERIT membership, so the writer grants fail with
    // `must be owner of table documents`. `canGrantInherit` rides along so the
    // caller can print the fix that runs.
    expect(
      ownershipBlockers([
        row({ relation: 'public.documents', can_grant_inherit: true }),
        row({ relation: 'public.tasks', owner: 'neondb_owner', can_manage: true }),
        row({ relation: 'public.projects', can_grant_inherit: true }),
      ]),
    ).toEqual([
      { relation: 'public.documents', owner: 'ablo_app', canGrantInherit: true },
      { relation: 'public.projects', owner: 'ablo_app', canGrantInherit: true },
    ]);
  });

  it('applies the inherit-aware predicate to the ledger too — an inheriting admin is not blocked', () => {
    // Regression: the ledger check once used strict `relowner = current_user`,
    // which false-positived an admin that only INHERITs the owner. Unified onto
    // `can_manage`, the same inheriting admin correctly proceeds.
    expect(
      ownershipBlockers([row({ relation: 'public.ablo_idempotency', can_manage: true })]),
    ).toEqual([]);
  });
});

describe('ownershipRemediation — the fix that actually runs', () => {
  it('emits one inherit-grant per owning role, not per table, when the admin can self-grant', () => {
    // The adopter case, now with the correct fix: `documents` and `projects` are
    // both owned by `ablo_app`, so one `GRANT ablo_app … WITH INHERIT TRUE`
    // unblocks both — reassigning ownership could never run from a non-owner.
    const { inheritGrants, unresolved } = ownershipRemediation(
      [
        { relation: 'public.documents', owner: 'ablo_app', canGrantInherit: true },
        { relation: 'public.projects', owner: 'ablo_app', canGrantInherit: true },
      ],
      'neondb_owner',
    );
    expect(inheritGrants).toEqual(['GRANT "ablo_app" TO "neondb_owner" WITH INHERIT TRUE;']);
    expect(unresolved).toEqual([]);
  });

  it('leaves owners the admin cannot self-grant as unresolved for the honest fallback', () => {
    // No admin option on `legacy_app`: the admin can't grant itself inheritance,
    // so there is no runnable one-liner — it must reconnect as an authorized role.
    const { inheritGrants, unresolved } = ownershipRemediation(
      [{ relation: 'public.documents', owner: 'legacy_app', canGrantInherit: false }],
      'neondb_owner',
    );
    expect(inheritGrants).toEqual([]);
    expect(unresolved).toEqual([
      { relation: 'public.documents', owner: 'legacy_app', canGrantInherit: false },
    ]);
  });

  it('splits a mixed set — grants what it can, defers what it cannot', () => {
    const { inheritGrants, unresolved } = ownershipRemediation(
      [
        { relation: 'public.documents', owner: 'ablo_app', canGrantInherit: true },
        { relation: 'public.audit', owner: 'legacy_app', canGrantInherit: false },
      ],
      'neondb_owner',
    );
    expect(inheritGrants).toEqual(['GRANT "ablo_app" TO "neondb_owner" WITH INHERIT TRUE;']);
    expect(unresolved).toEqual([
      { relation: 'public.audit', owner: 'legacy_app', canGrantInherit: false },
    ]);
  });
});

describe('formatUnresolvedOwnership — the only ownership error, for what apply cannot fix', () => {
  it('names the concrete grant an authorized role must run', () => {
    const text = formatUnresolvedOwnership(
      [{ relation: 'public.documents', owner: 'legacy_app', canGrantInherit: false }],
      'neondb_owner',
      'db.example.com/app',
    );
    expect(text).toContain('GRANT "legacy_app" TO "neondb_owner" WITH INHERIT TRUE;');
    expect(text).toContain('admin option');
  });

  it('offers the drop only when the ledger itself is unresolved', () => {
    const withLedger = formatUnresolvedOwnership(
      [{ relation: 'public.ablo_idempotency', owner: 'legacy_app', canGrantInherit: false }],
      'neondb_owner',
      'db.example.com/app',
    );
    expect(withLedger).toContain('DROP TABLE ablo_idempotency;');

    const tableOnly = formatUnresolvedOwnership(
      [{ relation: 'public.documents', owner: 'legacy_app', canGrantInherit: false }],
      'neondb_owner',
      'db.example.com/app',
    );
    expect(tableOnly).not.toContain('DROP TABLE');
  });
});

describe('postRegistrationOutcome — the --rotate partial-failure guard', () => {
  it('exits success with no notice when registration confirmed', () => {
    expect(postRegistrationOutcome({ rotating: false, registered: true })).toEqual({
      exitCode: 0,
      notice: null,
    });
    expect(postRegistrationOutcome({ rotating: true, registered: true })).toEqual({
      exitCode: 0,
      notice: null,
    });
  });

  it('never exits success when registration failed', () => {
    // The load-bearing property: --apply and --rotate both refuse a success exit
    // unless registration (which includes Ablo's server-side read-back) confirmed.
    expect(postRegistrationOutcome({ rotating: false, registered: false }).exitCode).toBe(1);
    expect(postRegistrationOutcome({ rotating: true, registered: false }).exitCode).toBe(1);
  });

  it('warns only on --rotate that the database and Ablo now disagree, and how to reconcile', () => {
    // ALTER ROLE already ran, so the DB holds the new password Ablo doesn't have.
    const rotate = postRegistrationOutcome({ rotating: true, registered: false });
    expect(rotate.notice).toContain('set in your database');
    expect(rotate.notice).toContain('ablo connect rotate');
    // A first-time apply failure breaks nothing that was working — no scary notice.
    expect(postRegistrationOutcome({ rotating: false, registered: false }).notice).toBeNull();
  });

  it('every stranded-credential exit tells the one recovery story — the outcome IS the shared notice', () => {
    // The interrupt handler (Ctrl-C mid-rotate) and the registration-failure
    // outcome both print ROTATE_STRANDED_CREDENTIALS_NOTICE. Pinning identity
    // here means a future edit can't make the two paths tell different stories.
    expect(postRegistrationOutcome({ rotating: true, registered: false }).notice).toBe(
      ROTATE_STRANDED_CREDENTIALS_NOTICE,
    );
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
