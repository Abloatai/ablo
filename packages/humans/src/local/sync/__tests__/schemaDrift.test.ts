/**
 * The semantic drift classifier — pinning the contract that kills the
 * whole-hash weld: additive server changes are SILENCE for deployed clients;
 * real divergence names the exact models.
 */
import { classifySchemaDrift, describeSchemaDrift } from '../schemaDrift.js';

const CLIENT = { tasks: 'aaaa1111', slides: 'bbbb2222' };

describe('classifySchemaDrift', () => {
  it('aligned when every declared model matches — the server knowing MORE is not drift', () => {
    const finding = classifySchemaDrift(CLIENT, [
      { key: 'tasks', hash: 'aaaa1111' },
      { key: 'slides', hash: 'bbbb2222' },
      { key: 'mailThreads', hash: 'cccc3333' }, // additive server lead
      { key: 'mailMessages', hash: 'dddd4444' },
    ]);
    expect(finding).toEqual({ kind: 'aligned' });
  });

  it('names models this build declares that the server lacks', () => {
    const finding = classifySchemaDrift(CLIENT, [{ key: 'tasks', hash: 'aaaa1111' }]);
    expect(finding).toEqual({ kind: 'unpushed', models: ['slides'] });
  });

  it('names shared models whose content differs, carrying any unpushed alongside', () => {
    const finding = classifySchemaDrift(CLIENT, [{ key: 'slides', hash: 'CHANGED0' }]);
    expect(finding).toEqual({ kind: 'changed', models: ['slides'], unpushed: ['tasks'] });
  });

  it('unknown when the server surface carries no per-model hashes (older server)', () => {
    const finding = classifySchemaDrift(CLIENT, [{ key: 'tasks' }, { key: 'slides' }]);
    expect(finding).toEqual({ kind: 'unknown' });
  });

  it('an empty server surface reads as everything-unpushed, not unknown', () => {
    expect(classifySchemaDrift(CLIENT, [])).toEqual({
      kind: 'unpushed',
      models: ['tasks', 'slides'],
    });
  });
});

describe('describeSchemaDrift', () => {
  it('unpushed: names the models and the push as the one next step — never hashes', () => {
    const msg = describeSchemaDrift(
      { kind: 'unpushed', models: ['mailThreads', 'mailMessages'] },
      'https://api-staging.example.com/api',
    );
    expect(msg).toContain('mailThreads, mailMessages');
    expect(msg).toContain('ablo push');
    expect(msg).not.toMatch(/hash/i);
  });

  it('changed: names the models and points at ablo status for the deployed shape', () => {
    const msg = describeSchemaDrift(
      { kind: 'changed', models: ['slides'], unpushed: [] },
      'https://api-staging.example.com/api',
    );
    expect(msg).toContain('slides');
    expect(msg).toContain('ablo status');
    expect(msg).not.toMatch(/hash/i);
  });
});
