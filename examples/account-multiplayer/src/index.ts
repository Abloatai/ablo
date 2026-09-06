import { createServer } from 'node:http';
import { createServer as createViteServer } from 'vite';
import Ablo from '@abloatai/ablo';
import Sessions from '@abloatai/ablo/sessions';
import { schema } from './schema.js';
import { authenticate, authorizeAccount, grantAccount, grantWriter, signIn } from './accounts/index.js';
import { createAgentRunner } from './agent/index.js';

if (!process.env.ABLO_API_KEY || !process.env.DEMO_PASSWORD) {
  throw new Error('Set ABLO_API_KEY (an isolated branch key) and DEMO_PASSWORD. See README.md.');
}
const issuer = Sessions({ schema, apiKey: process.env.ABLO_API_KEY, baseURL: process.env.ABLO_BASE_URL });
const agents = createAgentRunner(issuer);
const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });

async function route(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== 'POST') return new Response('Use POST', { status: 405 });
  if (request.headers.get('origin') !== url.origin) return new Response('Origin denied', { status: 403 });
  if (url.pathname === '/api/login') {
    const { user, password } = await request.json();
    const token = typeof user === 'string' && typeof password === 'string' ? signIn(user, password) : null;
    return new Response(null, { status: token ? 204 : 401, headers: token ? {
      'Set-Cookie': `demo=${token}; HttpOnly; SameSite=Strict; Path=/`,
    } : {} });
  }
  const match = url.pathname.match(/^\/api\/accounts\/([^/]+)\/(session|create|rename|agent|agent-status)$/);
  if (!match) return new Response('Not found', { status: 404 });
  const account = decodeURIComponent(match[1]!);
  const user = authenticate(request);
  if (!user) return new Response('Sign in', { status: 401 });
  if (!authorizeAccount(user, account)) return new Response('Forbidden', { status: 403 });
  if (match[2] === 'session') {
    return issuer.handler({ authenticate, grant: ({ principal }) => grantAccount(principal, account) })(request);
  }
  if (match[2] === 'agent-status') {
    const { runId } = await request.json();
    const receipt = typeof runId === 'string' ? agents.getStatus(account, runId) : null;
    return receipt ? Response.json(receipt) : new Response('Run not found', { status: 404 });
  }
  if (match[2] === 'agent') {
    const { id } = await request.json();
    if (typeof id !== 'string') return new Response('Missing id', { status: 400 });
    return Response.json(agents.start(account, id), { status: 202 });
  }
  const grant = grantWriter(user, account)!;
  const client = Ablo({ schema, session: await issuer.create(grant), baseURL: process.env.ABLO_BASE_URL, transport: 'http' });
  try {
    if (match[2] === 'rename') {
      const { id, title } = await request.json();
      if (typeof id !== 'string' || typeof title !== 'string' || !title.trim()) {
        return new Response('Missing id or title', { status: 400 });
      }
      const row = await client.conversations.update({ id, data: { title } });
      return Response.json({ id: row.id });
    }
    const row = await client.conversations.create({ data: {
      accountId: account, title: `Chat in ${account}`, executionOwner: null, executionState: 'idle',
    } });
    return Response.json({ id: row.id });
  } finally { await client.dispose(); }
}

const server = createServer((req, res) => {
  if (!req.url?.startsWith('/api/')) { vite.middlewares(req, res); return; }
  void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    const request = new Request(`http://localhost:5173${req.url}`, {
      method: req.method, headers,
      ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
    });
    const response = await route(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  })().catch((error) => { console.error(error); res.writeHead(500); res.end('Request failed'); });
});
server.listen(5173, '127.0.0.1', () => console.log('Open http://localhost:5173 in two browser profiles.'));
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  await agents.stop();
  await vite.close();
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
