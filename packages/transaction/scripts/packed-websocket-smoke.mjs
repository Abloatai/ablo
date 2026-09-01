import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { z } from 'zod';

const packageDir = process.cwd();
const workDir = mkdtempSync(join(packageDir, '.packed-websocket-consumer-'));

class PackedConsumerWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  readyState = PackedConsumerWebSocket.CONNECTING;
  sent = [];
  onopen = null;
  onclose = null;
  onerror = null;
  onmessage = null;

  constructor(_url, protocols) {
    this.protocols = protocols;
    PackedConsumerWebSocket.instances.push(this);
  }

  open() {
    this.readyState = PackedConsumerWebSocket.OPEN;
    this.onopen?.();
  }

  send(value) {
    this.sent.push(JSON.parse(value));
  }

  receive(frame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  close() {
    this.readyState = PackedConsumerWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: 'closed' });
  }
}

const waitFor = async (predicate, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('packed WebSocket smoke test timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

try {
  const report = JSON.parse(execFileSync(
    'npm',
    ['pack', '--json', '--pack-destination', workDir],
    {
      cwd: packageDir,
      encoding: 'utf8',
      env: { ...process.env, npm_config_cache: join(workDir, 'npm-cache') },
    },
  ))[0];
  if (!report?.filename) throw new Error('npm pack produced no tarball');
  execFileSync('tar', ['-xzf', join(workDir, report.filename), '-C', workDir]);

  globalThis.WebSocket = PackedConsumerWebSocket;
  const packed = await import(pathToFileURL(join(workDir, 'package/dist/index.js')).href);
  const packedSchema = await import(
    pathToFileURL(join(workDir, 'package/dist/schema/index.js')).href
  );
  const schema = packedSchema.defineSchema({ items: packedSchema.model({ done: z.boolean() }) });
  const authority = {
    organizationId: 'org-packed', projectId: 'project-packed', branchId: 'branch-packed',
    syncGroups: ['org:org-packed'], operations: [], participantKind: 'agent',
    participantId: 'agent-packed', deliveryPartition: null,
  };
  const client = packed.Ablo({
    schema,
    session: {
      object: 'session',
      token: 'rk_packed',
      expiresAt: '2030-08-30T12:00:00.000Z',
    },
    baseURL: 'https://packed.example.test',
    fetch: () => Promise.resolve(new Response(JSON.stringify({
      participantKind: 'agent', participantId: 'agent-packed', accountScope: 'org-packed',
      projectId: 'project-packed', branchId: 'branch-packed', branchRoot: false,
      syncGroups: ['org:org-packed'], deliveryPartition: null, authority, userMeta: {},
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
  });

  const opening = client.ready();
  await waitFor(() => PackedConsumerWebSocket.instances.length === 1);
  const socket = PackedConsumerWebSocket.instances[0];
  socket.open();
  await opening;
  const committing = client.commits.create({
    idempotencyKey: 'packed-commit-1',
    operations: [{ action: 'update', model: 'items', id: 'item-1', data: { done: true } }],
  });
  await waitFor(() => socket.sent.some((frame) => frame.type === 'commit'));
  socket.receive({
    type: 'mutation_result',
    payload: {
      object: 'commit_receipt', clientTxId: 'packed-commit-1', serverTxId: 'server-packed-1',
      success: true, ops: 1, authority, createdAt: '2026-08-30T12:00:00.000Z',
      status: 'confirmed', statusAt: '2026-08-30T12:00:00.000Z', lastSyncId: 1,
    },
  });
  const receipt = await committing;
  if (receipt.status !== 'confirmed' || receipt.lastSyncId !== 1) {
    throw new Error(`packed client returned an invalid receipt: ${JSON.stringify(receipt)}`);
  }
  await client.dispose();
  console.log('[pack:smoke:websocket] OK: packed Ablo client opened WebSocket and confirmed a commit');
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
