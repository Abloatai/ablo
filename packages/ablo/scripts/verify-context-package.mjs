/**
 * Clean-consumer proof for the published context().onChange surface.
 *
 * Required env: ABLO_API_KEY (non-live test key), DATABASE_URL.
 * Optional: ABLO_PACKAGE_VERSION (defaults to this package's version).
 */
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';
import postgres from 'postgres';

const apiKey = process.env.ABLO_API_KEY;
const databaseUrl = process.env.DATABASE_URL;
if (!apiKey || !databaseUrl) {
  throw new Error('ABLO_API_KEY and DATABASE_URL are required.');
}
if (apiKey.startsWith('sk_live_')) {
  throw new Error('Refusing to run against a live credential.');
}

const packageDir = new URL('..', import.meta.url).pathname;
const packageVersion = process.env.ABLO_PACKAGE_VERSION ??
  JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).version;
const workDir = mkdtempSync(join(tmpdir(), 'ablo-context-consumer-'));
const sql = postgres(databaseUrl, { prepare: false });

try {
  writeFileSync(join(workDir, 'package.json'), JSON.stringify({
    name: 'ablo-context-clean-consumer',
    private: true,
    type: 'module',
  }, null, 2));
  execFileSync('npm', [
    'install', '--ignore-scripts', '--no-audit', '--no-fund',
    `@abloatai/ablo@${packageVersion}`,
  ], { cwd: workDir, stdio: 'inherit' });

  const installedDir = join(workDir, 'node_modules', '@abloatai', 'ablo');
  const installedPackage = JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8'));
  if (installedPackage.version !== packageVersion) {
    throw new Error(`Installed ${installedPackage.version}; expected ${packageVersion}.`);
  }
  if (!installedPackage.exports?.['./context']) {
    throw new Error('Published package does not export @abloatai/ablo/context.');
  }
  const contextDocs = readFileSync(join(installedDir, 'docs', 'context.md'), 'utf8');
  const changelog = readFileSync(join(installedDir, 'CHANGELOG.md'), 'utf8');
  if (!contextDocs.includes('ctx.onChange') || !changelog.includes(`## ${packageVersion}`)) {
    throw new Error('Published package docs, changelog, and version do not agree.');
  }

  writeFileSync(join(workDir, 'consumer.mjs'), consumerSource());
  const organizationId = await resolveOrganization(sql);
  const cases = [];
  for (const mode of ['live', 'missed', 'stop']) {
    const id = randomUUID();
    const title = `published-context-${mode}-${id.slice(0, 8)}`;
    await sql`
      INSERT INTO cb_tasks (id, organization_id, title, status, created_at, updated_at)
      VALUES (${id}, ${organizationId}, ${title}, 'open', now(), now())
    `;
    try {
      cases.push(await runCase({ mode, id, title }));
    } finally {
      await sql`DELETE FROM cb_tasks WHERE id = ${id}`;
    }
  }

  console.log(JSON.stringify({
    package: `@abloatai/ablo@${packageVersion}`,
    consumer: 'clean registry install',
    cases,
  }, null, 2));
} finally {
  await sql.end({ timeout: 5 });
  rmSync(workDir, { recursive: true, force: true });
}

async function runCase({ mode, id, title }) {
  const child = spawn(process.execPath, ['consumer.mjs'], {
    cwd: workDir,
    env: {
      PATH: process.env.PATH ?? '',
      NODE_ENV: 'test',
      ABLO_API_KEY: apiKey,
      RECORD_ID: id,
      EXPECTED_TITLE: title,
      CASE_MODE: mode,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = readline.createInterface({ input: child.stdout });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const events = [];
  let changed = false;

  const exit = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${mode} consumer timed out. events=${JSON.stringify(events)}`));
    }, 45_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${mode} consumer exited ${code}: ${stderr.slice(0, 1000)}`));
    });
  });

  for await (const line of stdout) {
    const event = JSON.parse(line);
    events.push(event);
    if (mode === 'live' && event.type === 'subscribed' && !changed) {
      changed = true;
      await changeTask(sql, id, `${title}-changed`);
    }
    if (mode === 'missed' && event.type === 'read' && !changed) {
      changed = true;
      await changeTask(sql, id, `${title}-changed`);
      child.stdin.write('continue\n');
    }
    if (mode === 'stop' && event.type === 'subscribed') {
      child.stdin.write('stop\n');
    }
  }
  await exit;

  const staleEvents = events.filter((event) => event.type === 'stale');
  if (mode === 'stop') {
    if (!events.some((event) => event.type === 'request-aborted') || staleEvents.length !== 0) {
      throw new Error(`listener removal did not close cleanly: ${JSON.stringify(events)}`);
    }
  } else if (
    staleEvents.length !== 1 ||
    staleEvents[0].code !== 'stale_context' ||
    staleEvents[0].errorType !== 'AbloStaleContextError'
  ) {
    throw new Error(`${mode} did not receive exactly one stale-context error: ${JSON.stringify(events)}`);
  }
  return { mode, events: events.map((event) => event.type) };
}

