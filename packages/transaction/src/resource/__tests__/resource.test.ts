import { describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { createResource, getResourceReceipt, runResourceOperation, ResourceError, type ResourceWorkspace } from '../index.js';
import { resourceClaimId, RESOURCE_CLAIM_MODEL } from '../claimTarget.js';
import { defineSchema, model, z } from '../../schema/index.js';
import { capabilityCanSchemaFor } from '../../auth/capability.js';
import { createAbloHttpClient } from '../../transport/http/client.js';

describe('external resources', () => {
  it('forwards an explicit bounded claim wait without reading or rebasing context', async () => {
    const requests: Readonly<Record<string, unknown>>[] = [];
    const workspace: ResourceWorkspace = { request: async request => {
      requests.push(request);
      return { resource: 'file:source', claim: 'granted', fence: 7, expires: Date.now() / 1000 + 30 };
    } };
    const held = await createResource(workspace, 'source').claim({ waitMs: 2000 });
    expect(requests).toEqual([{ action: 'claim', resource: 'file:source', waitMs: 2000 }]);
    expect(held.fenceToken).toBe(7);
  });
  it('retains signed native evidence without resending dependency contents', async () => {
    const operationId = randomUUID();
    const reads = [{ resource: 'file:source', revision: 1, evidence: 'signed' }];
    let sent: Readonly<Record<string, unknown>> | undefined;
    const workspace: ResourceWorkspace = { request: async request => { sent = request; return { operationId, status: 'applied', reads }; } };
    expect((await runResourceOperation(workspace, { operationId, claims: [], argv: ['cat', 'source'], reads })).reads).toEqual(reads);
    expect(sent?.reads).toEqual([{ resource: 'file:source', evidence: 'signed' }]);
    expect(sent?.claims).toEqual([]);
    expect((await getResourceReceipt(workspace, operationId)).reads).toEqual(reads);
  });

  it('reconciles a lost native reply by receipt without rerunning the command', async () => {
    const operationId = randomUUID();
    let calls = 0;
    const receipt = { operationId, status: 'applied', reads: [{ resource: 'file:source', revision: 1, evidence: 'signed' }] };
    const workspace: ResourceWorkspace = { request: async request => {
      calls++;
      if (request.action === 'run') throw new Error('reply lost after commit');
      return receipt;
    } };
    await expect(runResourceOperation(workspace, { operationId, claims: [], argv: ['cat', 'source'] })).rejects.toMatchObject({ code: 'outcome_unknown', operationId });
    expect(await getResourceReceipt(workspace, operationId)).toEqual(receipt);
    expect(calls).toBe(2);
  });

  it('preserves exact publication witnesses when an applied reply was lost', async () => {
    const operationId = randomUUID();
    const publication = {version: 1, digest: 'a'.repeat(64), paths: ['new'],
      premises: [{path:'new',kind:'file',revision:0}], requests:[{operationId,resource:'file:new'}],
      claims:[{resource:'file:new',claim:'held',fence:7}]};
    const receipt = {operationId,status:'applied',publication};
    const requests: string[] = [];
    const workspace: ResourceWorkspace = {request:async request => {
      requests.push(String(request.action));
      if(request.action === 'run')throw new Error('reply lost');
      return receipt;
    }};
    await expect(runResourceOperation(workspace,{operationId,claims:[],argv:['edit']})).rejects.toMatchObject({code:'outcome_unknown'});
    expect(await getResourceReceipt(workspace,operationId)).toEqual(receipt);
    expect(requests).toEqual(['run','receipt']);
  });

  it('rejects malformed and mismatched recovery receipts', async () => {
    const operationId = randomUUID();
    for (const response of [null, { operationId: randomUUID(), status: 'applied' }]) {
      await expect(getResourceReceipt({ request: async () => response }, operationId)).rejects.toMatchObject({ code: 'outcome_unknown', operationId });
    }
  });

  it('retains actionable stale-context feedback and operation identity', async () => {
    const operationId = randomUUID();
    const workspace: ResourceWorkspace = { request: async () => ({ operationId, status: 'rejected', code: 'stale_context', resources: ['source'] }) };
    await expect(runResourceOperation(workspace, { operationId, claims: [], argv: ['cat', 'source'] })).rejects.toMatchObject({ code: 'stale_context', operationId, resources: ['source'] });
  });

  it('keeps workspace and resource kind distinct in row-free claim identity', async () => {
    const ids = await Promise.all([['a', 'file:source'], ['b', 'file:source'], ['a', 'ref:source']].map(([workspace, resource]) => resourceClaimId(workspace!, resource!)));
    expect(new Set(ids).size).toBe(3);
    expect(await resourceClaimId('a', 'file:source')).toBe(ids[0]);
  });

  it('allows explicit resource capabilities without a coordination model', () => {
    expect(capabilityCanSchemaFor({}).parse({ [RESOURCE_CLAIM_MODEL]: ['update'] })).toEqual({ [RESOURCE_CLAIM_MODEL]: ['update'] });
    expect(() => defineSchema({ [RESOURCE_CLAIM_MODEL]: model({ content: z.string() }) })).toThrow();
    expect(() => defineSchema({ files: model({ content: z.string() }, { tableName: RESOURCE_CLAIM_MODEL }) })).toThrow();
  });

  it('preserves a schema model named resource alongside the new factory', () => {
    const client = createAbloHttpClient({ schema: defineSchema({ resource: model({ content: z.string() }) }), apiKey: 'sk_test', baseURL: 'https://example.test' });
    expect(typeof client.resource).toBe('function');
    expect(typeof client.resource.read).toBe('function');
    expect(typeof client.resource.update).toBe('function');
  });

  it('keeps operation identity when a reply is lost or malformed', async () => {
    const operationId = randomUUID();
    for (const reply of [null, { operationId: randomUUID(), status: 'applied' }, { operationId, status: 'absent' }]) {
      const workspace: ResourceWorkspace = { request: async () => reply };
      await expect(createResource(workspace, 'source').write({ claim: {} as never, reads: [], content: 'new', operationId })).rejects.toMatchObject({ code: 'outcome_unknown', operationId });
    }
    const workspace: ResourceWorkspace = { request: async () => { throw new Error('disconnected'); } };
    await expect(createResource(workspace, 'source').write({ claim: {} as never, reads: [], content: 'new', operationId })).rejects.toBeInstanceOf(ResourceError);
  });

  it('carries signed evidence without resending file contents', async () => {
    let sent: Readonly<Record<string, unknown>> | undefined;
    const operationId = randomUUID();
    const workspace: ResourceWorkspace = { request: async request => { sent = request; return { operationId, status: 'applied' }; } };
    await createResource(workspace, 'source').write({ claim: { resource: 'file:source', id: 'lease' } as never,
      reads: [{ resource: 'file:source', content: 'private content', revision: 1, evidence: 'signed' }], content: 'new', operationId });
    expect(sent?.reads).toEqual([{ resource: 'file:source', evidence: 'signed' }]);
    expect(sent?.claims).toEqual([{ resource: 'file:source', claim: 'lease' }]);
  });
});
