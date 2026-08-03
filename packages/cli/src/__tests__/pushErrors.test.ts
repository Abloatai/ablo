import { describe, expect, it } from '@jest/globals';
import { schemaPushPlaneHint } from '../push';

describe('schema push 403 diagnostics', () => {
  it('does not misreport a missing sandbox plane as a schema:push denial', () => {
    const hint = schemaPushPlaneHint('test_database_not_registered');
    expect(hint).toContain('already passed schema:push authorization');
    expect(hint).toContain('storage-provisioning error');
    expect(hint).not.toContain('needs schema:push');
  });

  it('leaves unrelated 403 codes to their specific renderer', () => {
    expect(schemaPushPlaneHint('forbidden')).toBeNull();
  });
});
