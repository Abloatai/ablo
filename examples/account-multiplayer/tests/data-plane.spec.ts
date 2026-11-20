import { test, expect } from '@playwright/test';
import Ablo from '@abloatai/ablo';
import Sessions from '@abloatai/ablo/sessions';
import { schema } from '../src/schema.js';
import { grantAccount, grantWriter } from '../src/accounts/index.js';

test('scoped SDK clients enforce account and operation boundaries at the data plane', async () => {
  const apiKey = process.env.ABLO_API_KEY;
  if (!apiKey) throw new Error('An isolated branch ABLO_API_KEY is required');
  const baseURL = process.env.ABLO_BASE_URL;
  const issuer = Sessions({ schema, apiKey, baseURL });
  const alice = Ablo({ schema, session: await issuer.create(grantWriter('alice', 'alpha')!), baseURL, transport: 'http' });
  const eve = Ablo({ schema, session: await issuer.create(grantWriter('eve', 'beta')!), baseURL, transport: 'http' });
  const viewer = Ablo({ schema, session: await issuer.create(grantAccount('eve', 'beta')!), baseURL, transport: 'http' });
  try {
    await Promise.all([alice.ready(), eve.ready(), viewer.ready()]);
    const alpha = await alice.conversations.create({ data: {
      accountId: 'alpha', title: 'Alpha authorization canary', executionOwner: null, executionState: 'idle',
    } });
    const beta = await eve.conversations.create({ data: {
      accountId: 'beta', title: 'Beta authorization canary', executionOwner: null, executionState: 'idle',
    } });
    // Positive controls keep a broken connection from counting as authorization denial.
    expect((await eve.conversations.read({ id: beta.id }))?.title).toBe(beta.title);
    expect((await viewer.conversations.read({ id: beta.id }))?.title).toBe(beta.title);
    expect(await eve.conversations.read({ id: alpha.id })).toBeUndefined();
    const hidden = await eve.conversations.list({ where: { id: alpha.id }, type: 'complete' });
    expect([...hidden]).toHaveLength(0);
    await expect(eve.conversations.update({ id: alpha.id, data: { title: 'Forbidden edit' } }))
      .rejects.toMatchObject({ code: 'capability_scope_denied' });
    await expect(eve.conversations.create({ data: {
      accountId: 'alpha', title: 'Forged account', executionOwner: null, executionState: 'idle',
    } })).rejects.toMatchObject({ code: 'capability_scope_denied' });
    await expect(eve.conversations.claim(alpha.id, { contention: { mode: 'skip' }, ttl: '10s' }))
      .rejects.toMatchObject({ code: 'capability_scope_denied' });
    await expect(viewer.conversations.update({ id: beta.id, data: { title: 'Forbidden viewer edit' } }))
      .rejects.toMatchObject({ code: 'capability_scope_denied' });
    await eve.conversations.update({ id: beta.id, data: { title: 'Allowed beta edit' } });
    expect((await viewer.conversations.read({ id: beta.id }))?.title).toBe('Allowed beta edit');
    expect((await alice.conversations.read({ id: alpha.id }))?.title).toBe(alpha.title);
  } finally { await Promise.all([alice.dispose(), eve.dispose(), viewer.dispose()]); }
});
