import type { DetectedOrm, InitStorage } from './options';

export function generateSchema(): string {
  return `import { defineSchema, model, relation, z } from '@abloatai/ablo/schema';

export const schema = defineSchema({
  // Models are writable (mutable) by default — declaring one here is the
  // opt-in. For server-managed read-only projections, pass
  // \`{ mutable: false }\` as the model's third argument.
  workspaces: model({
    name: z.string(),
    status: z.enum(['active', 'archived']).default('active'),
    description: z.string().optional(),
  }),

  records: model({
    title: z.string(),
    status: z.enum(['todo', 'doing', 'done']).default('todo'),
    priority: z.number().default(0),
    workspaceId: z.string().optional(),
    assigneeId: z.string().optional(),
    description: z.string().optional(),
    dueDate: z.date().optional(),
  }, {
    workspace: relation.belongsTo('workspaces', 'workspaceId'),
  }),
});
`;
}

export function generateSyncConfig(auth: string, options: { serverOnly?: boolean } = {}): string {
  const authLine = auth === 'apikey'
    ? ''
    : auth === 'firebase'
    ? `\n  auth: async () => {\n    const { getAuth } = await import('firebase/auth');\n    const user = getAuth().currentUser;\n    return user ? await user.getIdToken() : '';\n  },`
    : auth === 'auth0'
    ? `\n  // auth: () => getAccessTokenSilently(), // uncomment after Auth0 setup`
    : auth === 'clerk'
    ? `\n  // auth: () => getToken(), // uncomment after Clerk setup`
    : auth === 'supabase'
    ? `\n  // auth: async () => { const { data } = await supabase.auth.getSession(); return data.session?.access_token ?? ''; },`
    : auth === 'betterauth'
    ? `\n  // auth: async () => { const session = await authClient.getSession(); return session?.token ?? ''; },`
    : `\n  // auth: () => 'your-jwt-token', // replace with your auth provider`;

  return `${options.serverOnly ? "import 'server-only';\n\n" : ''}import Ablo from '@abloatai/ablo';
import { schema } from './schema';

// SERVER-ONLY client — it holds your \`sk_\` key. Use it from server code: the
// agent script and the /api/ablo-session route. Do NOT import this into a browser
// ('use client') component; the browser uses app/providers.tsx, which authenticates
// via the session route and never touches the key.
export const sync = Ablo({
  apiKey: process.env.ABLO_API_KEY,${authLine}
  schema,
});

// Name the client's type off the constructed value — the overload resolves at
// this call site, so this carries the full typed surface. (Like tRPC's
// \`typeof appRouter\`, Drizzle's \`typeof db\`.) Prefer this over \`ReturnType<typeof Ablo>\`.
export type Sync = typeof sync;
`;
}

export function generateRegister(): string {
  return `import type { schema } from './schema';

declare module '@abloatai/ablo' {
  interface Register {
    Schema: typeof schema;
  }
}

export {};
`;
}

export function generateEnv(storage: InitStorage, opts: { includeApiKey?: boolean } = {}): string {
  const { includeApiKey = true } = opts;
  const databaseBlock = storage === 'replication'
    ? '# Used by `npx ablo connect` to set up + register logical replication — the\n' +
      '# DIRECT (un-pooled) endpoint. Ablo TAILS your WAL from here; it never writes.\n' +
      '# The client never sees it; the browser never sees it. Your DB stays yours.\n' +
      'DATABASE_URL=postgres://user:password@host:5432/db\n'
    : '# Used by ablo/data-source.ts (your DB endpoint) + `ablo migrate` — NOT the client.\n' +
      '# Ablo never sees it; the browser never sees it. Your DB stays in your app.\n' +
      'DATABASE_URL=postgres://user:password@host:5432/db\n';
  const webhookBlock = storage === 'endpoint'
    ? '# Signing secret for the webhook receiver (app/api/ablo/webhooks/route.ts).\n' +
      '# Ablo mints this when you register the endpoint\'s URL (POST /v1/webhook_endpoints\n' +
      '# or the dashboard) and returns it once — paste it here.\n' +
      'ABLO_WEBHOOK_SECRET=whsec_your_endpoint_secret_here\n'
    : '';
  const apiKeyBlock = includeApiKey
    ? '# Ablo: a branch-bound sk_ key (`npx ablo dev` writes it for you).\n' +
      '# The key names its own project and branch, so nothing else is needed here.\n' +
      'ABLO_API_KEY=sk_your_key_here\n'
    : '';
  return `${apiKeyBlock}${webhookBlock}${databaseBlock}`;
}

export function generateDataSource(orm: DetectedOrm): string {
  return orm === 'drizzle' ? drizzleDataSourceScaffold() : prismaDataSourceScaffold();
}

