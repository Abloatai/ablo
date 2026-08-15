import { assertExpectedBranch, assertExpectedProject } from '../storeLifecycle';

describe('project pin', () => {
  it('accepts the project resolved from the key', () => {
    expect(() => {
      assertExpectedProject('proj_mail', 'proj_mail');
    }).not.toThrow();
  });

  it('fails closed before startup when the key belongs to another project', () => {
    expect(() => {
      assertExpectedProject('proj_mail', 'proj_records');
    }).toThrow(
      /belongs to project proj_records.*pinned to proj_mail/
    );
    try {
      assertExpectedProject('proj_mail', 'proj_records');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'project_scope_denied',
        details: {
          expectedProjectId: 'proj_mail',
          actualProjectId: 'proj_records',
        },
      });
    }
  });

  it('keeps existing clients compatible when no pin is configured', () => {
    expect(() => {
      assertExpectedProject(undefined, 'proj_any');
    }).not.toThrow();
  });

  it('fails closed when a same-project key belongs to another branch', () => {
    expect(() => {
      assertExpectedBranch('br_production', 'br_feature');
    }).toThrow(
      /belongs to branch br_feature.*pinned to br_production/
    );
  });

  it('accepts the exact branch and keeps an absent branch pin compatible', () => {
    expect(() => {
      assertExpectedBranch('br_feature', 'br_feature');
    }).not.toThrow();
    expect(() => {
      assertExpectedBranch(undefined, 'br_feature');
    }).not.toThrow();
  });
});
