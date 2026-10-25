import { access, chmod, mkdir, readdir, unlink } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseDurationMs } from '@abloatai/transaction/utils/duration';
import type { AbloHttpClient, AbloWebSocketClient, HeldLease } from '@abloatai/transaction';
import { AbloClaimedError, ResourceError } from '@abloatai/transaction';
import { bindProcessTransport } from './process.js';
import { connect } from './connection.js';
export type { ResourceChanges } from './connection.js';
export { startResourceProcess, RESOURCE_PROFILE_HOME, type ResourceProcess } from './process.js';
export { createResource, getResourceReceipt, getResourceChanges, ResourceError } from '@abloatai/transaction';
export type { ResourceClaim, ResourceEvidence, ResourceReceipt, ResourceWorkspace, NativeResourceOperation } from '@abloatai/transaction';

/** Required by trusted hosts before opting workers into dynamic publication. */
export const RESOURCE_PROJECT_FILES = 'publication-v1';

export interface AdapterWorker {
  readonly uid: number;
  /** Trusted current project-write authority; absence preserves exact static grants. */
  readonly projectFiles?: { readonly authorize: (context: { readonly sourceWorkspaceId: string; readonly workerUid: number; readonly operationId: string; readonly signal: AbortSignal }) => Promise<{ readonly validForMs: number }> };
  readonly client: Pick<AbloHttpClient<{}>, 'ready' | 'identity'> & {
    readonly claims: Pick<AbloHttpClient<{}>['claims'], 'acquireResource'>;
    readonly subscribe?: AbloWebSocketClient<{}>['subscribe'];
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
    if (worker.projectFiles && typeof worker.projectFiles.authorize !== 'function') throw new Error('Project files require a current authority callback');
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
  const waiting = new Set<string>();
  const pending = new Map<string, Promise<{ held: HeldLease; expires: number }>>();
  const deadline = (lease: HeldLease, expires: number) => {
    if (typeof lease.fenceToken !== 'number' || !Number.isSafeInteger(lease.fenceToken) || lease.fenceToken <= 0 || !Number.isFinite(expires) || expires - skew <= Date.now()) {
      throw new ResourceError('claim_lost');
    }
    return (expires - skew) / 1000;
  };
  const leaseKey = (owner: string, resource: string) => JSON.stringify([owner, resource]);
  const dispatch = async (request: { owner: string; action: string; resource: string; operationId?: string; claim?: string; ttl?: string; waitMs?: number }, signal: AbortSignal, queued: () => void) => {
    const worker = workers.get(request.owner);
    if (worker && request.action === 'project_authorize') {
      if (!worker.projectFiles || typeof request.operationId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(request.operationId)) throw new ResourceError('permission_denied');
      const started = Date.now();
      const lease = await worker.projectFiles.authorize({ sourceWorkspaceId: options.workspaceId, workerUid: worker.uid, operationId: request.operationId, signal });
      if (signal.aborted) throw new ResourceError('permission_denied');
      if (!lease || !Number.isFinite(lease.validForMs) || lease.validForMs <= skew || lease.validForMs > 60000) throw new ResourceError('permission_denied');
      const expires = (started + lease.validForMs - skew) / 1000;
      if (expires <= Date.now() / 1000) throw new ResourceError('permission_denied');
      return { expires };
    }
    if (!worker || typeof request.resource !== 'string' || request.resource.length > 4096) throw new ResourceError('permission_denied');
    const key = leaseKey(request.owner, request.resource);
    const ttl = parseDurationMs(request.ttl ?? '30s') / 1000;
    if (!Number.isFinite(ttl) || ttl <= 0) throw new ResourceError('ttl_invalid');
    if (request.action === 'wait') {
      if (typeof request.waitMs !== 'number' || !Number.isInteger(request.waitMs) || request.waitMs < 1 || request.waitMs > 30000) throw new ResourceError('request_invalid');
      if (typeof worker.client.subscribe !== 'function') throw new ResourceError('realtime_claims_required');
      if (waiting.size >= 1024) throw new ResourceError('adapter_busy');
      if (waiting.has(key) || pending.has(key)) throw new ResourceError('claim_pending');
      waiting.add(key);
      queued();
      try {
        const previous = leases.get(key);
        if (previous) {
          try {
            previous.expires = deadline(previous.held, (await previous.held.heartbeat(ttl)).expiresAt);
            return { claim: previous.held.id, fence: previous.held.fenceToken, expires: previous.expires };
          } catch { leases.delete(key); }
        }
        const held = await worker.client.claims.acquireResource({ workspaceId: options.workspaceId, resource: request.resource, ttl,
          contention: { mode: 'wait', timeoutMs: request.waitMs, signal } });
        try {
          const expires = deadline(held, (await held.heartbeat(ttl)).expiresAt);
          if (signal.aborted) throw new ResourceError('claim_wait_aborted');
          leases.set(key, { held, expires });
          return { claim: held.id, fence: held.fenceToken, expires };
        } catch (error) { await held.release(); throw error; }
      } finally { waiting.delete(key); }
    }
    if (request.action === 'claim') {
      if (waiting.has(key)) throw new ResourceError('claim_pending');
      let acquire = pending.get(key);
      if (!acquire) {
        acquire = (async () => {
          const previous = leases.get(key);
          if (previous) {
            try { const beat = await previous.held.heartbeat(ttl); previous.expires = deadline(previous.held, beat.expiresAt); return previous; }
            catch { leases.delete(key); }
          }
          const held = await worker.client.claims.acquireResource({ workspaceId: options.workspaceId, resource: request.resource, ttl, contention: { mode: 'skip' } });
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
  const connections = new Set<import('node:net').Socket>();
  const server = createServer(connection => {
    connections.add(connection);
    const abort = new AbortController();
    connection.once('close', () => { connections.delete(connection); abort.abort(); });
    connection.setTimeout(35000, () => connection.destroy());
    let input = '';
    connection.on('error', () => {});
    connection.on('data', async chunk => {
      input += chunk.toString();
      if (input.length > 65536) { connection.destroy(); return; }
      if (!input.includes('\n')) return;
      connection.pause();
      try {
        const result = await dispatch(JSON.parse(input), abort.signal, () => connection.write(JSON.stringify({ waiting: true }) + '\n'));
        connection.end(JSON.stringify({ result }) + '\n');
      } catch (error) {
        const conflict = error instanceof AbloClaimedError && (error.code === 'claim_conflict' || error.code === 'entity_claimed');
        const code = error instanceof ResourceError ? error.code : error instanceof AbloClaimedError && ['grant_timeout', 'claim_wait_aborted', 'claim_lost'].includes(error.code ?? '') ? error.code : conflict ? 'claim_conflict' : 'claim_unavailable';
        connection.end(JSON.stringify({ error: { code } }) + '\n');
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.socketPath, resolve); });
  await chmod(options.socketPath, 0o600);
  return { registrations, async close() {
    for (const connection of connections) connection.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    // Stop/fence the filesystem daemon before closing its claim gateway.
    await Promise.all([...leases.values()].map(({ held }) => held.release()));
    await unlink(options.socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  } };
}

/** Unprivileged connections are identified by SO_PEERCRED, never their payload. */
export function connectResourceWorkspace(socketPath: string, options: { readonly workerUid?: number; readonly timeoutMs?: number } = {}) {
  const connection = connect(socketPath, options);
  return Object.assign(bindProcessTransport(connection, socketPath, options.workerUid), connection);
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
  readonly maxConcurrentProcesses?: number;
  /** Opt-in network-isolated gVisor commands; interactive native providers are rejected. */
  readonly gvisorRootfs?: string;
  /** Empty, root-owned cgroup2 subtree with a finite aggregate budget and supervisor reserve. */
  readonly gvisorCgroupRoot?: string;
  /** Trusted per-command memory budget, in whole MiB expressed as bytes. */
  readonly gvisorMemoryLimitBytes?: number;
}) {
  if (options.gvisorRootfs !== undefined && (typeof options.gvisorRootfs !== 'string' || !isAbsolute(options.gvisorRootfs) || options.gvisorRootfs.includes('\0'))) throw new Error('gvisorRootfs must be an absolute path');
  if (options.gvisorRootfs === undefined && (options.gvisorCgroupRoot !== undefined || options.gvisorMemoryLimitBytes !== undefined)) throw new Error('gVisor memory configuration requires gvisorRootfs');
  if (options.gvisorRootfs !== undefined) {
    if (typeof options.gvisorCgroupRoot !== 'string' || !isAbsolute(options.gvisorCgroupRoot) || options.gvisorCgroupRoot.includes('\0')) throw new Error('gvisorCgroupRoot must be an absolute delegated cgroup2 path');
    if (!Number.isSafeInteger(options.gvisorMemoryLimitBytes) || options.gvisorMemoryLimitBytes! <= 0 || options.gvisorMemoryLimitBytes! % (1024 * 1024)) throw new Error('gvisorMemoryLimitBytes must be a positive whole number of MiB in bytes');
  }
  const slots = options.maxConcurrentProcesses ?? 8;
  if (!Number.isInteger(slots) || slots < 1 || slots > 64) throw new Error('maxConcurrentProcesses must be an integer from 1 to 64');
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('The adapter requires a Linux supervisor running as root');
  const coordinatorPath = fileURLToPath(new URL('../bin/ablo-resource-coordinator', import.meta.url));
  await access(coordinatorPath).catch(() => { throw new Error('Build the Rust coordinator on the Linux host with npm run build:runtime before starting the adapter'); });
  const gateway = await startResourceClaimGateway({ ...options, socketPath: join(options.stateDirectory, 'gateway/claims.sock') });
  await mkdir(options.socketPath.slice(0, options.socketPath.lastIndexOf('/')), { recursive: true, mode: 0o755 });
  const mountTag = `ablo-resource-${createHash('sha256').update(options.workspaceId).digest('hex')}-${randomUUID()}`;
  const daemon = fileURLToPath(new URL('../linux/daemon.py', import.meta.url));
  await chmod(options.stateDirectory, 0o700);
  const backendPath = join(options.stateDirectory, 'commands.sock');
  const processHandle = spawn('python3', [daemon, '--state', options.stateDirectory,
    '--workspace', options.workspaceId, '--mount', options.mountpoint,
    '--socket', backendPath, '--gateway', join(options.stateDirectory, 'gateway/claims.sock'), '--mount-tag', mountTag,
    '--project-file-uids', JSON.stringify(options.workers.filter(worker => worker.projectFiles).map(worker => worker.uid)),
    ...(options.seedDirectory ? ['--seed', options.seedDirectory] : []),
    ...(options.gvisorRootfs !== undefined ? ['--gvisor-rootfs', options.gvisorRootfs, '--gvisor-cgroup-root', options.gvisorCgroupRoot!,
      '--gvisor-memory-limit-bytes', String(options.gvisorMemoryLimitBytes), '--gvisor-concurrency', String(slots)] : [])], { stdio: ['pipe', 'ignore', 'pipe'] });
  processHandle.stdin.on('error', () => undefined);
  processHandle.stdin.end(JSON.stringify(gateway.registrations) + '\n');
  const coordinator = spawn(coordinatorPath, [options.socketPath, backendPath, String(slots)], { stdio: ['pipe', 'ignore', 'pipe'] });
  coordinator.stdin.on('error', () => undefined);
  coordinator.stdin.end(JSON.stringify(gateway.registrations) + '\n');
  let diagnostics = '';
  processHandle.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-16000); });
  coordinator.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-16000); });
  let spawnError: Error | undefined;
  const coordinatorStopped = new Promise<void>(resolve => {
    coordinator.once('exit', () => resolve());
    coordinator.once('error', error => { spawnError = error; resolve(); });
  });
  const stopped = new Promise<void>(resolve => {
    processHandle.once('exit', () => resolve());
    processHandle.once('error', error => { spawnError = error; resolve(); });
  });
  // Either authority disappearing closes admission; callers recover retained operation IDs.
  void stopped.then(() => coordinator.kill('SIGTERM'));
  void coordinatorStopped.then(() => processHandle.kill('SIGTERM'));
  const stopDaemon = async () => {
    coordinator.kill('SIGTERM');
    await coordinatorStopped;
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
  const probe = connectResourceWorkspace(options.socketPath, { workerUid: options.workers[0].uid, timeoutMs: 1000 });
  try {
    const deadline = Date.now() + 10000;
    while (true) {
      if (spawnError || coordinator.exitCode !== null || coordinator.signalCode !== null || processHandle.exitCode !== null || processHandle.signalCode !== null || Date.now() > deadline) throw new Error(`Adapter did not mount: ${spawnError?.message ?? diagnostics}`);
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
  } finally { probe.close(); }
  return { process: processHandle, async close() {
    await stopDaemon();
    await gateway.close();
  } };
}
