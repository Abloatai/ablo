import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startOwnedRun } from '../src/agent/lifetime.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
test('contention skips execution and still disposes', async () => {
  let disposed = 0;
  const run = startOwnedRun({ acquire: async () => null, execute: async () => assert.fail('must skip'), dispose: async () => { disposed++; } });
  await run.done;
  assert.equal(disposed, 1);
  assert.equal(run.status, 'skipped');
  assert.equal(run.executions, 0);
});
test('failed acquisition disposes the client', async () => {
  let disposed = false;
  const run = startOwnedRun({ acquire: async () => { throw Error('init'); }, execute: async () => {}, dispose: async () => { disposed = true; } });
  await assert.rejects(run.done, /init/);
  assert.equal(disposed, true);
});
test('first write failure releases and disposes', async () => {
  const events: string[] = [];
  const run = startOwnedRun({ acquire: async () => ({ release: async () => { events.push('release'); } }), execute: async () => { throw Error('first write'); }, dispose: async () => { events.push('dispose'); } });
  await assert.rejects(run.done, /first write/);
  assert.deepEqual(events, ['release', 'dispose']);
  assert.equal(run.status, 'failed');
  assert.equal(run.executions, 1);
});
test('ownership loss aborts execution before another write', async () => {
  const executing = deferred();
  let lost!: (error: Error) => void;
  let writes = 0;
  const run = startOwnedRun({
    acquire: async onLost => { lost = onLost; return { release: async () => {} }; },
    execute: async (_, signal) => {
      executing.resolve();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      signal.throwIfAborted();
      writes++;
    }, dispose: async () => {},
  });
  await executing.promise;
  lost(Error('lease lost'));
  await assert.rejects(run.done, /lease lost/);
  assert.equal(writes, 0);
});
test('shutdown and stream completion share release and disposal', async () => {
  const executing = deferred(), finish = deferred();
  let releases = 0, disposals = 0;
  const run = startOwnedRun({
    acquire: async () => ({ release: async () => { releases++; } }),
    execute: async () => { executing.resolve(); await finish.promise; },
    dispose: async () => { disposals++; },
  });
  await executing.promise;
  const shutdown = run.stop();
  const duplicate = run.stop();
  finish.resolve();
  await Promise.all([shutdown, duplicate, run.done]);
  assert.equal(releases, 1);
  assert.equal(disposals, 1);
});
test('release failure still disposes', async () => {
  let disposed = false;
  const run = startOwnedRun({ acquire: async () => ({ release: async () => { throw Error('release failed'); } }), execute: async () => {}, dispose: async () => { disposed = true; } });
  await assert.rejects(run.done, /release failed/);
  assert.equal(disposed, true);
});
test('shutdown during acquisition releases a late grant without executing', async () => {
  const acquired = deferred();
  let released = false;
  const run = startOwnedRun({ acquire: async () => { await acquired.promise; return { release: async () => { released = true; } }; }, execute: async () => assert.fail('stopped'), dispose: async () => {} });
  const stopping = run.stop();
  acquired.resolve();
  await stopping;
  assert.equal(released, true);
  assert.equal(run.status, 'stopped');
  assert.equal(run.executions, 0);
});

test('completion is published only after release and disposal finish', async () => {
  const releasing = deferred(), finishRelease = deferred();
  const run = startOwnedRun({
    acquire: async () => ({ release: async () => { releasing.resolve(); await finishRelease.promise; } }),
    execute: async () => {}, dispose: async () => {},
  });
  await releasing.promise;
  assert.equal(run.status, 'executing');
  finishRelease.resolve();
  await run.done;
  assert.equal(run.status, 'completed');
  assert.equal(run.executions, 1);
});
