import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createResource, getResourceReceipt, runResourceOperation, type ResourceWorkspace, type ResourceClaim} from '@abloatai/transaction';

type Fixture = {a: ResourceWorkspace; b: ResourceWorkspace; claim(workspace: ResourceWorkspace, path: string): Promise<ResourceClaim>};
const counters = async (directory: string, file: string) => Object.fromEntries((await readFile(join(directory, file), 'utf8')).trim().split('\n').map(line => {const [name, value] = line.split(' '); return [name, Number(value)];}));
const outcome = <T>(promise: Promise<T>) => promise.then(value => ({ok: true as const, value}), error => ({ok: false as const, error: error.code ?? String(error)}));

export async function verifyGvisorMemoryIsolation(f: Fixture, cgroup: string) {
  const before = await counters(cgroup, 'memory.events');
  const root = join(cgroup, '..');
  const parentBefore = await counters(root, 'memory.events.local');
  const claims = await Promise.all([f.claim(f.a, 'alpha'), f.claim(f.b, 'beta')]);
  const allocatorId = randomUUID(), peerId = randomUUID();
  const allocator = outcome(runResourceOperation(f.a, {operationId: allocatorId, claims: [claims[0]], timeoutMs: 15000,
    argv: ['/usr/local/bin/node', '-e', "const fs=require('fs');fs.writeFileSync('alpha','UNACCEPTED_PRESSURE');const retained=[];for(let n=0;n<32;n++){retained.push(Buffer.alloc(64*1024*1024,7));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);}setTimeout(()=>{},20000);"]}));
  const peer = outcome(runResourceOperation(f.b, {operationId: peerId, claims: [claims[1]], timeoutMs: 20000,
    argv: ['/usr/local/bin/node', '-e', "const fs=require('fs');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000);fs.writeFileSync('beta','HEALTHY_UNDER_PRESSURE');console.log('HEALTHY_UNDER_PRESSURE');"]}));
  const [allocated, healthy] = await Promise.all([allocator, peer]);
  assert.equal(allocated.ok, false); assert.equal(healthy.ok, true);
  const rejected = await getResourceReceipt(f.a, allocatorId), accepted = await getResourceReceipt(f.b, peerId);
  assert.equal(rejected.status, 'rejected'); assert.equal(rejected.code, 'command_failed'); assert.equal(accepted.status, 'applied');
  assert.equal((await createResource(f.a, 'alpha').read()).content, 'BASE');
  assert.equal((await createResource(f.b, 'beta').read()).content, 'HEALTHY_UNDER_PRESSURE');
  const after = await counters(cgroup, 'memory.events'), local = await counters(cgroup, 'memory.events.local');
  assert.ok(after.oom_kill > before.oom_kill, 'the allocating job must hit its kernel cgroup limit');
  assert.equal(local.oom_kill, 0, 'the jobs aggregate must not OOM');
  assert.equal((await counters(root, 'memory.events.local')).oom_kill, parentBefore.oom_kill, 'the controller parent must not OOM');

  // Killing the trusted launcher skips its finally; the daemon must still drain the job cgroup.
  const killedId = randomUUID();
  const interrupted = outcome(runResourceOperation(f.a, {operationId: killedId, claims: [claims[0]], timeoutMs: 20000,
    argv: ['/usr/local/bin/node', '-e', "const fs=require('fs');fs.writeFileSync('alpha','UNACCEPTED_KILL');fs.writeFileSync(process.env.TMPDIR+'/active','ACTIVE');setTimeout(()=>{},30000);"]}));
  const deadline = Date.now() + 15000;
  let killed = false;
  while (!killed && Date.now() < deadline) {
    for (const entry of await readdir(cgroup, {withFileTypes: true})) {
      if (!entry.isDirectory()) continue;
      for (const pid of (await readFile(join(cgroup, entry.name, 'cgroup.procs'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)) {
        try {
          const command = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
          if (!command[1]?.endsWith('/linux/gvisor.py')) continue;
          const status = await readFile(`/proc/${pid}/status`, 'utf8'), parent = /^PPid:\s+(\d+)$/m.exec(status)?.[1];
          if (!parent) continue;
          const parentCommand = (await readFile(`/proc/${parent}/cmdline`, 'utf8')).split('\0');
          if (parentCommand[1] !== command[1] || parentCommand[2] !== command[2] || parentCommand[5] !== join(cgroup, entry.name)) continue;
          const config = JSON.parse(await readFile(join(command[3]!, 'config.json'), 'utf8'));
          const home = config.process.env.find((value: string) => value.startsWith('TMPDIR=')).slice(7);
          if (await readFile(join(home, 'active'), 'utf8').catch(() => '') !== 'ACTIVE') continue;
          const start = (await readFile(`/proc/${parent}/stat`, 'utf8')).split(')').at(-1)!.trim().split(' ')[19]!;
          execFileSync('python3', ['-c', 'import os,signal,sys; p=int(sys.argv[1]); fd=os.pidfd_open(p); assert open("/proc/"+str(p)+"/stat").read().rsplit(")",1)[1].split()[19]==sys.argv[2]; signal.pidfd_send_signal(fd,signal.SIGKILL)', parent, start]);
          killed = true; break;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      if (killed) break;
    }
    if (!killed) await delay(10);
  }
  assert.equal(killed, true, 'the test must kill an active owned launcher');
  assert.equal((await interrupted).ok, false);
  assert.equal((await getResourceReceipt(f.a, killedId)).status, 'rejected');
  assert.equal((await createResource(f.a, 'alpha').read()).content, 'BASE');
  const final = await runResourceOperation(f.b, {operationId: randomUUID(), claims: [], argv: ['cat', 'beta']});
  assert.equal(final.status, 'applied'); assert.equal(final.output, 'HEALTHY_UNDER_PRESSURE');
  assert.deepEqual((await readdir(cgroup, {withFileTypes: true})).filter(entry => entry.isDirectory()), []);
  return {allocator: rejected.status, peer: accepted.status, alpha: 'BASE', beta: 'HEALTHY_UNDER_PRESSURE',
    descendantOomKills: after.oom_kill - before.oom_kill, aggregateOomKills: local.oom_kill, helperKilled: killed,
    helperKillReceipt: 'rejected', controllerAlive: true, finalPeer: final.status, remainingJobCgroups: 0};
}
