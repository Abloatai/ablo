import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, mkdir, writeFile, chmod, rm, access } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';
import { Ablo, createResource, runResourceOperation, getResourceReceipt, getResourceChanges, ResourceError,
  type HeldLease, type ResourceClaim, type ResourceWorkspace } from '@abloatai/transaction';
import { defineSchema } from '@abloatai/transaction/schema';
import { connectResourceWorkspace, startResourceAdapter, startResourceProcess, type AdapterWorker } from '../src/index.ts';

let input = '';
if (process.env.ABLO_ADAPTER_LIVE === '1') for await (const chunk of process.stdin) input += chunk.toString();
const live = input.trim() ? JSON.parse(input) : null;
if (live?.caPem) setDefaultCACertificates([...getCACertificates('default'), live.caPem]);
const schema = defineSchema({});
const clients = live ? live.apiKeys.map((apiKey: string) => Ablo({ schema, apiKey, baseURL: live.baseURL, transport: 'http' })) : [];
let fence = 0;
const grants = new Map<string, { owner: string; id: string; expires: number }>();
const identity = (owner: string) => ({ organizationId: 'tenant', projectId: 'project', branchId: 'branch', syncGroups: [],
  operations: [], participantKind: 'agent' as const, participantId: owner, deliveryPartition: null });
