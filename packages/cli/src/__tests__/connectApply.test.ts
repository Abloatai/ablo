import { postRegistrationOutcome, ROTATE_STRANDED_CREDENTIALS_NOTICE } from '../connectApply';
import {
  alreadyConnectedElsewhere,
  reapplyBlocker,
  rotateWithoutConnection,
} from '../connectPreflight';
import {
  ownershipBlockers,
  ownershipRemediation,
  formatUnresolvedOwnership,
  type OwnedRelationRow,
} from '../connectOwnership';
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

describe('reapplyBlocker — the guard on a password that was generated but never set', () => {
  const ROLES = [ABLO_REPLICATION_ROLE, ABLO_WRITE_ROLE] as const;

  it('stops a second apply, because the roles it found keep their old passwords', () => {
    // The defect this exists for: apply generated a password, skipped CREATE ROLE
    // for the role that already existed, and registered the generated one anyway.
    // Ablo then dialled with a password the database had never accepted.
    expect(reapplyBlocker({ rotating: false, existingRoles: [...ROLES] })).toEqual({
      roles: [...ROLES],
      plural: true,
    });
  });

  it('stops on a single pre-existing role, and says so in the singular', () => {
    expect(reapplyBlocker({ rotating: false, existingRoles: [ABLO_REPLICATION_ROLE] })).toEqual({
      roles: [ABLO_REPLICATION_ROLE],
      plural: false,
    });
  });

  it('lets a first apply through', () => {
    expect(reapplyBlocker({ rotating: false, existingRoles: [] })).toBeNull();
  });

  it('never stops a rotate — re-keying what it finds is the whole verb', () => {
    expect(reapplyBlocker({ rotating: true, existingRoles: [...ROLES] })).toBeNull();
    expect(reapplyBlocker({ rotating: true, existingRoles: [] })).toBeNull();
  });
});

describe('rotateWithoutConnection — the guard on a re-key with nothing to re-key', () => {
  it('refuses a rotate when there is no registration AND no roles — a first connect', () => {
    // The defect it exists for: rotate re-keyed a live database, registration was
    // then declined because the database already streams to another branch, and
    // the database was left on a password Ablo never received.
    const refusal = rotateWithoutConnection({
      rotating: true,
      planeHasConnection: false,
      known: true,
      keyRejected: false,
      existingRoles: [],
    });
    expect(refusal).toMatch(/no connected database/i);
    // The remedy travels with the refusal: the right verb for a first connect.
    expect(refusal).toMatch(/connect apply/i);
  });

  it('allows a rotate that has a registration to update', () => {
    expect(
      rotateWithoutConnection({
        rotating: true,
        planeHasConnection: true,
        known: true,
        keyRejected: false,
        existingRoles: [],
      })
    ).toBeNull();
  });

  it('allows the STRANDED recovery: roles present, no registration', () => {
    // The loop this closes: apply over existing roles says "run rotate";
    // rotate on a plane with nothing registered said "run apply". Roles
    // present with no registration IS the stranded state — an earlier run
    // re-keyed the database and failed to register — and rotate is exactly
    // its recovery: fresh passwords, then a registration that can validate.
    expect(
      rotateWithoutConnection({
        rotating: true,
        planeHasConnection: false,
        known: true,
        keyRejected: false,
        existingRoles: ['ablo_replicator', 'ablo_writer'],
      })
    ).toBeNull();
  });

  it('never blocks apply, which is the verb for a first connect', () => {
    expect(
      rotateWithoutConnection({
        rotating: false,
        planeHasConnection: false,
        known: true,
        keyRejected: false,
        existingRoles: [],
      })
    ).toBeNull();
  });

  it('refuses when Ablo answered and turned the key down — even in the stranded state', () => {
    // The hole this closes: a mistyped key made the state "unknown", unknown was
    // permissive, and rotate re-keyed a live database before registration failed
    // on the key. Answering-and-declining is not the same as not answering. And
    // existing roles must not soften it: a declined key can never be told the
    // new password, whatever the database holds.
    const refusal = rotateWithoutConnection({
      rotating: true,
      planeHasConnection: false,
      known: false,
      keyRejected: true,
      existingRoles: ['ablo_replicator'],
    });
    expect(refusal).toMatch(/did not accept this API key/i);
  });

  it('does not refuse on an unreachable control plane — unknown is not a no', () => {
    // A machine that cannot reach Ablo says nothing about what the plane holds,
    // and refusing there would strand the operator differently.
    expect(
      rotateWithoutConnection({
        rotating: true,
        planeHasConnection: false,
        known: false,
        keyRejected: false,
        existingRoles: [],
      })
    ).toBeNull();
  });
});

describe('alreadyConnectedElsewhere — the conflict refused before anything is written', () => {
  it('names the project and branch holding it, which is where the reader must go', () => {
    // A branch id alone resolves only inside its own project, so the refusal has
    // to carry the project or it points at a door the reader cannot find.
    const refusal = alreadyConnectedElsewhere({ project: 'proj_x', branch: 'br_root_abc' });
    expect(refusal).toMatch(/project proj_x/);
    expect(refusal).toMatch(/br_root_abc/);
  });

  it('falls back to the branch when the holder is the default project', () => {
    expect(alreadyConnectedElsewhere({ project: null, branch: 'br_root_abc' })).toMatch(/branch br_root_abc/);
  });

  it('says nothing when no other plane holds it', () => {
    // Also the unreachable-control-plane case: locate returns null rather than
    // guessing, and an unanswered question is not evidence of a conflict.
    expect(alreadyConnectedElsewhere(null)).toBeNull();
  });
});