function prismaDataSourceScaffold(): string {
  return `import { dataSourceNext } from '@abloatai/ablo/source/next';
import { prismaDataSource } from '@abloatai/ablo/source';
import { PrismaClient } from '@prisma/client';
import { schema } from './schema';

// Your database stays in THIS app — Ablo never sees DATABASE_URL. It only calls
// the signed endpoint below, and \`prismaDataSource\` runs the write in your own
// Prisma transaction, driven entirely by your Zod \`schema\`: it applies each
// operation, records idempotency by clientTxId, and appends the transactional
// outbox — all in ONE transaction. No commit or event-handling code to hand-write.
//
// Run \`npx ablo migrate\` to provision the ABLO model tables AND the adapter's two
// bookkeeping tables (ablo_idempotency, ablo_outbox). It does NOT touch your other
// tables — keep using \`prisma migrate\` for auth + any non-Ablo models.
export const runtime = 'nodejs'; // PrismaClient needs the Node runtime, not edge
const prisma = new PrismaClient();

export const { POST } = dataSourceNext({
  schema,
  apiKey: process.env.ABLO_API_KEY!,
  adapter: prismaDataSource(prisma, schema),
});
`;
}

function drizzleDataSourceScaffold(): string {
  return `import { dataSourceNext } from '@abloatai/ablo/source/next';
import { drizzleDataSource } from '@abloatai/ablo/source/drizzle';
import { drizzle } from 'drizzle-orm/node-postgres';
import { schema } from './schema';

// Your database stays in THIS app — Ablo never sees DATABASE_URL. It only calls
// the signed endpoint below, and \`drizzleDataSource\` runs the write in your own
// transaction. It derives table + column names straight from your Zod \`schema\`
// (the SAME rule \`ablo migrate\` provisions), so you don't keep a second Drizzle
// definition for the SYNCED models. Your other tables — auth, billing, anything
// not in this Ablo schema — stay in your own Drizzle schema, managed by
// drizzle-kit. One database, two schemas side by side: Ablo owns the synced
// models, you own the rest.
//
// Driver note: the commit is an INTERACTIVE transaction, so use a driver that
// supports one — node-postgres (any Postgres) or neon-serverless (Neon over
// WebSocket). Neon's HTTP driver (neon-http) is single-shot and throws on commit.
//
// Run \`npx ablo migrate\` to provision the ABLO model tables AND the adapter's two
// bookkeeping tables (ablo_idempotency, ablo_outbox). It does NOT touch your other
// tables — keep using drizzle-kit for auth + any non-Ablo models.
export const runtime = 'nodejs'; // node-postgres + interactive transactions need Node, not edge
const db = drizzle(process.env.DATABASE_URL!);

export const { POST } = dataSourceNext({
  schema,
  apiKey: process.env.ABLO_API_KEY!,
  adapter: drizzleDataSource(db, schema),
});
`;
}

export function generateWebhookRoute(orm: DetectedOrm): string {
  return orm === 'prisma' ? prismaWebhookRoute() : neutralWebhookRoute();
}

const WEBHOOK_INTRO = `import { Webhook } from 'svix'; // any Standard Webhooks lib works (svix / standardwebhooks)
import type { AbloWebhookEvent } from '@abloatai/ablo/webhooks';`;

const WEBHOOK_DOC = `/**
 * The "Ablo → your database" half of the loop.
 *
 * Ablo owns the ordered transaction log (the source of truth) and streams every
 * committed change here as a SIGNED Standard-Webhooks event. You verify the
 * signature, then write each change into YOUR database. The other half — your app
 * MAKING changes + live sync — is the Ablo client in \`ablo/index.ts\`.
 *
 * Your app calls Ablo to make changes, and Ablo calls this route to persist
 * them. Reliability is built in — Ablo retries on any
 * non-2xx, and \`event.syncId\` is a monotonic log position, so apply in order and
 * dedupe (skip a \`syncId\` you've already stored).
 */`;

function prismaWebhookRoute(): string {
  return `${WEBHOOK_INTRO}
import { PrismaClient } from '@prisma/client';

${WEBHOOK_DOC}
// Scaffolded WORKING: mirrors every model with one generic upsert/delete — NO
// per-model code. Edit only if your tables diverge from Ablo's schema.
const wh = new Webhook(process.env.ABLO_WEBHOOK_SECRET!);
const prisma = new PrismaClient();

/** The slice of a Prisma model delegate this route uses. */
type ModelDelegate = {
  upsert(args: {
    where: { id: string };
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }): Promise<unknown>;
  delete(args: { where: { id: string } }): Promise<unknown>;
};

/** \`event.model\` arrives over the wire, so the delegate it names is checked, not assumed. */
function isModelDelegate(value: unknown): value is ModelDelegate {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'upsert' in value &&
    typeof value.upsert === 'function' &&
    'delete' in value &&
    typeof value.delete === 'function'
  );
}

export async function POST(req: Request): Promise<Response> {
  const body = await req.text(); // RAW body — required for signature verification
  let batch: { data: AbloWebhookEvent[] };
  try {
    batch = wh.verify(body, Object.fromEntries(req.headers)) as { data: AbloWebhookEvent[] };
  } catch {
    return new Response('invalid signature', { status: 400 });
  }

  // Apply in log order. \`event.model\` is the model name (e.g. "record" → prisma.record).
  const events = [...batch.data].sort((a, b) => a.syncId - b.syncId);

  for (const event of events) {
    const model: unknown = Reflect.get(prisma, event.model); // prisma.record, prisma.task, …
    if (!isModelDelegate(model)) continue; // a model you don't mirror locally — skip it
    if (event.data === null) {
      await model.delete({ where: { id: event.objectId } }).catch((error) => {
        // Idempotent replay: a missing local row is already the desired state.
        void error;
      });
    } else {
      await model.upsert({ where: { id: event.objectId }, create: event.data, update: event.data });
    }
  }

  return new Response(null, { status: 200 }); // 2xx fast; do heavy work async if needed
}
`;
}

