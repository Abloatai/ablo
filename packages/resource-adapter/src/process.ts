import { createConnection } from 'node:net';
import { PassThrough, Writable, type Readable } from 'node:stream';
import { getResourceReceipt, ResourceError, type NativeResourceOperation, type ResourceReceipt, type ResourceWorkspace } from '@abloatai/transaction';

const processTransport = Symbol('trusted resource process transport');
const limit = 16 * 1024 * 1024;
export const RESOURCE_PROFILE_HOME = '/tmp/ablo-native-profile';

export function bindProcessTransport(workspace: ResourceWorkspace, socketPath: string, workerUid?: number): ResourceWorkspace {
  return Object.assign(workspace, { [processTransport]: { socketPath, workerUid } });
}

export interface ResourceProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly homePath: string;
  readonly completed: Promise<ResourceReceipt>;
  complete(): Promise<ResourceReceipt>;
  abort(): Promise<ResourceReceipt>;
}

/** One native turn; only the trusted root caller can confirm publication. */
export async function startResourceProcess(workspace: ResourceWorkspace, operation: Omit<NativeResourceOperation, 'operationId'> & {
  readonly operationId: string;
  readonly profileId: string;
}): Promise<ResourceProcess> {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('Native resource processes require a trusted Linux root transport');
  const transport = (workspace as ResourceWorkspace & { [processTransport]?: { socketPath: string; workerUid?: number } })[processTransport];
  if (!transport) throw new Error('Use connectResourceWorkspace for the trusted process transport');
  const socket = createConnection(transport.socketPath);
  const stdout = new PassThrough(), stderr = new PassThrough();
  let resolveReceipt!: (receipt: ResourceReceipt) => void, rejectReceipt!: (error: Error) => void;
  const completed = new Promise<ResourceReceipt>((resolve, reject) => { resolveReceipt = resolve; rejectReceipt = reject; });
  // A startup failure can precede the caller receiving the completed promise.
  void completed.catch(() => undefined);
  let resolveStart!: (home: string) => void, rejectStart!: (error: Error) => void;
  const started = new Promise<string>((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
  let terminal = false, decision = false, buffer = '';
  const counts = { stdin: 0, stdout: 0, stderr: 0 };
  const send = (frame: object, callback?: (error?: Error | null) => void) => socket.write(JSON.stringify(frame) + '\n', callback);
  const stdin = new Writable({ write(chunk: Buffer, _encoding, callback) {
    counts.stdin += chunk.length;
    if (decision || terminal || counts.stdin > limit) {
      if (!decision && !terminal) { decision = true; send({ action: 'abort' }); }
      callback(new ResourceError('stream_closed', [], operation.operationId));
    } else send({ action: 'stdin', data: chunk.toString('base64') }, callback);
  }, final(callback) {
    if (!decision && !terminal) send({ action: 'eof' }, callback);
    else callback();
  } });
  const fail = () => {
    if (terminal) return;
    terminal = true;
    const error = new ResourceError('outcome_unknown', [], operation.operationId);
    rejectStart(error); rejectReceipt(error);
    stdin.destroy(); stdout.end(); stderr.end(); socket.destroy();
  };
  socket.setTimeout((operation.timeoutMs ?? 30000) + 15000, fail);
  socket.once('connect', () => send({ ...operation, action: 'run', interactive: true,
    claims: operation.claims.map(({ resource, id }) => ({ resource, claim: id })),
    reads: (operation.reads ?? []).map(({ resource, evidence }) => ({ resource, evidence })),
    ...(transport.workerUid !== undefined ? { workerUid: transport.workerUid } : {}) }));
  socket.on('error', fail);
  socket.on('end', fail);
  socket.on('data', chunk => {
    buffer += chunk.toString();
    if (buffer.length > 32 * 1024 * 1024) { fail(); return; }
    while (buffer.includes('\n')) {
      const offset = buffer.indexOf('\n');
      const raw = buffer.slice(0, offset); buffer = buffer.slice(offset + 1);
      try {
        const frame = JSON.parse(raw);
        if (frame.started === true && frame.homePath === RESOURCE_PROFILE_HOME) resolveStart(frame.homePath);
        else if (frame.stream === 'stdout' || frame.stream === 'stderr') {
          const name: 'stdout' | 'stderr' = frame.stream;
          const bytes = Buffer.from(frame.data, 'base64');
          counts[name] += bytes.length;
          if (counts[name] > limit) { decision = true; send({ action: 'abort' }); }
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
  return { stdin, stdout, stderr, homePath, completed, complete: () => finish('complete'), abort: () => finish('abort') };
}
