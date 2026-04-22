# Getting Started

From zero to multiplayer sync in 5 minutes. No server setup required.

## 1. Install

```bash
npx create-ablo-app my-app
cd my-app
npm run dev
```

Or add to an existing project:

```bash
npm install @ablo/sync-engine
```

## 2. Get an API key

Sign up at [ablo.dev](https://ablo.dev) and create a project. Copy your API key (`sk_live_...`).

Add it to `.env.local`:

```
ABLO_SYNC_URL=wss://sync.ablo.dev
ABLO_API_KEY=sk_live_your_key_here
```

## 3. Define your schema — `ablo.schema.ts`

One file at your project root. Pure and declarative — safe to import from anywhere (server components, Node agents, tests). This is the **canonical location**; every example in these docs assumes it.

```typescript
// ablo.schema.ts
import { defineSchema, mutable, readOnly, z } from '@ablo/sync-engine/schema';

export const schema = defineSchema({
  projects: mutable(
    {
      name: z.string(),
      status: z.enum(['active', 'archived']).default('active'),
    },
    { syncGroupFormat: 'project:{id}' },
  ),

  tasks: mutable(
    {
      title: z.string(),
      status: z.enum(['todo', 'doing', 'done']).default('todo'),
      priority: z.number().default(0),
      description: z.string().optional(),
    },
    { parent: 'projects' },
  ),
});
```

`mutable.*` marks writable models. `readOnly.*` marks server-owned tables. `syncGroupFormat` declares a scope root; `parent` attaches children. Types are inferred automatically — no codegen, no build step.

> **This is not a database migration.** The schema is your client-side type + sync-group contract. You still own your DB schema via Prisma, Drizzle, raw SQL — whatever. See [schema-vs-db.md](./schema-vs-db.md).

> **In a monorepo?** If your schema needs to be imported by multiple apps (web + agent-worker + tests), put it in its own workspace package (`packages/my-schema/`) instead of a root file. See [monorepo.md](./monorepo.md). Ablo's own codebase uses this layout.

## 4. Declare the typed global — `ablo.schema.d.ts`

One-time declaration, next to the schema file. Enables every hook to type itself from your schema with zero generics at the call site.

```typescript
// ablo.schema.d.ts
import type { schema } from './ablo.schema';

declare global {
  interface AbloSync {
    Schema: typeof schema;
  }
}
export {};
```

## 5. Wire the runtime — `src/ablo.ts`

Kept separate from `ablo.schema.ts` because this file has side effects (opens a WebSocket, mints tokens). The schema file stays importable from anywhere.

```typescript
// src/ablo.ts
import { createSyncEngine } from '@ablo/sync-engine/client';
import { schema } from '../ablo.schema';

export const sync = createSyncEngine({
  url: process.env.ABLO_SYNC_URL!,
  apiKey: process.env.ABLO_API_KEY!,
  schema,
});
```

That's it. WebSocket connection, offline storage, mutation queue, real-time sync — all handled.

### Waiting for the initial data

`createSyncEngine()` returns immediately. Before you can query data, call `await sync.ready()` — it loads the initial bootstrap, connects the WebSocket, and resolves when you can start querying.

```typescript
import { sync } from './sync';

await sync.ready(); // loads data from the server
const tasks = sync.tasks.findMany(); // now has data
```

If you skip `ready()`, `findMany()` returns an empty array until bootstrap finishes. The `sync.syncStatus` observable tells you what's happening:

```typescript
sync.syncStatus.state
// 'syncing'      — initial bootstrap in progress
// 'idle'         — connected and up to date
// 'error'        — bootstrap failed (check sync.syncStatus.error)
// 'offline'      — no network (mutations queue locally)
// 'reconnecting' — trying to reconnect
```

### The optimistic-first contract

Mutations (`create`, `update`, `delete`) are **optimistic and offline-first**. The promise resolves when the mutation is queued locally — **not** when the server confirms. This is intentional: it keeps the UI instant and lets mutations work offline.

```typescript
await sync.tasks.create({ title: 'Fix bug' });
// UI already shows the task. Server will confirm async.
```

If the server rejects the mutation later, the sync engine automatically rolls back the optimistic change. Watch `sync.syncStatus` to detect rollbacks.

## 5. Use it

### Option A: Client API (any framework)

```typescript
import { sync } from './sync';

// Create
const task = await sync.tasks.create({
  title: 'Review pull request',
  projectId: 'proj_123',
});

// Query
const todos = sync.tasks.findMany({
  where: { status: 'todo' },
  orderBy: { priority: 'desc' },
});

// Update
await sync.tasks.update(task.id, { status: 'done' });

// Delete
await sync.tasks.delete(task.id);

// Subscribe to real-time changes
const unsub = sync.tasks.subscribe((tasks) => {
  console.log('Todo count:', tasks.length);
}, { where: { status: 'todo' } });
```

### Option B: React hooks

With `ablo.schema.d.ts` in place, hooks type themselves from the `AbloSync` global — no generics, no `schema` prop, no wrapper required.

```tsx
import { useQuery, useMutate } from '@ablo/sync-engine/react';

function TaskList() {
  const todos = useQuery('tasks', { where: { status: 'todo' } });
  const mutate = useMutate('tasks');

  return (
    <ul>
      {todos.map((task) => (
        <li key={task.id}>
          {task.title}
          <button onClick={() => mutate.update({ id: task.id, status: 'done' })}>
            Done
          </button>
        </li>
      ))}
      <button onClick={() => mutate.create({ title: 'New task' })}>Add Task</button>
    </ul>
  );
}
```

Mount the provider once at the root:

```tsx
import { SyncProvider } from '@ablo/sync-engine/react';
import { sync } from './ablo';

<SyncProvider store={sync} organizationId={orgId}>
  <App />
</SyncProvider>
```

Hooks self-subscribe via `useSyncExternalStore` — no `withSync()` wrapper needed. Open the app in two browser tabs; create a task in one — it appears in the other instantly.

## 6. Add an AI agent (optional)

```typescript
import { SyncAgent } from '@ablo/sync-engine/agent';

const agent = new SyncAgent({
  url: process.env.ABLO_SYNC_URL!,
  token: process.env.ABLO_API_KEY!,
  agentId: 'auto-prioritizer',
  syncGroups: ['org:default'],
});

agent.on('tasks', { where: { status: 'todo' } }, async (task) => {
  // AI logic here — e.g., auto-set priority based on title
  const priority = task.title.includes('urgent') ? 10 : 0;
  await agent.update('tasks', task.id, { priority });
});

await agent.connect();
```

The agent's mutations show up in real-time for all connected clients, attributed as `createdBy: "agent:auto-prioritizer"`.

## Local development

There's nothing to run locally besides your app. `sync.ablo.dev` handles the sync server, database, and WebSocket infrastructure.

```bash
npm run dev    # start your Next.js / Vite app
               # sync.ablo.dev handles everything else
```

Your dev workflow:
1. Define models in `ablo.schema.ts` at your project root
2. Declare the `AbloSync` global once in `ablo.schema.d.ts`
3. Use hooks (`useQuery`, `useMutate`) in your components — zero generics
4. Open two browser tabs to test multiplayer

No Docker, no PostgreSQL, no Redis, no Go server. The managed service is the only supported deployment today — if compliance or data residency requires on-prem, get in touch.

## What just happened

```
Your app                sync.ablo.dev              Other clients
  │                          │                          │
  ├─ create task ───────────→│                          │
  │  (optimistic — UI        │──── delta broadcast ────→│
  │   updates instantly)     │                          │  (task appears)
  │                          │                          │
  │  (IndexedDB persists     │                          │
  │   for offline support)   │                          │
```

1. Your app sends mutations to `sync.ablo.dev` via WebSocket
2. The server persists to PostgreSQL and broadcasts deltas to all clients
3. Other clients (and agents) receive the delta and update in real-time
4. Everything is cached in IndexedDB — your app works offline too

## Next steps

- [Schema Definition](./schema.md) &mdash; All field types, relations, reference forms
- [Schema vs. Database](./schema-vs-db.md) &mdash; How the client schema relates to your DB migrations
- [Client SDK](./client.md) &mdash; Full query and mutation API
- [React Hooks](./react.md) &mdash; hook-by-hook reference
- [Authentication](./auth.md) &mdash; Bring your own auth provider
- [Offline & Sync Groups](./offline-and-sync-groups.md) &mdash; Offline support, permission scoping
- [Agent SDK](./agent.md) &mdash; AI agents as sync participants
