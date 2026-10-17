import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '../src/connection.ts';

test('a lost read is retryable, while a lost write requires receipt reconciliation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'resource-connection-'));
  const socketPath = join(directory, 'authority.sock');
  const server = createServer(socket => socket.once('data', () => socket.destroy()));
  const client = connect(socketPath, { timeoutMs: 1000 });
  try {
    server.listen(socketPath);
    await once(server, 'listening');
    await assert.rejects(client.request({ action: 'read', resource: 'file:a' }), { code: 'connection_lost' });
    const operationId = '1e2fe132-1d67-4ea4-aa38-12118c7bba7e';
    await assert.rejects(client.request({ action: 'write', operationId, resource: 'file:a' }), error => {
      assert.match((error as Error).message, /check its receipt before retrying/);
      assert.equal((error as { code?: string }).code, 'outcome_unknown');
      return true;
    });
  } finally {
    client.close();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
