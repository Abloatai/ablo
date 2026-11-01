import { createConnection } from 'node:net';
import { PassThrough, Writable, type Readable } from 'node:stream';
import { getResourceReceipt, ResourceError, type NativeResourceOperation, type ResourceReceipt, type ResourceWorkspace } from '@abloatai/transaction';

const processTransport = Symbol('trusted resource process transport');
const limit = 16 * 1024 * 1024;
export const RESOURCE_FILESYSTEM_PROFILE_BUDGET = 'filesystem-profile-64m-v2';
export type ResourceProcessDiagnostic = Readonly<{
  reason: 'stream_overflow' | 'frame_overflow' | 'socket_lost' | 'protocol_error' | 'timeout';
  stream: 'stdin' | 'stdout' | 'stderr' | null;
  stdinBytes: number; stdoutBytes: number; stderrBytes: number;
}>;
export type ResourceProcessOptions = {
  streamBudget?: typeof RESOURCE_FILESYSTEM_PROFILE_BUDGET;
  sandboxMasks?: typeof RESOURCE_SANDBOX_MASKS;
  onDiagnostic?: (diagnostic: ResourceProcessDiagnostic) => void;
};
export const RESOURCE_SANDBOX_MASKS = 'srt-root-masks-v1';
export const RESOURCE_PROFILE_HOME = '/tmp/ablo-native-profile';

export function bindProcessTransport(workspace: ResourceWorkspace, socketPath: string, workerUid?: number): ResourceWorkspace {
  return Object.assign(workspace, { [processTransport]: { socketPath, workerUid } });
}

export interface ResourceProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly homePath: string;
  readonly sandboxMaskPaths?: readonly string[];
  readonly completed: Promise<ResourceReceipt>;
  complete(): Promise<ResourceReceipt>;
  abort(): Promise<ResourceReceipt>;
}

