import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { connectResourceWorkspace } from '../src/index.ts';

const owner = fileURLToPath(new URL('..', import.meta.url));
async function until(check: () => Promise<boolean> | boolean, label: string, milliseconds = 10000) {
  const deadline = Date.now() + milliseconds;
  while (!await check()) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await delay(10); }
}
const percentile = (values: number[], p: number) => [...values].sort((a,b) => a-b)[Math.min(values.length - 1, Math.floor(values.length * p))];

test('1000 connected workers receive scoped durable changes while native execution is saturated', { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'coordinator-'));
  let diagnostics = '';
  const launchBackend = () => {
    const child = spawn('python3', [join(owner, 'tests/coordinator_backend.py'), directory], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.on('data', chunk => { diagnostics += chunk; });
    return child;
  };
  let backend = launchBackend();
  const lines = createInterface({ input: backend.stdout });
  const [registration] = await Promise.race([once(lines, 'line'), once(backend, 'exit').then(() => { throw new Error(`Authority failed to start: ${diagnostics}`); })]);
  const socketPath = join(directory, 'public.sock');
  const launchRuntime = () => {
    const child = spawn(join(owner, 'bin/ablo-resource-coordinator'), [socketPath, join(directory, 'private/backend.sock')], { stdio: ['pipe', 'ignore', 'pipe'] });
    child.stdin.end(registration + '\n');
    child.stderr.on('data', chunk => { diagnostics += chunk; });
    return child;
  };
  let runtime = launchRuntime();
  const clients = Array.from({ length: 1000 }, (_, i) => connectResourceWorkspace(socketPath, { workerUid: 1001 + i, timeoutMs: 10000 }));
  let closing = false;
  const failures: string[] = [], seen = Array.from({ length: 1000 }, () => [] as number[]);
  try {
    await until(async () => { try { await access(socketPath); return true; } catch { return false; } }, 'listener');
    const started = performance.now();
    const latency: number[] = [];
    const reads = await Promise.all(clients.map(async (client, i) => {
      const before = performance.now();
      const result = await client.request({ action: 'read', resource: `file:file-${i}` }) as { evidence: string; content: string };
      latency.push(performance.now() - before);
      assert.equal(result.content, 'BASE');
      return result;
    }));
    const connectedMs = performance.now() - started;
    const native = clients.slice(0, 8).map(client => client.request({ action: 'run', operationId: randomUUID(), claims: [], reads: [], argv: ['synthetic-sleep'] }));
    native.forEach(task => { void task.catch(() => undefined); });
    await until(async () => { try { return await readFile(join(directory, 'running'), 'utf8') === '8'; } catch { return false; } }, 'eight occupied execution slots');
    await assert.rejects(clients[8].request({ action: 'run', operationId: randomUUID(), claims: [], reads: [], argv: ['synthetic-sleep'] }), { code: 'adapter_busy' });
    const watchers = await Promise.all(clients.map((client, i) => client.watch(['file:file-0', `file:file-${i}`], {
      onChanges(batch) { seen[i].push(...batch.events.map(event => event.sequence)); },
      onError(error) { if (!closing) failures.push(error.message); },
    })));
    const controlStart = performance.now();
    const heartbeat = await clients[0].request({ action: 'receipt', operationId: randomUUID() }) as { status: string };
    assert.equal(heartbeat.status, 'absent');
    const controlMs = performance.now() - controlStart;
    const write = (index: number, evidence: string, content: string) => clients[index].request({
      action: 'write', operationId: randomUUID(), resource: `file:file-${index}`, content,
      claims: [{ resource: `file:file-${index}`, claim: `claim-${index}` }],
      reads: [{ resource: `file:file-${index}`, evidence }],
    });
    const fanoutStart = performance.now();
    const first = await write(0, reads[0].evidence, 'FIRST') as { status: string };
    assert.equal(first.status, 'applied');
    await until(() => seen.every(events => events.length === 1), '1000 durable notifications');
    const fanoutMs = performance.now() - fanoutStart;
    assert.equal(failures.length, 0);
    const disjoint = await Promise.all(Array.from({ length: 16 }, (_, i) => write(i + 1, reads[i + 1].evidence, 'DISJOINT'))) as { status: string }[];
    assert.ok(disjoint.every(reply => reply.status === 'applied'));
    await until(() => seen.slice(1,17).every(events => events.length === 2), 'scoped disjoint notifications');
    assert.ok(seen.slice(17).every(events => events.length === 1));
    assert.equal((await write(0, reads[0].evidence, 'STALE') as { code: string }).code, 'stale_context');
    await assert.rejects(clients[0].request({ action: 'await_changes' }), { code: 'operation_invalid' });
    await assert.rejects(clients[0].request({ action: 'read', resource: 'file:file-0', authority: {} }), { code: 'request_invalid' });
    await writeFile(join(directory, 'release'), 'release');
    assert.ok((await Promise.all(native) as { status: string }[]).every(reply => reply.status === 'applied'));
    const counts = JSON.parse(await readFile(join(directory, 'counts.json'), 'utf8'));
    assert.equal(counts.firstLiveCursor, 1, 'coordinator replayed historical events instead of starting at the live boundary');
    const evidence = { scope: '1000 persistent logical worker identities; real Rust coordinator and SQLite adapter authority; FUSE and native execution stubbed; local Unix sockets', connectedMs, readP50Ms: percentile(latency,.5), readP95Ms: percentile(latency,.95), controlMs, fanoutMs, errors: failures, workers: clients.length, disjointWrites:16, counts };
    // Recovery is an explicit durable catch-up, including events missed while disconnected.
    const cursor = watchers[0].cursor;
    await watchers[0].close();
    const fresh = await clients[0].request({ action: 'read', resource: 'file:file-0' }) as { evidence: string };
    await write(0, fresh.evidence, 'OFFLINE');
    let recovered = 0;
    const resumed = await clients[0].watch(['file:file-0'], { after: cursor,
      onChanges(batch) { recovered += batch.events.length; }, onError(error) { failures.push(error.message); } });
    assert.equal(recovered, 1);
    await resumed.close();
    // The authority must notify after commit even when the writer never gets a reply.
    const lost = connectResourceWorkspace(socketPath, { workerUid: 1001 });
    const lostRead = await lost.request({ action: 'read', resource: 'file:file-0' }) as { evidence: string };
    const lostId = randomUUID(), beforeLost = seen[500].length;
    const lostReply = assert.rejects(lost.request({ action: 'write', operationId: lostId, resource: 'file:file-0', content: 'LOST_REPLY',
      claims: [{ resource: 'file:file-0', claim: 'claim-0' }], reads: [{ resource: 'file:file-0', evidence: lostRead.evidence }] }), { code: 'outcome_unknown' });
    await until(async () => { try { await access(join(directory, 'committed')); return true; } catch { return false; } }, 'commit before reply');
    lost.close();
    await lostReply;
    await until(() => seen[500].length === beforeLost + 1, 'notification without writer response');
    assert.equal((await clients[0].request({ action: 'receipt', operationId: lostId }) as { status: string }).status, 'applied');
    await writeFile(join(directory, 'reply-release'), 'release');

    // Partial and pipelined input must survive responses arriving between fragments.
    const raw = createConnection(socketPath);
    raw.setEncoding('utf8');
    let rawInput = '';
    const rawFrames: { id: string; result?: unknown }[] = [];
    raw.on('data', chunk => { rawInput += chunk; let end: number; while ((end = rawInput.indexOf('\n')) !== -1) {
      rawFrames.push(JSON.parse(rawInput.slice(0, end))); rawInput = rawInput.slice(end + 1);
    } });
    const frame = (id: string, request: object) => JSON.stringify({ id, request: { workerUid: 1001, ...request } }) + '\n';
    const partial = frame('two', { action: 'read', resource: 'file:file-1' });
    raw.write(frame('one', { action: 'read', resource: 'file:file-0' }) + partial.slice(0, 20));
    await until(() => rawFrames.length === 1, 'response during partial input');
    raw.write(partial.slice(20) + frame('three', { action: 'read', resource: 'file:file-2' }));
    await until(() => rawFrames.length === 3, 'pipelined responses');
    assert.deepEqual(rawFrames.map(reply => reply.id).sort(), ['one', 'three', 'two']);
    raw.destroy();

    const unicode = await clients[0].request({ action: 'read', resource: 'file:large' }) as { content: string };
    assert.equal(unicode.content, '🍞'.repeat(300000));

    // A non-reading peer cannot retain output indefinitely or block another worker.
    const slow = createConnection(socketPath);
    slow.on('error', () => undefined);
    await once(slow, 'connect');
    slow.pause();
    for (let i = 0; i < 16; i++) slow.write(frame(String(i), { action: 'read', resource: 'file:large' }));
    const active = performance.now();
    assert.equal((await clients[500].request({ action: 'read', resource: 'file:file-500' }) as { content: string }).content, 'BASE');
    assert.ok(performance.now() - active < 2000, 'slow peer blocked healthy worker');
    await delay(5500);
    const disconnected = once(slow, 'close');
    slow.resume();
    await Promise.race([disconnected, delay(2000).then(() => { slow.destroy(); throw new Error('slow writer deadline not enforced'); })]);
    assert.equal(failures.length, 0);
    const beforeIdle = await readFile(join(directory, 'counts.json'), 'utf8');
    await delay(250);
    assert.equal(await readFile(join(directory, 'counts.json'), 'utf8'), beforeIdle, 'idle subscriptions polled the authority');
    // A coordinator crash leaves a stale socket and an uncertain writer, not permission to replay.
    const saved = watchers[500].cursor;
    await rm(join(directory, 'committed'));
    await rm(join(directory, 'reply-release'));
    const crashRead = await clients[0].request({ action: 'read', resource: 'file:file-0' }) as { evidence: string };
    const crashId = randomUUID();
    const uncertain = assert.rejects(clients[0].request({ action: 'write', operationId: crashId, resource: 'file:file-0', content: 'LOST_REPLY_AGAIN',
      claims: [{ resource: 'file:file-0', claim: 'claim-0' }], reads: [{ resource: 'file:file-0', evidence: crashRead.evidence }] }), { code: 'outcome_unknown' });
    await until(async () => { try { await access(join(directory, 'committed')); return true; } catch { return false; } }, 'second commit before reply');
    closing = true;
    runtime.kill('SIGKILL');
    await once(runtime, 'exit');
    await uncertain;
    await writeFile(join(directory, 'reply-release'), 'release');
    runtime = launchRuntime();
    await until(async () => {
      if (runtime.exitCode !== null) throw new Error(`Restart failed: ${diagnostics}`);
      try { return (await clients[0].request({ action: 'receipt', operationId: crashId }) as { status: string }).status === 'applied'; }
      catch { return false; }
    }, 'receipt recovery after coordinator crash');
    const crashEvents: number[] = [];
    const restartedWatch = await clients[0].watch(['file:file-0'], { after: saved,
      onChanges(batch) { crashEvents.push(...batch.events.map(row => row.sequence)); },
      onError(error) { if (!closing) failures.push(error.message); } });
    assert.equal(crashEvents.length, 1);
    await restartedWatch.close();

    // Restart the real SQLite authority with an unfinished operation: receipts survive, leases do not.
    await rm(join(directory, 'release'));
    const interruptedId = randomUUID();
    const interrupted = assert.rejects(clients[0].request({ action: 'run', operationId: interruptedId, claims: [], reads: [], argv: ['synthetic-sleep'] }), { code: 'outcome_unknown' });
    await until(async () => await readFile(join(directory, 'running'), 'utf8') === '1', 'unfinished operation admitted');
    backend.kill('SIGKILL');
    await once(backend, 'exit');
    await interrupted;
    runtime.kill('SIGTERM');
    await once(runtime, 'exit');
    backend = launchBackend();
    const resumedLines = createInterface({ input: backend.stdout });
    await Promise.race([once(resumedLines, 'line'), once(backend, 'exit').then(() => { throw new Error(`Authority failed to restart: ${diagnostics}`); })]);
    resumedLines.close();
    runtime = launchRuntime();
    await until(async () => { try { return (await clients[0].request({ action: 'receipt', operationId: interruptedId }) as { status: string }).status === 'aborted'; } catch { return false; } }, 'authority restart aborts unfinished operation');
    assert.equal((await clients[0].request({ action: 'receipt', operationId: crashId }) as { status: string }).status, 'applied');
    const persisted = await clients[0].request({ action: 'read', resource: 'file:file-0' }) as { evidence: string; content: string };
    assert.equal(persisted.content, 'LOST_REPLY_AGAIN');
    assert.equal((await write(0, persisted.evidence, 'REVOKED') as { code: string }).code, 'claim_lost');
    const verified = { ...evidence, coordinatorCrashRecovery: true, authorityCrashRecovery: true, recovery: true, lostReplyNotification: true, fragmentedAndPipelinedFrames: true,
      slowReaderDisconnected: true, idlePollingRequests: 0 };
    console.log(JSON.stringify(verified));
    if (process.env.ABLO_COORDINATOR_EVIDENCE) await writeFile(process.env.ABLO_COORDINATOR_EVIDENCE, JSON.stringify(verified, null, 2) + '\n');

  } catch (error) { console.error(diagnostics); throw error; }
  finally {
    closing = true;
    clients.forEach(client => client.close());
    runtime.kill('SIGTERM'); backend.kill('SIGTERM');
    await Promise.all([runtime, backend].map(child => child.exitCode !== null || child.signalCode !== null ? undefined : once(child, 'exit')));
    lines.close();
    await rm(directory, { recursive: true, force: true });
  }
});
