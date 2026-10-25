import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbloClaimedError } from '@abloatai/transaction';
import { startResourceAdapter, startResourceClaimGateway, type AdapterWorker } from '../src/index.ts';

test('contention returns promptly without queuing; unavailable errors stay distinct', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'claim-gateway-'));
  let calls = 0;
  const worker: AdapterWorker = { uid: 1001, client: {
    ready: async () => {},
    identity: { organizationId: 'org', projectId: 'project', branchId: 'branch', syncGroups: [],
      operations: [], participantKind: 'agent', participantId: 'a', deliveryPartition: null },
    claims: { acquireResource: async options => {
      calls++;
      assert.equal(options.contention?.mode, 'skip');
      if (options.resource === 'file:unavailable') throw new Error('network failure');
      throw new AbloClaimedError('held', { code: 'claim_conflict' });
    } },
  } };
  const socketPath = join(directory, 'gateway');
  const gateway = await startResourceClaimGateway({ socketPath, workspaceId: 'workspace', workers: [worker] });
  try {
    // Send the supervisor's authenticated envelope over the actual Unix gateway socket.
    const { createConnection } = await import('node:net');
    const request = (resource: string, waitMs?: number) => new Promise<string>((resolve, reject) => {
      const socket = createConnection(socketPath);
      socket.setTimeout(1000, () => socket.destroy(new Error('claim response exceeded one second')));
      let reply = '';
      socket.on('error', reject);
      socket.on('connect', () => socket.write(JSON.stringify({ owner: gateway.registrations[1001], action: waitMs === undefined ? 'claim' : 'wait', resource, waitMs }) + '\n'));
      socket.on('data', chunk => { reply += chunk; });
      socket.on('end', () => { try { resolve(JSON.parse(reply).error.code); } catch (error) { reject(error); } });
    });
    assert.deepEqual(await Promise.all(Array.from({ length: 16 }, () => request('file:held'))), Array(16).fill('claim_conflict'));
    assert.equal(await request('file:unavailable'), 'claim_unavailable');
    assert.ok(calls >= 2);
    const before = calls;
    assert.equal(await request('file:held', 1000), 'realtime_claims_required');
    assert.equal(calls, before, 'HTTP-only wait fell back to polling');
  } finally { await gateway.close(); await rm(directory, { recursive: true, force: true }); }
});

test('realtime claim waits wake on authoritative grant, cancel on disconnect, and keep immediate acquisition free', async () => {
  const { createConnection } = await import('node:net');
  const { setTimeout: delay } = await import('node:timers/promises');
  const directory = await mkdtemp(join(tmpdir(), 'claim-wait-'));
  let acquisitions = 0, releases = 0, cancelled = 0;
  const grants: (() => void)[] = [];
  const worker: AdapterWorker = { uid: 1001, client: {
    ready: async () => {}, subscribe: () => () => {},
    identity: { organizationId: 'org', projectId: 'project', branchId: 'branch', syncGroups: [],
      operations: [], participantKind: 'agent', participantId: 'a', deliveryPartition: null },
    claims: { acquireResource: async options => {
      acquisitions++;
      assert.equal(options.contention?.mode, 'wait');
      await new Promise<void>((resolve, reject) => {
        grants.push(resolve);
        options.contention?.signal?.addEventListener('abort', () => {
          cancelled++; reject(new AbloClaimedError('cancelled', { code: 'claim_wait_aborted' }));
        }, { once: true });
      });
      return { object: 'claim', id: 'grant', target: { type: 'records', id: 'resource' }, description: '', fenceToken: 7,
        heartbeat: async () => ({ expiresAt: Date.now() + 30000 }),
        release: async () => { releases++; }, revoke() {}, async [Symbol.asyncDispose]() {} };
    } },
  } };
  const socketPath = join(directory, 'gateway');
  const gateway = await startResourceClaimGateway({ socketPath, workspaceId: 'workspace', workers: [worker] });
  const send = (action: string, waitMs?: number) => {
    const socket = createConnection(socketPath);
    const reply = new Promise<{ result?: { claim?: string; fence?: number }; error?: { code: string } }>((resolve, reject) => {
      let input = '';
      socket.on('error', reject);
      socket.on('data', chunk => {
        input += chunk;
        while (input.includes('\n')) {
          const offset = input.indexOf('\n'), reply = JSON.parse(input.slice(0, offset)); input = input.slice(offset + 1);
          if (!reply.waiting) resolve(reply);
        }
      });
    });
    socket.write(JSON.stringify({ owner: gateway.registrations[1001], action, resource: 'file:held', waitMs }) + '\n');
    return { socket, reply };
  };
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 2000;
    while (!check()) { assert.ok(Date.now() < deadline, 'gateway did not advance'); await delay(5); }
  };
  try {
    assert.equal((await send('wait', 30001).reply).error?.code, 'request_invalid');
    const first = send('wait', 1000);
    await until(() => acquisitions === 1);
    assert.equal((await send('claim').reply).error?.code, 'claim_pending');
    first.socket.destroy();
    await until(() => cancelled === 1);
    const second = send('wait', 1000);
    await until(() => acquisitions === 2);
    grants[1]();
    assert.equal((await second.reply).result?.fence, 7);
    assert.equal((await send('claim').reply).result?.claim, 'grant');
    assert.equal((await send('wait', 1000).reply).result?.claim, 'grant');
    assert.equal(acquisitions, 2, 'recovering an owned grant reacquired it');
    assert.equal(releases, 0);
  } finally { await gateway.close(); await rm(directory, { recursive: true, force: true }); }
  assert.equal(releases, 1);
});