function neutralWebhookRoute(): string {
  return `${WEBHOOK_INTRO}

${WEBHOOK_DOC}
const wh = new Webhook(process.env.ABLO_WEBHOOK_SECRET!);

export async function POST(req: Request): Promise<Response> {
  const body = await req.text(); // RAW body — required for signature verification
  let batch: { data: AbloWebhookEvent[] };
  try {
    batch = wh.verify(body, Object.fromEntries(req.headers)) as { data: AbloWebhookEvent[] };
  } catch {
    return new Response('invalid signature', { status: 400 });
  }

  for (const event of [...batch.data].sort((a, b) => a.syncId - b.syncId)) {
    // event.model = table name   event.objectId = row id   event.data = row (null on delete)
    // TODO: write into your database — one generic upsert/delete, no per-model code, e.g.:
    //
    //   if (event.data === null) {
    //     await db.deleteFrom(event.model).where('id', '=', event.objectId).execute();
    //   } else {
    //     await db.insertInto(event.model).values(event.data)
    //       .onConflict((c) => c.column('id').doUpdateSet(event.data)).execute();
    //   }
    void event;
  }

  return new Response(null, { status: 200 }); // 2xx fast; do heavy work async if needed
}
`;
}

export function generateAgent(): string {
  return `import { sync as ablo } from './sync';

/**
 * An AI "teammate" that works the same synced records a human does.
 *
 * Run it with \`npx tsx ablo/agent.ts\` while the app is open in a browser tab —
 * its writes appear there instantly (same as another human), and stream in
 * \`npx ablo logs\`. That's the whole idea: agents and people on one typed,
 * synced dataset.
 */
async function main() {
  await ablo.ready();

  // File some work, like a teammate would.
  await ablo.records.create({ data: { title: 'Draft the Q3 roadmap', status: 'todo' } });
  const urgent = await ablo.records.create({ data: { title: 'URGENT: fix the login bug', status: 'todo' } });
  console.log('created 2 records');

  // Triage the urgent one to the top. We write based on the version we just
  // read (\`readAt\`), so if a human edits the same row at the same moment the
  // write is rejected instead of silently clobbering them.
  const snap = ablo.snapshot({ records: urgent.id });
  await ablo.records.update({
    id: urgent.id,
    data: { priority: 10 },
    readAt: snap.stamp,
    onStale: 'reject',
  });
  console.log('prioritized:', urgent.title);

  console.log('done — check your browser tab and \`npx ablo logs\`');
  process.exit(0);
}

main().catch((err) => {
  // Ablo errors stringify to one clean line (code + message + docs link),
  // never a stack/object dump — see AbloError.toString().
  process.stderr.write(String(err) + '\\n');
  process.exit(1);
});
`;
}

export function generateComponent(): string {
  return `'use client';

import { useAblo } from '@abloatai/ablo/react';
import { useState } from 'react';

// Browser component. It reads + writes through the Ablo client in context
// (mounted by app/providers.tsx) — it never imports the server \`sk_\` client.
export function RecordList() {
  const ablo = useAblo(); // typed client for writes (null until the provider is ready)
  const records = useAblo((a) => a.records.local.list({ where: { status: 'todo' }, orderBy: { priority: 'desc' } })) ?? [];
  const [title, setTitle] = useState('');

  const handleCreate = async () => {
    if (!title.trim() || !ablo) return;
    await ablo.records.create({ data: { title, status: 'todo' } });
    setTitle('');
  };

  return (
    <div>
      <h2>Records ({records.length})</h2>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          placeholder="Add a record..."
          style={{ flex: 1, padding: 8 }}
        />
        <button onClick={handleCreate}>Add</button>
      </div>

      <ul style={{ listStyle: 'none', padding: 0 }}>
        {records.map((record) => (
          <li key={record.id} style={{ display: 'flex', justifyContent: 'space-between', padding: 8, borderBottom: '1px solid #eee' }}>
            <span>{record.title}</span>
            <button onClick={() => ablo?.records.update({ id: record.id, data: { status: 'done' } })}>
              Done
            </button>
          </li>
        ))}
      </ul>

      {records.length === 0 && <p style={{ color: '#999' }}>No records yet. Add one above.</p>}
    </div>
  );
}
`;
}
