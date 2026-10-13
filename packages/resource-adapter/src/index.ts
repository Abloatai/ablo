import { chmod, mkdir, readdir, unlink } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseDurationMs } from '@abloatai/transaction/utils/duration';
import type { AbloHttpClient, HeldLease } from '@abloatai/transaction';
import { ResourceError, type ResourceWorkspace } from '@abloatai/transaction';
import { bindProcessTransport } from './process.js';
export { startResourceProcess, RESOURCE_PROFILE_HOME, type ResourceProcess } from './process.js';
export { createResource, getResourceReceipt, getResourceChanges, ResourceError } from '@abloatai/transaction';
export type { ResourceClaim, ResourceEvidence, ResourceReceipt, ResourceWorkspace, NativeResourceOperation } from '@abloatai/transaction';

export interface AdapterWorker {
  readonly uid: number;
  readonly client: Pick<AbloHttpClient<{}>, 'ready' | 'identity'> & {
    readonly claims: Pick<AbloHttpClient<{}>['claims'], 'acquireResource'>;
  };
}

/** Bind an existing SDK's row-free claims to the trusted Linux supervisor. */
export async function startResourceClaimGateway(options: {
  readonly socketPath: string;
  readonly workspaceId: string;
  readonly workers: readonly AdapterWorker[];
  /** Supported deployments must bound server/adapter clock skew by this value. */
  readonly clockSkewMs?: number;
}) {
  if (!options.workspaceId || !options.workers.length) throw new Error('A workspace and authenticated workers are required');
  const skew = options.clockSkewMs ?? 1000;
  if (!Number.isFinite(skew) || skew < 0) throw new Error('Invalid clock skew bound');
  await Promise.all(options.workers.map(worker => worker.client.ready()));
  const workers = new Map<string, AdapterWorker>();
  const registrations: Record<number, string> = {};
  let scope: string | undefined;
  for (const worker of options.workers) {
    const identity = worker.client.identity;
    if (!identity || !Number.isInteger(worker.uid) || worker.uid <= 0 || worker.uid >= 10000) throw new Error('Worker identity or UID is invalid');
    const current = JSON.stringify([identity.organizationId, identity.projectId, identity.branchId]);
    if (scope !== undefined && current !== scope) throw new Error('Workers must belong to the same tenant, project and branch');
    scope = current;
    const owner = JSON.stringify([current, identity.participantId, identity.participantKind,
      [...identity.syncGroups].sort(), [...identity.operations].sort()]);
    if (workers.has(owner) || registrations[worker.uid]) throw new Error('Each worker needs a distinct participant and UID');
    workers.set(owner, worker);
    registrations[worker.uid] = owner;
  }
  const leases = new Map<string, { held: HeldLease; expires: number }>();
  const pending = new Map<string, Promise<{ held: HeldLease; expires: number }>>();
  const deadline = (lease: HeldLease, expires: number) => {
    if (typeof lease.fenceToken !== 'number' || !Number.isSafeInteger(lease.fenceToken) || lease.fenceToken <= 0 || !Number.isFinite(expires) || expires - skew <= Date.now()) {
      throw new ResourceError('claim_lost');
    }
    return (expires - skew) / 1000;
  };
  const leaseKey = (owner: string, resource: string) => JSON.stringify([owner, resource]);
  const dispatch = async (request: { owner: string; action: string; resource: string; claim?: string; ttl?: string }) => {
    const worker = workers.get(request.owner);
    if (!worker || typeof request.resource !== 'string' || request.resource.length > 4096) throw new ResourceError('permission_denied');
    const key = leaseKey(request.owner, request.resource);
    const ttl = parseDurationMs(request.ttl ?? '30s') / 1000;
    if (!Number.isFinite(ttl) || ttl <= 0) throw new ResourceError('ttl_invalid');
    if (request.action === 'claim') {
      let acquire = pending.get(key);
      if (!acquire) {
        acquire = (async () => {
          const previous = leases.get(key);
          if (previous) {
            try { const beat = await previous.held.heartbeat(ttl); previous.expires = deadline(previous.held, beat.expiresAt); return previous; }
            catch { leases.delete(key); }
          }
          const held = await worker.client.claims.acquireResource({ workspaceId: options.workspaceId, resource: request.resource, ttl });
          let expires: number;
          try { expires = deadline(held, (await held.heartbeat(ttl)).expiresAt); } catch (error) { await held.release(); throw error; }
          const installed = { held, expires };
          leases.set(key, installed);
          return installed;
        })();
        pending.set(key, acquire);
      }
      try {
        const { held, expires } = await acquire;
        return { claim: held.id, fence: held.fenceToken, expires };
      } finally { pending.delete(key); }
    }
    const installed = leases.get(key);
    const held = installed?.held;
    if (request.action === 'release') {
      if (held && held.id === request.claim) { await held.release(); leases.delete(key); }
      return {};
    }
    if (request.action === 'heartbeat' && installed && held && held.id === request.claim) {
      const beat = await held.heartbeat(ttl);
      installed.expires = deadline(held, beat.expiresAt);
      return { expires: installed.expires };
    }
    throw new ResourceError('claim_lost');
  };
  const parent = options.socketPath.slice(0, options.socketPath.lastIndexOf('/'));
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  const listening = await new Promise<boolean>((resolve, reject) => {
    const probe = createConnection(options.socketPath);
    probe.setTimeout(1000, () => probe.destroy(new Error('Existing gateway did not respond')));
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', error => {
      if ('code' in error && (error.code === 'ENOENT' || error.code === 'ECONNREFUSED')) resolve(false);
      else reject(error);
    });
  });
  if (listening) throw new Error('A resource claim gateway is already running for this state directory');
  await unlink(options.socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const server = createServer(connection => {
    connection.setTimeout(35000, () => connection.destroy());
    let input = '';
    connection.on('error', () => {});
    connection.on('data', async chunk => {
      input += chunk.toString();
      if (input.length > 65536) { connection.destroy(); return; }
      if (!input.includes('\n')) return;
      connection.pause();
      try {
        const result = await dispatch(JSON.parse(input));
        connection.end(JSON.stringify({ result }) + '\n');
      } catch (error) {
        connection.end(JSON.stringify({ error: { code: error instanceof ResourceError ? error.code : 'claim_unavailable' } }) + '\n');
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.socketPath, resolve); });
  await chmod(options.socketPath, 0o600);
  return { registrations, async close() {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    // Stop/fence the filesystem daemon before closing its claim gateway.
    await Promise.all([...leases.values()].map(({ held }) => held.release()));
    await unlink(options.socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  } };
}

/** Unprivileged connections are identified by SO_PEERCRED, never their payload. */
export function connectResourceWorkspace(socketPath: string, options: { readonly workerUid?: number; readonly timeoutMs?: number } = {}): ResourceWorkspace {
  return bindProcessTransport({ request(request) {
    return new Promise((resolve, reject) => {
      const connection = createConnection(socketPath);
      let response = '';
      connection.setTimeout(options.timeoutMs ?? 310000, () => connection.destroy(new Error('Adapter response timed out')));
      connection.once('connect', () => connection.write(JSON.stringify({ ...request, ...(options.workerUid !== undefined ? { workerUid: options.workerUid } : {}) }) + '\n'));
      connection.on('error', reject);
      connection.on('data', chunk => {
        response += chunk.toString();
        if (response.length > 32 * 1024 * 1024) connection.destroy(new Error('Adapter response too large'));
      });
      connection.once('end', () => {
        try {
          const reply = JSON.parse(response);
          if (reply.error) reject(new ResourceError(reply.error.code, reply.error.resources, typeof request.operationId === 'string' ? request.operationId : undefined));
          else resolve(reply.result);
        } catch (error) { reject(error); }
      });
    });
  } }, socketPath, options.workerUid);
}

/** Start the kernel boundary and claim gateway in a managed Linux execution domain. */
export async function startResourceAdapter(options: {
  readonly stateDirectory: string;
  readonly mountpoint: string;
  readonly socketPath: string;
  readonly workspaceId: string;
  readonly workers: readonly AdapterWorker[];
  readonly seedDirectory?: string;
  readonly clockSkewMs?: number;
}) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('The adapter requires a Linux supervisor running as root');
  const gateway = await startResourceClaimGateway({ ...options, socketPath: join(options.stateDirectory, 'gateway/claims.sock') });
  await mkdir(options.socketPath.slice(0, options.socketPath.lastIndexOf('/')), { recursive: true, mode: 0o755 });
  const mountTag = `ablo-resource-${createHash('sha256').update(options.workspaceId).digest('hex')}-${randomUUID()}`;
  const daemon = fileURLToPath(new URL('../linux/daemon.py', import.meta.url));
  const processHandle = spawn('python3', [daemon, '--state', options.stateDirectory,
    '--workspace', options.workspaceId, '--mount', options.mountpoint,
    '--socket', options.socketPath, '--gateway', join(options.stateDirectory, 'gateway/claims.sock'), '--mount-tag', mountTag,
    ...(options.seedDirectory ? ['--seed', options.seedDirectory] : [])], { stdio: ['pipe', 'ignore', 'pipe'] });
  processHandle.stdin.end(JSON.stringify(gateway.registrations) + '\n');
  let diagnostics = '';
  processHandle.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-16000); });
  let spawnError: Error | undefined;
  const stopped = new Promise<void>(resolve => {
    processHandle.once('exit', () => resolve());
    processHandle.once('error', error => { spawnError = error; resolve(); });
  });
  const stopDaemon = async () => {
    if (processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill('SIGTERM');
    await Promise.race([stopped, delay(5000)]);
    if (processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill('SIGKILL');
    await stopped;
    const privateMounts = await readdir(join(options.stateDirectory, 'mounts')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const mount of [options.mountpoint, ...privateMounts.map(name => join(options.stateDirectory, 'mounts', name))]) {
      let source: string;
      try { source = execFileSync('findmnt', ['-n', '-o', 'SOURCE', '--mountpoint', mount], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
      catch { continue; }
      if (source.startsWith(mountTag)) execFileSync('fusermount', ['-uz', mount], { stdio: 'pipe' });
    }
  };
  try {
    const deadline = Date.now() + 10000;
    const probe = connectResourceWorkspace(options.socketPath, { workerUid: options.workers[0].uid, timeoutMs: 1000 });
    while (true) {
      if (spawnError || processHandle.exitCode !== null || processHandle.signalCode !== null || Date.now() > deadline) throw new Error(`Adapter did not mount: ${diagnostics}`);
      try {
        const status = await probe.request({ action: 'ready' });
        if (typeof status === 'object' && status !== null && 'ready' in status && status.ready === true) break;
      } catch { /* The socket appears before mount startup finishes. */ }
      await delay(25);
    }
  } catch (error) {
    await stopDaemon();
    await gateway.close();
    throw error;
  }
  return { process: processHandle, async close() {
    await stopDaemon();
    await gateway.close();
  } };
}