test('invalid execution budgets fail before creating adapter resources', async () => {
  for (const maxConcurrentProcesses of [0, -1, 1.5, 65, NaN, Infinity]) {
    await assert.rejects(startResourceAdapter({stateDirectory: '/unused', mountpoint: '/unused', socketPath: '/unused', workspaceId: 'unused', workers: [], maxConcurrentProcesses}), /maxConcurrentProcesses must be an integer/);
  }
});

test('project-file authority refresh is explicit, bound, cancellable and bounded', async () => {
  const {createConnection} = await import('node:net');
  const directory = await mkdtemp(join(tmpdir(), 'project-authority-'));
  let validForMs = 30000, revoked = false, calls = 0;
  const operationId = '12345678-1234-1234-1234-123456789abc';
  const worker: AdapterWorker = {uid:1001, projectFiles:{authorize:async context => {
    assert.equal(context.sourceWorkspaceId,'source'); assert.equal(context.workerUid,1001); assert.equal(context.operationId,operationId);
    assert.equal(context.signal.aborted,false); calls++;
    if(revoked) throw new Error('membership revoked');
    return {validForMs};
  }},client:{ready:async()=>{},identity:{organizationId:'org',projectId:'project',branchId:'branch',syncGroups:[],operations:[],participantKind:'agent',participantId:'writer',deliveryPartition:null},claims:{acquireResource:async()=>{throw new Error('authority refresh must not acquire a lease');}}}};
  const reader:AdapterWorker={...worker,uid:1002,projectFiles:undefined,client:{...worker.client,identity:{...worker.client.identity!,participantId:'reader'}}};
  const socketPath=join(directory,'gateway');
  const gateway=await startResourceClaimGateway({socketPath,workspaceId:'source',workers:[worker,reader]});
  const request=(uid=1001, operation: string | null = operationId)=>new Promise<{result?:{expires:number};error?:{code:string}}>((resolve,reject)=>{
    const socket=createConnection(socketPath);let reply='';socket.on('error',reject);
    socket.on('connect',()=>socket.write(JSON.stringify({owner:gateway.registrations[uid],action:'project_authorize',...(operation===null?{}:{operationId:operation})})+'\n'));
    socket.on('data',chunk=>{reply+=chunk});socket.on('end',()=>resolve(JSON.parse(reply)));
  });
  try{
    const lease=await request();assert.ok(lease.result!.expires>Date.now()/1000);assert.ok(lease.result!.expires<=Date.now()/1000+30);
    assert.equal((await request(1002)).error?.code,'permission_denied');assert.equal(calls,1);
    assert.equal((await request(1001, null)).error?.code, 'permission_denied');
    assert.equal((await request(1001, 'wrong')).error?.code, 'permission_denied');
    for(const invalid of [0,NaN,Infinity,60001]){validForMs=invalid;assert.equal((await request()).error?.code,'permission_denied');}
    revoked=true;assert.ok((await request()).error); // No authority on transport/owner failure.
  }finally{await gateway.close();await rm(directory,{recursive:true,force:true});}

});

test('gVisor rejects malformed rootfs configuration before opening a gateway', async () => {
  for (const gvisorRootfs of ['', 'relative/image', '/image\0invalid']) {
    await assert.rejects(startResourceAdapter({stateDirectory: '/unused', mountpoint: '/unused', socketPath: '/unused', workspaceId: 'unused', workers: [], gvisorRootfs}), /gvisorRootfs must be an absolute path/);
  }
});