async function changeTask(connection, id, title) {
  await connection`
    UPDATE cb_tasks SET title = ${title}, updated_at = now() WHERE id = ${id}
  `;
}

async function resolveOrganization(connection) {
  const configured = process.env.ABLO_ORG_ID;
  if (configured) return configured;
  const rows = await connection`
    SELECT organization_id FROM cb_tasks
    UNION ALL SELECT organization_id FROM cb_documents
    UNION ALL SELECT organization_id FROM cb_agent_runs
    LIMIT 1
  `;
  const id = rows[0]?.organization_id;
  if (!id) throw new Error('Could not resolve ABLO_ORG_ID from the test database.');
  return id;
}

function consumerSource() {
  return String.raw`
import Ablo, { AbloStaleContextError } from '@abloatai/ablo';
import { context } from '@abloatai/ablo/context';
import { defineSchema, model, z } from '@abloatai/ablo/schema';
import readline from 'node:readline';

const schema = defineSchema({
  tasks: model(
    { title: z.string(), status: z.enum(['open', 'claimed', 'done']) },
    { tableName: 'cb_tasks' },
  ),
});
const mode = process.env.CASE_MODE;
const recordId = process.env.RECORD_ID;
const expectedTitle = process.env.EXPECTED_TITLE;
const input = readline.createInterface({ input: process.stdin });
const commands = [];
const waiters = [];
input.on('line', (line) => (waiters.shift()?.(line) ?? commands.push(line)));
const command = () => commands.length > 0
  ? Promise.resolve(commands.shift())
  : new Promise((resolve) => waiters.push(resolve));
const emit = (event) => console.log(JSON.stringify(event));

let subscriptionOpened;
const opened = new Promise((resolve) => { subscriptionOpened = resolve; });
let requestAborted;
const aborted = new Promise((resolve) => { requestAborted = resolve; });
const trackedFetch = async (request, init) => {
  const url = new URL(typeof request === 'string' ? request : request instanceof URL ? request.href : request.url);
  const subscription = url.pathname.endsWith('/v1/subscriptions');
  if (subscription) {
    init?.signal?.addEventListener('abort', () => {
      emit({ type: 'request-aborted' });
      requestAborted();
    }, { once: true });
  }
  const response = await fetch(request, init);
  if (subscription) {
    const errorBody = response.ok ? null : (await response.clone().text()).slice(0, 1000);
    emit({
      type: 'subscribed',
      status: response.status,
      deliveryPartition: url.searchParams.get('deliveryPartition'),
      retryAfter: response.headers.get('retry-after'),
      routedPartition: response.headers.get('x-ablo-delivery-partition'),
      errorBody,
    });
    subscriptionOpened();
  }
  return response;
};

const ablo = Ablo({
  schema,
  apiKey: process.env.ABLO_API_KEY,
  transport: 'http',
  fetch: trackedFetch,
});
const ctx = await context({
  ablo,
  data: { task: ablo.tasks.read({ id: recordId }) },
});
if (!ctx.data.task || ctx.data.task.title !== expectedTitle) {
  throw new Error('fixture was not visible through the published package');
}
emit({ type: 'read' });

if (mode === 'missed') {
  await command();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const latest = await ablo.tasks.get({ id: recordId });
    if (latest?.title !== expectedTitle) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const changed = new Promise((resolve) => {
  const stop = ctx.onChange(resolve);
  void opened.then(async () => {
    if (mode !== 'stop') return;
    if (await command() !== 'stop') throw new Error('expected stop command');
    stop();
  });
});
await opened;

if (mode === 'stop') {
  await aborted;
  emit({ type: 'stopped' });
} else {
  const error = await changed;
  emit({
    type: 'stale',
    errorType: error instanceof AbloStaleContextError ? error.constructor.name : 'other',
    code: error.code,
  });
}
input.close();
`;
}
