/**
 * End-to-end Data Source demo.
 *
 * Run (from the package root — the examples/ folder has no package.json
 * of its own, so Node resolves module paths against the package root):
 *
 *   cd packages/sync-engine
 *   npx tsx examples/data-source/run.ts
 *
 * What this proves:
 *
 *   1. Ablo Cloud's signer + the customer's verifier interop. A wrong
 *      API key produces `source_signature_invalid`.
 *   2. `load`, `list`, `commit`, and `events` all flow through the
 *      same Fetch-API handler.
 *   3. The customer's "database" (here a Map) holds canonical rows.
 *      Ablo never sees them directly — only via the contract.
 *   4. Writes that touch the customer DB show up on the next `events`
 *      poll so Ablo Cloud can fan them out to other clients.
 */

import { handleAbloSource, _inspectStore } from './customer-server';
import { AbloDriver } from './ablo-driver';

const API_KEY =
  process.env.ABLO_API_KEY ?? 'sk_test_example_key_do_not_use_in_prod';

// `dataSource()` reads `options.apiKey` at request time; we re-export
// the same value to the driver so signer and verifier agree.
process.env.ABLO_API_KEY = API_KEY;

async function main() {
  const driver = new AbloDriver({
    handler: handleAbloSource,
    apiKey: API_KEY,
  });

  log('--- 1. load (existing seeded row) ---');
  const seeded = await driver.load('tasks', 'task_seed');
  log('loaded:', seeded);

  log('\n--- 2. commit (CREATE + UPDATE in one batch) ---');
  const committed = await driver.commit(
    [
      {
        type: 'CREATE',
        model: 'tasks',
        id: 'task_new',
        input: { title: 'Wire the data source', status: 'todo' },
      },
      {
        type: 'UPDATE',
        model: 'tasks',
        id: 'task_seed',
        input: { status: 'doing', assignee: 'alice' },
      },
    ],
    'cltx_demo_1',
  );
  log('committed rows:', committed);

  log('\n--- 3. list (all tasks after commit) ---');
  const listed = await driver.list('tasks');
  log('listed:', listed);

  log('\n--- 4. events (outbox feed for cross-channel writes) ---');
  const events = await driver.events();
  log('events:', events);

  log('\n--- 5. signature failure (wrong API key) ---');
  const badDriver = new AbloDriver({
    handler: handleAbloSource,
    apiKey: 'sk_test_wrong_key',
  });
  try {
    await badDriver.load('tasks', 'task_seed');
    throw new Error('expected signature failure');
  } catch (err) {
    log('rejected as expected:', (err as Error).message);
  }

  log('\n--- final customer DB state ---');
  log(_inspectStore());
}

function log(...args: unknown[]) {
  // Pretty-print objects so the demo output reads cleanly.
  console.log(
    ...args.map((arg) =>
      typeof arg === 'object' && arg !== null
        ? JSON.stringify(arg, null, 2)
        : arg,
    ),
  );
}

main().catch((err) => {
  console.error('data-source example failed:', err);
  process.exit(1);
});
