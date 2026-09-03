/**
 * The semantic drift classifier — pinning the contract that kills the
 * whole-hash weld: additive server changes are SILENCE for deployed clients;
 * real divergence names the exact models.
 */
import { classifySchemaDrift, describeSchemaDrift } from '../schemaDrift.js';

const CLIENT = { items: 'aaaa1111', entries: 'bbbb2222' };

describe('classifySchemaDrift', () => {
  it('aligned when every declared model matches — the server knowing MORE is not drift', () => {
    const finding = classifySchemaDrift(CLIENT, [
      { key: 'items', hash: 'aaaa1111' },
      { key: 'entries', hash: 'bbbb2222' },
      { key: 'mailThreads', hash: 'cccc3333' }, // additive server lead
      { key: 'mailMessages', hash: 'dddd4444' },
    ]);
    expect(finding).toEqual({ kind: 'aligned' });
  });

  it('names models this build declares that the server lacks', () => {
    const finding = classifySchemaDrift(CLIENT, [{ key: 'items', hash: 'aaaa1111' }]);
    expect(finding).toEqual({ kind: 'unpushed', models: ['entries'] });
  });

  it('names shared models whose content differs, carrying any unpushed alongside', () => {
    const finding = classifySchemaDrift(CLIENT, [{ key: 'entries', hash: 'CHANGED0' }]);
    expect(finding).toEqual({ kind: 'changed', models: ['entries'], unpushed: ['items'] });
  });

  it('names field direction when both client and active surfaces expose shape', () => {
    const finding = classifySchemaDrift(
      { entries: 'client' },
      [{ key: 'entries', hash: 'active', fields: { title: { type: 'string', isOptional: false }, status: { type: 'string', isOptional: true } } }],
      { entries: { title: { type: 'string', isOptional: true }, localOnly: { type: 'number', isOptional: false } } },
    );
    expect(finding.kind).toBe('changed');
    if (finding.kind === 'changed') {
      expect((finding.fields ?? []).map(({ model, field, direction }) => ({ model, field, direction }))).toEqual(
        expect.arrayContaining([
          { model: 'entries', field: 'title', direction: 'changed' },
          { model: 'entries', field: 'status', direction: 'active_only' },
          { model: 'entries', field: 'localOnly', direction: 'client_only' },
        ]),
      );
      expect(describeSchemaDrift(finding, 'production')).toContain('entries.title');
    }
  });

  it('unknown when the server surface carries no per-model hashes (older server)', () => {
    const finding = classifySchemaDrift(CLIENT, [{ key: 'items' }, { key: 'entries' }]);
    expect(finding).toEqual({ kind: 'unknown' });
  });

  it('an empty server surface reads as everything-unpushed, not unknown', () => {
    expect(classifySchemaDrift(CLIENT, [])).toEqual({
      kind: 'unpushed',
      models: ['items', 'entries'],
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
      { kind: 'changed', models: ['entries'], unpushed: [] },
      'https://api-staging.example.com/api',
    );
    expect(msg).toContain('entries');
    expect(msg).toContain('ablo status');
    expect(msg).not.toMatch(/hash/i);
  });
});