/** One native turn; only the trusted root caller can confirm publication. */
export async function startResourceProcess(workspace: ResourceWorkspace, operation: Omit<NativeResourceOperation, 'operationId'> & {
  readonly operationId: string;
  readonly profileId: string;
}, options: ResourceProcessOptions = {}): Promise<ResourceProcess> {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('Native resource processes require a trusted Linux root transport');
  const transport = (workspace as ResourceWorkspace & { [processTransport]?: { socketPath: string; workerUid?: number } })[processTransport];
  if (!transport) throw new Error('Use connectResourceWorkspace for the trusted process transport');
  if (Object.hasOwn(operation, 'streamBudget') || options.streamBudget !== undefined && options.streamBudget !== RESOURCE_FILESYSTEM_PROFILE_BUDGET) throw new ResourceError('capability_unavailable');
  if (Object.hasOwn(operation, 'sandboxMasks') || options.sandboxMasks !== undefined &&
    (options.sandboxMasks !== RESOURCE_SANDBOX_MASKS || options.streamBudget !== RESOURCE_FILESYSTEM_PROFILE_BUDGET)) throw new ResourceError('capability_unavailable');
  if (options.streamBudget) {
    const capability = await workspace.request({action: 'ready'}) as {ready?: unknown; filesystemProfileBudget?: unknown; filesystemSandboxMasks?: unknown};
    if (capability.ready !== true || capability.filesystemProfileBudget !== options.streamBudget || options.sandboxMasks && capability.filesystemSandboxMasks !== options.sandboxMasks) throw new ResourceError('capability_unavailable');
  }
  const streamLimit = (name: string) => options.streamBudget && name !== 'stderr' ? 64 * 1024 * 1024 : limit;
  const socket = createConnection(transport.socketPath);
  const stdout = new PassThrough(), stderr = new PassThrough();
  let resolveReceipt!: (receipt: ResourceReceipt) => void, rejectReceipt!: (error: Error) => void;
  const completed = new Promise<ResourceReceipt>((resolve, reject) => { resolveReceipt = resolve; rejectReceipt = reject; });
  // A startup failure can precede the caller receiving the completed promise.
  void completed.catch(() => undefined);
  let resolveStart!: (home: string) => void, rejectStart!: (error: Error) => void;
  const started = new Promise<string>((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
  let terminal = false, decision = false, buffer = '';
  let sandboxMaskPaths: readonly string[] | undefined;
  const counts = { stdin: 0, stdout: 0, stderr: 0 };
  let reported = false;
  const report = (reason: ResourceProcessDiagnostic['reason'], stream: ResourceProcessDiagnostic['stream'] = null, bytes = counts) => {
    if (reported) return;
    reported = true;
    const diagnostic = Object.freeze({reason, stream, stdinBytes: bytes.stdin, stdoutBytes: bytes.stdout, stderrBytes: bytes.stderr});
    try { void Promise.resolve(options.onDiagnostic?.(diagnostic)).catch(() => {}); } catch {}
  };
  const send = (frame: object, callback?: (error?: Error | null) => void) => socket.write(JSON.stringify(frame) + '\n', callback);
  const stdin = new Writable({ write(chunk: Buffer, _encoding, callback) {
    counts.stdin += chunk.length;
    if (decision || terminal || counts.stdin > streamLimit('stdin')) {
      if (counts.stdin > streamLimit('stdin')) report('stream_overflow', 'stdin');
      if (!decision && !terminal) { decision = true; send({ action: 'abort' }); }
      callback(new ResourceError('stream_closed', [], operation.operationId));
    } else send({ action: 'stdin', data: chunk.toString('base64') }, callback);
  }, final(callback) {
    if (!decision && !terminal) send({ action: 'eof' }, callback);
    else callback();
  } });
  const fail = () => {
    if (terminal) return;
    report('socket_lost');
    terminal = true;
    const error = new ResourceError('outcome_unknown', [], operation.operationId);
    rejectStart(error); rejectReceipt(error);
    stdin.destroy(); stdout.end(); stderr.end(); socket.destroy();
  };
  socket.setTimeout((operation.timeoutMs ?? 30000) + 15000, () => {report('timeout'); fail();});
  socket.once('connect', () => send({ ...operation, action: 'run', interactive: true,
    ...(options.streamBudget ? {streamBudget: options.streamBudget} : {}),
    ...(options.sandboxMasks ? {sandboxMasks: options.sandboxMasks} : {}),
    claims: operation.claims.map(({ resource, id }) => ({ resource, claim: id })),
    reads: (operation.reads ?? []).map(({ resource, evidence }) => ({ resource, evidence })),
    ...(transport.workerUid !== undefined ? { workerUid: transport.workerUid } : {}) }));
  socket.on('error', fail);
  socket.on('end', fail);
  socket.on('data', chunk => {
    buffer += chunk.toString();
    if (buffer.length > 32 * 1024 * 1024) { report('frame_overflow'); fail(); return; }
    while (buffer.includes('\n')) {
      const offset = buffer.indexOf('\n');
      const raw = buffer.slice(0, offset); buffer = buffer.slice(offset + 1);
      try {
        const frame = JSON.parse(raw);
        if (frame.started === true && frame.homePath === RESOURCE_PROFILE_HOME) {
          if (frame.sandboxMasks !== options.sandboxMasks || options.sandboxMasks &&
            (!Array.isArray(frame.sandboxMaskPaths) || frame.sandboxMaskPaths.length > 16 ||
             frame.sandboxMaskPaths.some((p: unknown) => typeof p !== 'string' || !/^(?:\.(?:gitconfig|gitmodules|bashrc|bash_profile|zshrc|zprofile|profile|ripgreprc|mcp\.json|vscode|idea|claude)|\.claude\/(?:commands|agents)|\.git\/(?:hooks|config))$/.test(p)))) {report('protocol_error'); fail(); return;}
          sandboxMaskPaths = options.sandboxMasks ? Object.freeze([...frame.sandboxMaskPaths]) : undefined;
          if (frame.streamBudget !== options.streamBudget) {report('protocol_error'); fail(); return;}
          resolveStart(frame.homePath);
        } else if (frame.diagnostic) {
          const d = frame.diagnostic;
          if (!['stream_overflow', 'frame_overflow', 'socket_lost', 'protocol_error', 'timeout'].includes(d.reason)
            || !['stdin', 'stdout', 'stderr', null].includes(d.stream)
            || ![d.stdinBytes, d.stdoutBytes, d.stderrBytes].every(n => Number.isSafeInteger(n) && n >= 0)) {report('protocol_error'); fail(); return;}
          report(d.reason, d.stream, {stdin: d.stdinBytes, stdout: d.stdoutBytes, stderr: d.stderrBytes});
        }
        else if (frame.stream === 'stdout' || frame.stream === 'stderr') {
          const name: 'stdout' | 'stderr' = frame.stream;
          const bytes = Buffer.from(frame.data, 'base64');
          counts[name] += bytes.length;
          if (counts[name] > streamLimit(name)) { report('stream_overflow', name); decision = true; send({ action: 'abort' }); }
          else (name === 'stdout' ? stdout : stderr).write(bytes);
        } else if (frame.result) {
          void getResourceReceipt({ request: async () => frame.result }, operation.operationId).then(receipt => {
            if (receipt.status === 'running' || receipt.status === 'absent') { fail(); return; }
            terminal = true;
            // Duplicate operation IDs reconcile their existing receipt without a new child.
            rejectStart(new ResourceError(receipt.code ?? 'operation_closed', receipt.resources, operation.operationId));
            resolveReceipt(receipt); stdin.destroy(); stdout.end(); stderr.end(); socket.end();
          }, fail);
        } else if (frame.error) {
          terminal = true;
          const error = new ResourceError(frame.error.code, frame.error.resources, operation.operationId);
          rejectStart(error); rejectReceipt(error); stdin.destroy(); stdout.end(); stderr.end(); socket.end();
        } else fail();
      } catch { fail(); }
    }
  });
  const homePath = await started;
  const finish = (action: 'complete' | 'abort') => {
    if (!decision && !terminal) { decision = true; send({ action }); }
    return completed;
  };
  return { stdin, stdout, stderr, homePath, sandboxMaskPaths, completed, complete: () => finish('complete'), abort: () => finish('abort') };
}
