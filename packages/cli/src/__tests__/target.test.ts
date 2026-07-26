import { reconcile, describeMismatches, type ConfirmedTarget, type TargetProject } from '../target';
import type { ActiveProject } from '../config';

/**
 * The reconciliation is the safety core of `ablo push`: it decides whether the
 * project a key REALLY targets (server-confirmed) matches what the
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
    ...over,
  };
}

describe('reconcile — local intent vs. the server-confirmed target', () => {
  it('has no divergence when the confirmed project matches local intent', () => {
    expect(
      reconcile({
        confirmed: confirmed(),
        localProject: undefined, // org-default, matches the confirmed default project
      }),
    ).toEqual([]);
  });

  it('flags a project drift: a named project is selected locally but the key targets default', () => {
    const localProject: ActiveProject = { id: 'proj_mail', slug: 'mail' };
    const mismatches = reconcile({
      confirmed: confirmed(), // key really targets the org-default project
      localProject,
    });
    expect(mismatches).toEqual([{ kind: 'project', intended: 'mail', actual: 'default' }]);
  });

  it('flags a project drift the other way: org-default selected, but the key targets a named project', () => {
    const mismatches = reconcile({
      confirmed: confirmed({ project: mailProject, projectId: mailProject.id }),
      localProject: undefined, // intends the org-default
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
        localProject,
      }),
    ).toEqual([]);
  });

  describe('server did not answer (confirmed: null) — degrade, do not falsely accuse', () => {
    it('cannot decide a project drift without a confirmed project id', () => {
      const localProject: ActiveProject = { id: 'proj_mail', slug: 'mail' };
      expect(
        reconcile({ confirmed: null, localProject }),
      ).toEqual([]);
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

  it('asks about intent — never narrates settings or reconciliation mechanics', () => {
    // The click-and-play contract: the header states the ONE target; this note
    // asks "is that what you meant?" and names the matching key as the remedy.
    // Saved-mode bookkeeping and "the key wins" routing explanations are the
    // anti-pattern that confused a real adopter.
    const msg = describeMismatches([
      { kind: 'project', intended: 'mail', actual: 'default' },
    ]);
    expect(msg).toMatch(/^This key acts on/);
    expect(msg).not.toMatch(/key wins|routes the|deploys to|saved|mode is|CLI mode|ablo mode|ablo projects use/);
  });
});
