import { createConnection, type Socket } from 'node:net';
import { ResourceError, type ResourceWorkspace } from '@abloatai/transaction';

type Event = { sequence: number; path: string; revision: number; operation: string };
export interface ResourceChanges { events: readonly Event[]; cursor: number }

/** A reconnectable worker connection. Lost requests are never automatically replayed. */
export function connect(socketPath: string, options: { workerUid?: number; timeoutMs?: number }) {
  let socket: Socket | undefined, input = '', serial = 0, closed = false;
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout; operationId?: string }>();
  let watcher: { event(batch: ResourceChanges): void; fail(error: Error): void } | undefined;
  const fail = (connection: Socket) => {
    if (socket !== connection) return;
    socket = undefined; input = ''; connection.destroy();
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new ResourceError(task.operationId ? 'outcome_unknown' : 'connection_lost', [], task.operationId)); }
    pending.clear();
    const watching = watcher; watcher = undefined;
    watching?.fail(new ResourceError('resync_required'));
  };
  const ensure = () => {
    if (closed) throw new ResourceError('connection_closed');
    if (socket) return socket;
    const connection = createConnection(socketPath);
    socket = connection;
    connection.setEncoding('utf8');
    connection.unref();
    connection.on('error', () => fail(connection));
    connection.on('close', () => fail(connection));
    connection.on('data', chunk => {
      if (socket !== connection) return;
      input += chunk.toString();
      if (Buffer.byteLength(input) > 32 * 1024 * 1024) { fail(connection); return; }
      while (input.includes('\n')) {
        const offset = input.indexOf('\n'), line = input.slice(0, offset); input = input.slice(offset + 1);
        try {
          const frame = JSON.parse(line);
          if (frame.event === 'resync_required') { fail(connection); return; }
          if (frame.event === 'changes') { watcher?.event(frame); continue; }
          const task = pending.get(frame.id);
          if (!task) throw new Error('Unexpected response');
          pending.delete(frame.id); clearTimeout(task.timer);
          if (frame.error) task.reject(new ResourceError(frame.error.code, frame.error.resources, task.operationId));
          else task.resolve(frame.result);
          if (!pending.size && !watcher) connection.unref();
        } catch { fail(connection); return; }
      }
    });
    return connection;
  };
  const request: ResourceWorkspace['request'] = request => new Promise((resolve, reject) => {
    if (pending.size >= 16) { reject(new ResourceError('adapter_busy')); return; }
    let connection: Socket;
    try { connection = ensure(); } catch (error) { reject(error); return; }
    const id = String(++serial);
    const bytes = JSON.stringify({ id, request: { ...request, ...(options.workerUid !== undefined ? { workerUid: options.workerUid } : {}) } }) + '\n';
    if (Buffer.byteLength(bytes) > 16 * 1024 * 1024) { reject(new ResourceError('request_too_large')); return; }
    connection.ref();
    const timer = setTimeout(() => fail(connection), options.timeoutMs ?? 310000);
    pending.set(id, { resolve, reject, timer, operationId: typeof request.operationId === 'string' ? request.operationId : undefined });
    connection.write(bytes);
  });
  return {
    request,
    close() { closed = true; if (socket) fail(socket); },
    async watch(resources: readonly string[], options: { after?: number; onChanges(batch: ResourceChanges): void; onError(error: Error): void }) {
      if (watcher) throw new ResourceError('subscription_exists');
      const interested = new Set(resources);
      let cursor = options.after ?? 0, catchingUp = true;
      const queued: ResourceChanges[] = [];
      const deliver = (batch: ResourceChanges) => {
        const events = batch.events.filter(event => event.sequence > cursor && interested.has(event.path.startsWith('ref:') ? event.path : `file:${event.path}`));
        cursor = Math.max(cursor, batch.cursor);
        if (events.length) options.onChanges({ events, cursor });
      };
      const subscription = { event(batch: ResourceChanges) {
        if (catchingUp) { if (queued.length >= 256) { if (socket) fail(socket); } else queued.push(batch); }
        else deliver(batch);
      }, fail: options.onError };
      watcher = subscription;
      try {
        await request({ action: 'subscribe', resources, after: cursor });
        socket?.ref();
        while (true) {
          const batch = await request({ action: 'changes', after: cursor }) as ResourceChanges;
          deliver(batch);
          if (batch.events.length < 100) break;
        }
        if (watcher !== subscription) throw new ResourceError('resync_required');
        catchingUp = false;
        queued.forEach(deliver);
      } catch (error) { if (watcher === subscription) watcher = undefined; throw error; }
      return { get cursor() { return cursor; }, async close() {
        if (watcher !== subscription) return;
        watcher = undefined;
        await request({ action: 'unsubscribe' });
      } };
    },
  };
}
