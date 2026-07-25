import { reconcile, describeMismatches, type ConfirmedTarget, type TargetProject } from '../target';
import type { ActiveProject, Mode } from '../config';

/**
 * The reconciliation is the safety core of `ablo push`: it decides whether the
 * project/environment a key REALLY targets (server-confirmed) matches what the
 * CLI shows from local preferences. A false negative here is the "banner said
 * acme, deployed to globex" incident; a false positive nags on every push. These
 * exercise the pure decision on constructed planes — no network.
 */

const ORG = 'org_acme';

/** An org-default project (its id equals the org id, by convention). */
const defaultProject: TargetProject = { id: ORG, slug: 'default', name: null, isDefault: true };
/** A named, non-default project. */
const mailProject: TargetProject = { id: 'proj_mail', slug: 'mail', name: 'Mail', isDefault: false };

function confirmed(over: Partial<ConfirmedTarget> = {}): ConfirmedTarget {
  return {
    organizationId: ORG,
    environment: 'sandbox',
    project: defaultProject,
    projectId: ORG,
    sandboxId: null,
    ...over,
  };
}

describe('reconcile — local intent vs. the server-confirmed plane', () => {
  it('no divergence when the confirmed project and environment match local intent', () => {
    expect(
      reconcile({
        confirmed: confirmed(),
        keyEnv: 'sandbox',
        localProject: undefined, // org-default, matches the confirmed default project
        cliMode: 'sandbox',
      }),
    ).toEqual([]);
  });

  it('flags a project drift: a named project is selected locally but the key targets default', () => {
    const localProject: ActiveProject = { id: 'proj_mail', slug: 'mail' };
    const mismatches = reconcile({
      confirmed: confirmed(), // key really targets the org-default project
      keyEnv: 'sandbox',
      localProject,
      cliMode: 'sandbox',
    });
    expect(mismatches).toEqual([{ kind: 'project', intended: 'mail', actual: 'default' }]);
  });

  it('flags a project drift the other way: org-default selected, but the key targets a named project', () => {
    const mismatches = reconcile({
      confirmed: confirmed({ project: mailProject, projectId: mailProject.id }),
      keyEnv: 'sandbox',
      localProject: undefined, // intends the org-default
      cliMode: 'sandbox',
    });
    expect(mismatches).toEqual([{ kind: 'project', intended: 'default', actual: 'mail' }]);
  });

  it('matches by id, so a slug rename is NOT a false mismatch', () => {
    // Local preference remembers the old slug; the project list now names it
    // differently. Same id → same project → no drift.
    const localProject: ActiveProject = { id: 'proj_mail', slug: 'old-mail-slug' };
    expect(
      reconcile({
        confirmed: confirmed({ project: mailProject, projectId: mailProject.id }),
        keyEnv: 'sandbox',
        localProject,
        cliMode: 'sandbox',
      }),
    ).toEqual([]);
  });

  it('flags an environment drift from the server-confirmed environment', () => {
    expect(
      reconcile({
        confirmed: confirmed({ environment: 'production' }),
        keyEnv: 'production',
        localProject: undefined,
        cliMode: 'sandbox',
      }),
    ).toContainEqual({ kind: 'environment', keyEnv: 'production', cliMode: 'sandbox' });
  });

  it('falls back to the key prefix for the environment when the server omits it', () => {
    expect(
      reconcile({
        confirmed: confirmed({ environment: null }),
        keyEnv: 'production', // sk_live_… prefix
        localProject: undefined,
        cliMode: 'sandbox',
      }),
    ).toContainEqual({ kind: 'environment', keyEnv: 'production', cliMode: 'sandbox' });
  });

  it('reports BOTH a project and an environment drift together', () => {
    const localProject: ActiveProject = { id: 'proj_mail', slug: 'mail' };
    const mismatches = reconcile({
      confirmed: confirmed({ environment: 'production', projectId: ORG }),
      keyEnv: 'production',
      localProject,
      cliMode: 'sandbox',
    });
    expect(mismatches).toEqual(
      expect.arrayContaining([
        { kind: 'project', intended: 'mail', actual: 'default' },
        { kind: 'environment', keyEnv: 'production', cliMode: 'sandbox' },
      ]),
    );
    expect(mismatches).toHaveLength(2);
  });

  describe('server did not answer (confirmed: null) — degrade, do not falsely accuse', () => {
    it('cannot decide a project drift without a confirmed project id', () => {
      const localProject: ActiveProject = { id: 'proj_mail', slug: 'mail' };
      expect(
        reconcile({ confirmed: null, keyEnv: 'sandbox', localProject, cliMode: 'sandbox' }),
      ).toEqual([]);
    });

    it('still catches an environment drift from the key prefix alone', () => {
      const keyEnv: Mode = 'production';
      expect(
        reconcile({ confirmed: null, keyEnv, localProject: undefined, cliMode: 'sandbox' }),
      ).toEqual([{ kind: 'environment', keyEnv: 'production', cliMode: 'sandbox' }]);
    });
  });
});

describe('describeMismatches — ONE calm note, never stacked routing narration', () => {
  it('no divergence → no note', () => {
    expect(describeMismatches([])).toBeNull();
  });

  it('a project divergence states where this acts and the one remedy', () => {
    const msg = describeMismatches([{ kind: 'project', intended: 'mail', actual: 'default' }]);
    expect(msg).toContain('acts on project default');
    expect(msg).toContain('not mail as selected');
    expect(msg).toContain('Use a key for mail');
  });

  it('an environment divergence states where this acts and the one remedy', () => {
    const msg = describeMismatches([
      { kind: 'environment', keyEnv: 'production', cliMode: 'sandbox' },
    ]);
    expect(msg).toContain('acts on production');
    expect(msg).toContain('not sandbox as selected');
    expect(msg).toContain('Use a key for sandbox');
  });

  it('both divergences merge into one short line', () => {
    const msg = describeMismatches([
      { kind: 'environment', keyEnv: 'production', cliMode: 'sandbox' },
      { kind: 'project', intended: 'mail', actual: 'acme' },
    ]);
    expect(msg).toContain('acts on production · project acme');
    expect(msg).toContain('not sandbox · mail as selected');
    expect(msg).not.toContain('\n');
  });

  it('asks about intent — never narrates settings or reconciliation mechanics', () => {
    // The click-and-play contract: the header states the ONE target; this note
    // asks "is that what you meant?" and names the matching key as the remedy.
    // Saved-mode bookkeeping and "the key wins" routing explanations are the
    // anti-pattern that confused a real adopter.
    const msg = describeMismatches([
      { kind: 'environment', keyEnv: 'production', cliMode: 'sandbox' },
    ]);
    expect(msg).toMatch(/^This key acts on/);
    expect(msg).not.toMatch(/key wins|routes the|deploys to|saved|mode is|CLI mode|ablo mode|ablo projects use/);
  });
});