const workers: AdapterWorker[] = [1001, 1002].map((uid, index) => {
  const client = clients[index];
  const owner = `worker-${uid}`;
  return client ? { uid, client } : {
    uid, client: { ready: async () => {}, identity: identity(owner), claims: {
    acquireResource: async options => {
      const id = JSON.stringify([options.workspaceId, options.resource]);
      const previous = grants.get(id);
      if (previous && previous.expires > Date.now() && previous.owner !== owner) throw new ResourceError('claim_conflict');
      const grant = { owner, id: randomUUID(), expires: Date.now() + Number(options.ttl) * 1000 };
      grants.set(id, grant);
      const held: HeldLease = { object: 'claim', id: grant.id, target: { type: 'records', id }, description: 'test', fenceToken: ++fence,
        heartbeat: async ttl => {
          if (grants.get(id) !== grant || grant.expires <= Date.now()) throw new ResourceError('claim_lost');
          grant.expires = Date.now() + (typeof ttl === 'number' ? ttl : 30) * 1000;
          return { expiresAt: grant.expires };
        },
        release: async () => { if (grants.get(id) === grant) grants.delete(id); }, revoke: () => { if (grants.get(id) === grant) grants.delete(id); },
        async [Symbol.asyncDispose]() { if (grants.get(id) === grant) grants.delete(id); },
      };
      return held;
    },
    } },
  };
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ablo-adapter-test-'));
  await chmod(root, 0o755);
  const seed = join(root, 'seed'), mountpoint = join(root, 'workspace'), socketPath = join(root, 'public', 'workspace.sock');
  await mkdir(seed); await mkdir(join(root, 'public'), { mode: 0o755 });
  await writeFile(join(seed, 'alpha'), 'BASE'); await writeFile(join(seed, 'beta'), 'BASE');
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
  const git = (args: string[]) => execFileSync('git', args, { cwd: seed, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
  git(['init', '-b', 'main']); git(['config', 'core.createObject', 'rename']); git(['add', '.']); git(['commit', '-m', 'base']);
  const base = git(['rev-parse', 'HEAD']);
  git(['checkout', '-b', 'incoming']); await writeFile(join(seed, 'alpha'), 'INCOMING'); git(['add', 'alpha']); git(['commit', '-m', 'incoming']);
  const incoming = git(['rev-parse', 'HEAD']); git(['checkout', 'main']);
  const options = { stateDirectory: join(root, 'state'), mountpoint, socketPath, workspaceId: randomUUID(), seedDirectory: seed, workers };
  let adapter = await startResourceAdapter(options);
  const a = connectResourceWorkspace(socketPath, { workerUid: 1001, timeoutMs: 10000 }), b = connectResourceWorkspace(socketPath, { workerUid: 1002, timeoutMs: 10000 });
  if (live) {
    assert.equal((await clients[0].resource(a, 'alpha').read()).content, 'BASE');
    await assert.rejects(clients[1].resource(a, 'alpha').read(), { code: 'permission_denied' });
  }
  const handles: ResourceClaim[] = [];
  const claim = async (workspace: ResourceWorkspace, path: string | { kind: 'ref'; name: string }) => {
    const held = await createResource(workspace, path).claim(); handles.push(held); return held;
  };
  return { root, a, b, claim, mountpoint, base, incoming, options, get adapter() { return adapter; },
    async restart() { await adapter.close(); adapter = await startResourceAdapter(options); },
    async close() { await adapter.close(); await rm(root, { recursive: true, force: true }); } };
}

test('real kernel boundary denies native writes outside an operation', async () => {
  const f = await fixture();
  try {
    await f.claim(f.a, 'alpha');
    assert.throws(() => execFileSync('setpriv', ['--reuid', '1002', '--regid', '1002', '--clear-groups', 'sh', '-c', `printf BYPASS > '${f.mountpoint}/alpha'`], { stdio: 'pipe' }));
    assert.equal((await createResource(f.a, 'alpha').read()).content, 'BASE');
  } finally { await f.close(); }
});

test('kernel peer credentials reject a forged worker identity', async () => {
  const f = await fixture();
  try {
    const program = 'import socket,json,sys; s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); s.sendall(json.dumps({"action":"read","resource":"file:alpha","workerUid":1001}).encode()+b"\\n"); print(s.makefile().readline())';
    const reply = execFileSync('setpriv', ['--reuid', '1002', '--regid', '1002', '--clear-groups', 'python3', '-c', program, join(f.root, 'public', 'workspace.sock')], { encoding: 'utf8' });
    assert.equal(JSON.parse(reply).error.code, 'permission_denied');
  } finally { await f.close(); }
});

test('writable mmap cannot bypass publication checks', async () => {
  const f = await fixture();
  try {
    const claim = await f.claim(f.a, 'alpha');
    await assert.rejects(runResourceOperation(f.a, { claims: [claim], argv: ['python3', '-c', 'import mmap; f=open("alpha","r+b"); m=mmap.mmap(f.fileno(),0); m[:]=b"EVIL"'] }), { code: 'command_failed' });
    assert.equal((await createResource(f.a, 'alpha').read()).content, 'BASE');
  } finally { await f.close(); }
});

test('a second supervisor cannot replace the live claim gateway', async () => {
  const f = await fixture();
  try {
    await assert.rejects(startResourceAdapter(f.options), /already running/);
    const claim = await f.claim(f.a, 'alpha');
    await createResource(f.a, 'alpha').write({ claim, reads: [await createResource(f.a, 'alpha').read()], content: 'STILL LIVE' });
    assert.equal((await createResource(f.a, 'alpha').read()).content, 'STILL LIVE');
  } finally { await f.close(); }
});

test('worker environment is applied only after supervisor privileges are dropped', async () => {
  const f = await fixture();
  try {
    const poison = join(f.root, 'poison'), marker = join(f.root, 'privileged-marker');
    await mkdir(poison);
    await writeFile(join(poison, 'unshare'), `#!/bin/sh\nprintf ROOT > '${marker}'\nexec /usr/bin/unshare "$@"\n`, { mode: 0o755 });
    const claim = await f.claim(f.a, 'alpha');
    await runResourceOperation(f.a, { claims: [claim], env: { PATH: `${poison}:/usr/bin:/bin` }, argv: ['/bin/sh', '-c', 'printf SAFE > alpha'] });
    await assert.rejects(access(marker));
    assert.equal((await createResource(f.a, 'alpha').read()).content, 'SAFE');
  } finally { await f.close(); }
});

test('native writes stay private until one durable publication', async () => {
  const f = await fixture();
  try {
    const claim = await f.claim(f.a, 'alpha'), before = await createResource(f.a, 'alpha').read();
    const running = runResourceOperation(f.a, { claims: [claim], reads: [before], argv: ['sh', '-c', 'printf PART > alpha; sleep .3; printf DONE >> alpha; printf TOOL-OUTPUT'] });
    await delay(150);
    assert.equal((await createResource(f.b, 'alpha').read()).content, 'BASE');
    const receipt = await running;
    assert.equal(receipt.status, 'applied');
    assert.equal(receipt.output, 'TOOL-OUTPUT');
    assert.equal((await createResource(f.a, 'alpha').read()).content, 'PARTDONE');
  } finally { await f.close(); }
});

test('cached API reads cannot overwrite newer content after reacquisition', async () => {
  const f = await fixture();
  try {
    const old = await createResource(f.a, 'alpha').read();
    const first = await f.claim(f.a, 'alpha'); await first.release();
    const peer = await f.claim(f.b, 'alpha');
    await createResource(f.b, 'alpha').write({ claim: peer, reads: [await createResource(f.b, 'alpha').read()], content: 'NEW' });
    await peer.release();
    const replacement = await f.claim(f.a, 'alpha');
    await assert.rejects(runResourceOperation(f.a, { claims: [replacement], reads: [old], argv: ['sh', '-c', 'printf BASE > alpha'] }), { code: 'stale_context' });
    assert.equal((await createResource(f.a, 'alpha').read()).content, 'NEW');
  } finally { await f.close(); }
});

test('takeover rejects the previous owner’s staged operation and open descriptor', async () => {
  const f = await fixture();
  try {
    const old = await f.claim(f.a, 'alpha');
    const running = runResourceOperation(f.a, { claims: [old], argv: ['sh', '-c', 'exec 3>alpha; printf OLD >&3; sleep .5; printf LATE >&3'] });
    const rejected = assert.rejects(running);
    await delay(200); await old.release();
    const peer = await f.claim(f.b, 'alpha');
    await createResource(f.b, 'alpha').write({ claim: peer, reads: [await createResource(f.b, 'alpha').read()], content: 'REPLACEMENT' });
    await rejected;
    assert.equal((await createResource(f.b, 'alpha').read()).content, 'REPLACEMENT');
  } finally { await f.close(); }
});

test('a killed native edit never publishes its partial bytes', async () => {
  const f = await fixture();
  try {
    const claim = await f.claim(f.a, 'alpha');
    await assert.rejects(runResourceOperation(f.a, { claims: [claim], argv: ['sh', '-c', 'printf PART > alpha; kill -KILL $$'] }), { code: 'command_failed' });
    assert.equal((await createResource(f.a, 'alpha').read()).content, 'BASE');
  } finally { await f.close(); }
});

test('same-owner concurrent native edits have exactly one publication', async () => {
  const f = await fixture();
  try {
    const claim = await f.claim(f.a, 'alpha'), before = await createResource(f.a, 'alpha').read();
    const results = await Promise.allSettled(['ONE', 'TWO'].map(content => runResourceOperation(f.a, { claims: [claim], reads: [before], argv: ['sh', '-c', `printf ${content} > alpha; sleep .2`] })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.ok(['ONE', 'TWO'].includes((await createResource(f.a, 'alpha').read()).content!));
  } finally { await f.close(); }
});

test('expired ownership rejects old writes before a replacement becomes active', async () => {
  const f = await fixture();
  try {
    const file = createResource(f.a, 'alpha');
    const old = await file.claim({ ttl: '2s' });
    const before = await file.read();
    await delay(2100);
    const replacement = await f.claim(f.b, 'alpha');
    await assert.rejects(file.write({ claim: old, reads: [before], content: 'LATE' }), { code: 'claim_lost' });
    await createResource(f.b, 'alpha').write({ claim: replacement, reads: [await createResource(f.b, 'alpha').read()], content: 'NEW OWNER' });
    assert.equal((await file.read()).content, 'NEW OWNER');
  } finally { await f.close(); }
});

test('native rename and deletion require every affected file claim', async () => {
  const f = await fixture();
  try {
    const alpha = await f.claim(f.a, 'alpha');
    await assert.rejects(runResourceOperation(f.a, { claims: [alpha], argv: ['mv', 'alpha', 'beta'] }));
    assert.equal((await createResource(f.a, 'alpha').read()).content, 'BASE');
    const beta = await f.claim(f.a, 'beta');
    await runResourceOperation(f.a, { claims: [alpha, beta], argv: ['sh', '-c', 'mv alpha beta; rm beta'] });
    assert.equal((await createResource(f.a, 'alpha').read()).content, null);
    assert.equal((await createResource(f.a, 'beta').read()).content, null);
  } finally { await f.close(); }
});

test('native dependency evidence is not replaced by a newer read', async () => {
  const f = await fixture();
  try {
    const claim = await f.claim(f.a, 'alpha'), peer = await f.claim(f.b, 'beta');
    const running = runResourceOperation(f.a, { claims: [claim], argv: ['sh', '-c', 'cat beta > "$TMPDIR/old"; sleep .5; cat beta; printf OLD > alpha'] });
    const rejected = assert.rejects(running, { code: 'stale_context' });
    await delay(200);
    await createResource(f.b, 'beta').write({ claim: peer, reads: [await createResource(f.b, 'beta').read()], content: 'CHANGED' });
    await rejected;
    assert.equal((await createResource(f.a, 'alpha').read()).content, 'BASE');
  } finally { await f.close(); }
});

test('ordinary native Git commits publish refs and files under their claims', async () => {
  const f = await fixture();
  try {
    const file = createResource(f.a, 'alpha'), ref = createResource(f.a, { kind: 'ref', name: 'refs/heads/main' });
    const claims = [await f.claim(f.a, 'alpha'), await f.claim(f.a, { kind: 'ref', name: 'refs/heads/main' })];
    const result = await runResourceOperation(f.a, { claims, reads: [await file.read(), await ref.read()],
      argv: ['sh', '-c', 'printf EDIT > alpha; git add alpha; git -c user.name=Fixture -c user.email=fixture@example.test commit -m native'] });
    assert.equal(result.status, 'applied');
    assert.equal((await file.read()).content, 'EDIT');
    assert.notEqual((await ref.read()).content, f.base);
    const firstCommit = (await ref.read()).content;
    await file.write({ claim: claims[0]!, reads: [await file.read()], content: 'SAME' });
    await runResourceOperation(f.a, { claims, reads: [await file.read(), await ref.read()],
      argv: ['sh', '-c', 'git add alpha; git -c user.name=Fixture -c user.email=fixture@example.test commit -m same-size'] });
    assert.notEqual((await ref.read()).content, firstCommit);

  } finally { await f.close(); }
});

test('incoming native Git updates respect peer file claims', async () => {
  const f = await fixture();
  try {
    const ref = createResource(f.a, { kind: 'ref', name: 'refs/heads/main' });
    const claim = await f.claim(f.a, { kind: 'ref', name: 'refs/heads/main' });
    const peer = await f.claim(f.b, 'alpha');
    await assert.rejects(runResourceOperation(f.a, { claims: [claim], argv: ['git', 'merge', '--ff-only', 'incoming'] }));
    assert.equal((await ref.read()).content, f.base);
    assert.equal((await createResource(f.a, 'alpha').read()).content, 'BASE');
    await peer.release();
    await runResourceOperation(f.a, { claims: [claim], reads: [await ref.read()], argv: ['git', 'merge', '--ff-only', 'incoming'] });
    assert.equal((await ref.read()).content, f.incoming);
    assert.equal((await createResource(f.a, 'alpha').read()).content, 'INCOMING');
  } finally { await f.close(); }
});

test('ref-only native Git updates also respect affected file claims', async () => {
  const f = await fixture();
  try {
    const claim = await f.claim(f.a, { kind: 'ref', name: 'refs/heads/main' });
    await f.claim(f.b, 'alpha');
    await assert.rejects(runResourceOperation(f.a, { claims: [claim], argv: ['git', 'update-ref', 'refs/heads/main', f.incoming, f.base] }), { code: 'claim_conflict' });
    assert.equal((await createResource(f.a, { kind: 'ref', name: 'refs/heads/main' }).read()).content, f.base);
  } finally { await f.close(); }
});

test('obsolete expected Git commits reject without moving the ref', async () => {
  const f = await fixture();
  try {
    const ref = createResource(f.a, { kind: 'ref', name: 'refs/heads/main' });
    const claim = await f.claim(f.a, { kind: 'ref', name: 'refs/heads/main' });
    await assert.rejects(runResourceOperation(f.a, { claims: [claim], argv: ['git', 'update-ref', 'refs/heads/main', f.incoming, f.incoming] }));
    assert.equal((await ref.read()).content, f.base);
  } finally { await f.close(); }
});

test('lost write replies reconcile through durable receipts across daemon restart', async () => {
  const f = await fixture();
  try {
    const file = createResource(f.a, 'alpha'), claim = await f.claim(f.a, 'alpha'), operationId = randomUUID();
    const lost: ResourceWorkspace = { request: async request => { const result = await f.a.request(request); if (request.action === 'write') throw new Error('lost reply'); return result; } };
    await assert.rejects(createResource(lost, 'alpha').write({ claim, reads: [await file.read()], content: 'ONCE', operationId }), { code: 'outcome_unknown', operationId });
    assert.equal((await getResourceReceipt(f.a, operationId)).status, 'applied');
    await f.restart();
    assert.equal((await getResourceReceipt(f.a, operationId)).status, 'applied');
    assert.equal((await file.read()).content, 'ONCE');
    await assert.rejects(file.write({ claim, reads: [await file.read()], content: 'OLD' }), { code: 'claim_lost' });
  } finally { await f.close(); }
});

test('adapter process death aborts staged work instead of replaying it', async () => {
  const f = await fixture();
  try {
    const claim = await f.claim(f.a, 'alpha'), operationId = randomUUID();
    const running = runResourceOperation(f.a, { claims: [claim], operationId, argv: ['sh', '-c', 'printf PART > alpha; sleep 5'] });
    const unknown = assert.rejects(running, { code: 'outcome_unknown', operationId });
    await delay(250); f.adapter.process.kill('SIGKILL'); await unknown;
    await f.restart();
    assert.equal((await getResourceReceipt(f.a, operationId)).status, 'aborted');
    assert.equal((await createResource(f.a, 'alpha').read()).content, 'BASE');
  } finally { await f.close(); }
});

test('notifications identify stale reads and tell the caller to reread', async () => {
  const f = await fixture();
  try {
    const file = createResource(f.a, 'alpha'), claim = await f.claim(f.a, 'alpha'), before = await file.read();
    await file.write({ claim, reads: [before], content: 'CHANGED' });
    const changes = await getResourceChanges(f.a, { reads: [before] });
    assert.deepEqual(changes.stale, [{ resource: 'file:alpha', action: 'reread' }]);
    assert.ok(changes.cursor > 0);
    assert.equal((await getResourceChanges(f.a, { after: changes.cursor })).events.length, 0);
  } finally { await f.close(); }
});

after(async () => { await Promise.all(clients.map((client: ReturnType<typeof Ablo<typeof schema.models>>) => client.dispose())); });

const interactiveProgram = `import os,sys,json,subprocess,socket
scratch=socket.socket(socket.AF_UNIX)
scratch.bind(os.environ["TMPDIR"]+"/bridge.sock")
print(json.dumps({"home":os.environ["HOME"],"history":open(os.environ["HOME"]+"/history").read() if os.path.exists(os.environ["HOME"]+"/history") else None,"flushed":os.path.exists(os.environ["HOME"]+"/flushed")}),flush=True)
for line in sys.stdin:
 value=json.loads(line)
 if value.get("content"):
  open("alpha","w").write(value["content"])
  open(os.environ["HOME"]+"/history","w").write(value["content"])
 if value.get("read"):
  value["read"]=open("alpha").read()
 if value.get("detach"):
  subprocess.Popen(["sh","-c","exec 3>>\\\"$HOME/history\\\"; sleep .5; printf LATE >&3; touch "+value["detach"]],start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 print(json.dumps(value),flush=True)
open(os.environ["HOME"]+"/flushed","w").write("yes")
`;

test('duplex native turns publish only after trusted completion and restore owner-bound history', async () => {
  const f = await fixture();
  try {
    const claim = await f.claim(f.a, 'alpha'), profileId = randomUUID(), operationId = randomUUID();
    const child = await startResourceProcess(f.a, { operationId, profileId, claims: [claim], argv: ['python3', '-u', '-c', interactiveProgram] });
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    assert.equal(JSON.parse((await lines.next()).value!).history, null);
    child.stdin.write(JSON.stringify({ content: 'TURN_ONE' }) + '\n');
    assert.equal(JSON.parse((await lines.next()).value!).content, 'TURN_ONE');
    assert.equal((await createResource(f.a, 'alpha').read()).content, 'BASE');
    const busy = startResourceProcess(f.a, { operationId: randomUUID(), profileId, claims: [], argv: ['true'] });
    await assert.rejects(busy, { code: 'profile_busy' });
    const marker = `/tmp/ablo-profile-child-${randomUUID()}`;
    child.stdin.write(JSON.stringify({ detach: marker }) + '\n');
    await lines.next();
    const receipt = await child.complete();
    assert.equal(receipt.status, 'applied');
    assert.deepEqual(await child.complete(), receipt);
    assert.deepEqual(await getResourceReceipt(f.a, operationId), receipt);
    assert.equal((await createResource(f.a, 'alpha').read()).content, 'TURN_ONE');
    await delay(700);
    await assert.rejects(access(marker), { code: 'ENOENT' });
    await assert.rejects(startResourceProcess(f.a, { operationId, profileId, claims: [claim], argv: ['python3', '-u', '-c', interactiveProgram] }));
    await assert.rejects(startResourceProcess(f.b, { operationId: randomUUID(), profileId, claims: [], argv: ['true'] }), { code: 'permission_denied' });
    await f.restart();
    const next = await startResourceProcess(f.a, { operationId: randomUUID(), profileId, claims: [], argv: ['python3', '-u', '-c', interactiveProgram] });
    next.stderr.resume();
    const output = createInterface({ input: next.stdout })[Symbol.asyncIterator]();
    const resumed = JSON.parse((await output.next()).value!);
    assert.equal(resumed.history, 'TURN_ONE');
    assert.equal(resumed.flushed, true);
    next.stdin.write(JSON.stringify({ read: true }) + '\n');
    assert.equal(JSON.parse((await output.next()).value!).read, 'TURN_ONE');
    assert.equal((await next.complete()).status, 'applied');
  } finally { await f.close(); }
});

test('duplex abort and deadline retain evidence and discard staged writes', async () => {
  const f = await fixture();
  try {
    const claim = await f.claim(f.a, 'alpha');
    for (const timeout of [false, true]) {
      const operationId = randomUUID();
      const child = await startResourceProcess(f.a, { operationId, profileId: randomUUID(), claims: [claim],
        argv: ['python3', '-u', '-c', interactiveProgram], timeoutMs: timeout ? 600 : 10000 });
      child.stderr.resume();
      const output = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
      await output.next();
      child.stdin.write(JSON.stringify({ content: 'UNPUBLISHED' }) + '\n');
      await output.next();
      const receipt = timeout ? await child.completed : await child.abort();
      assert.equal(receipt.status, 'rejected');
      assert.equal(receipt.code, timeout ? 'command_timeout' : 'operation_interrupted');
      assert.ok(receipt.reads?.some(read => read.resource === 'file:alpha'));
      assert.equal((await createResource(f.a, 'alpha').read()).content, 'BASE');
      assert.deepEqual(await getResourceReceipt(f.a, operationId), receipt);
      await assert.rejects(runResourceOperation(f.a, {claims: [claim], reads: receipt.reads,
        argv: ['sh', '-c', 'printf BASED_ON_UNPUBLISHED > alpha']}), {code: 'stale_context'});
    }
  } finally { await f.close(); }
});

test('native claim-free reads return durable evidence without granting writes', async () => {
  const f = await fixture();
  try {
    const operationId = randomUUID();
    const read = await runResourceOperation(f.a, {operationId, claims: [], argv: ['sh', '-c', 'cat alpha; test ! -e missing']});
    assert.equal(read.output, 'BASE');
    assert.ok(read.reads?.some(value => value.resource === 'file:alpha'));
    assert.ok(read.reads?.some(value => value.resource === 'file:missing'));
    await assert.rejects(runResourceOperation(f.a, {claims: [], argv: ['sh', '-c', 'printf BYPASS > alpha']}), {code: 'command_failed'});
    await assert.rejects(runResourceOperation(f.a, {claims: [], argv: ['git', 'update-ref', 'refs/heads/main', f.incoming]}), {code: 'command_failed'});
    assert.equal((await createResource(f.a, 'alpha').read()).content, 'BASE');
    await f.restart();
    assert.deepEqual(await getResourceReceipt(f.a, operationId), read);
  } finally {await f.close();}
});

test('native evidence rejects stale context after reacquisition without rebasing', async () => {
  const f = await fixture();
  try {
    const old = await runResourceOperation(f.a, {claims: [], argv: ['cat', 'alpha']});
    const peer = await f.claim(f.b, 'alpha');
    await runResourceOperation(f.b, {claims: [peer], argv: ['sh', '-c', 'printf PEER > alpha']});
    await peer.release();
    const mine = await f.claim(f.a, 'alpha');
    const rejectedId = randomUUID();
    await assert.rejects(runResourceOperation(f.a, {operationId: rejectedId, claims: [mine], reads: old.reads, argv: ['sh', '-c', 'printf OLD > alpha']}), {code: 'stale_context'});
    const rejected = await getResourceReceipt(f.a, rejectedId);
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.code, 'stale_context');
    assert.deepEqual(rejected.reads, old.reads);
    assert.equal((await createResource(f.a, 'alpha').read()).content, 'PEER');
    const stale = await getResourceChanges(f.a, {reads: old.reads});
    assert.ok(stale.stale.some(value => value.resource === 'file:alpha' && value.action === 'reread'));
    const fresh = await runResourceOperation(f.a, {claims: [], argv: ['cat', 'alpha']});
    await runResourceOperation(f.a, {claims: [mine], reads: fresh.reads, argv: ['sh', '-c', 'printf REGENERATED > alpha']});
    assert.equal((await createResource(f.a, 'alpha').read()).content, 'REGENERATED');
  } finally {await f.close();}
});

test('native scratch directory cleanup publishes no phantom changes and keeps prior reads usable', async () => {
  const f = await fixture();
  try {
    const scratch = await f.claim(f.a, 'scratch'), nested = await f.claim(f.a, 'scratch/file');
    const before = await runResourceOperation(f.a, {claims: [], argv: ['sh', '-c', 'ls .; test ! -e scratch']});
    const receipt = await runResourceOperation(f.a, {claims: [scratch, nested], reads: before.reads,
      argv: ['sh', '-c', 'mkdir scratch; printf transient > scratch/file; if rmdir scratch; then exit 1; fi; rm scratch/file; rmdir scratch']});
    assert.deepEqual(receipt.resources, []);
    const changes = await getResourceChanges(f.a, {reads: before.reads});
    assert.deepEqual(changes.stale, []);
    assert.deepEqual(changes.events, []);
    await runResourceOperation(f.a, {claims: [], reads: before.reads, argv: ['true']});
  } finally {await f.close();}
});

test('completion kills detached children retaining writable descriptors', async () => {
  const f = await fixture();
  const marker = `/tmp/ablo-escaped-${randomUUID()}`;
  try {
    const held = await f.claim(f.a, 'alpha');
    await runResourceOperation(f.a, {claims: [held], argv: ['sh', '-c',
      `exec 3>alpha; printf NOW >&3; setsid sh -c 'sleep .5; printf LATE >&3; touch ${marker}' </dev/null >/dev/null 2>&1 &`]});
    await held.release();
    const peer = await f.claim(f.b, 'alpha');
    await createResource(f.b, 'alpha').write({claim: peer, reads: [await createResource(f.b, 'alpha').read()], content: 'PEER'});
    await delay(700);
    assert.equal((await createResource(f.b, 'alpha').read()).content, 'PEER');
    await assert.rejects(access(marker), {code: 'ENOENT'});
  } finally {await f.close(); await rm(marker, {force: true});}
});
