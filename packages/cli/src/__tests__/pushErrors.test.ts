import { describe, expect, it } from '@jest/globals';
import { schemaPushStorageHint } from '../push';

describe('schema push 403 diagnostics', () => {
  it('leaves unrelated 403 codes to their specific renderer', () => {
    expect(schemaPushStorageHint('forbidden')).toBeNull();
  });

  it('explains an unconnected branch without internal storage vocabulary', () => {
    const hint = schemaPushStorageHint('no_data_source_registered');
    expect(hint).toContain('not connected to your database yet');
    expect(hint).toContain('ablo connect');
    expect(hint).not.toContain('unbound');
    expect(hint).not.toContain('plane');
  });
});
