# @ablo/sync-engine

Real-time multiplayer sync SDK for TypeScript. Schema-driven, offline-first, React hooks, capability-token auth, and AI agents as first-class participants.

Built for multiplayer productivity tools where every millisecond matters. The same engine powering [Ablo](https://ablo.finance) in production.

> **Installing with Claude Code, Cursor, or another AI assistant?** Point it at
> [`AGENTS.md`](AGENTS.md) — a step-by-step install playbook written for LLMs.
> TL;DR: create `ablo.schema.ts` at your project root, declare the `AbloSync`
> global in `ablo.schema.d.ts`, wire `<SyncProvider>` + `<AbloProvider>`, then
> call hooks without generics: `useQuery('tasks')`, `useMutate('tasks')`,
> `usePresence()`, `useIntent('editLayer')`. See
> [`docs/getting-started.md`](docs/getting-started.md) for the full pattern.

## Requirements

- **Node.js 22.0.0 or later.** The SDK uses Web Crypto (`crypto.subtle`, `crypto.randomUUID`) as globals, which are standardized on `globalThis.crypto` from Node 19+. We target Node 22 LTS to match the recommended sidecar runtime.
- **TypeScript 5.0+** for schema / mutator inference.
- **Browsers**: any modern evergreen browser (ES2022 target). Safari 16+, Chrome 110+, Firefox 110+.

## Quick Start

```bash
npm install @ablo/sync-engine mobx react
```

### 1. Define your schema — `ablo.schema.ts`

One file at your project root. Pure, declarative, side-effect-free. Safe to import from anywhere (server components, Node agents, tests).

```typescript
// ablo.schema.ts
import { defineSchema, mutable, readOnly, z } from '@ablo/sync-engine/schema';

export const schema = defineSchema({
  projects: mutable({ name: z.string() }, { syncGroupFormat: 'project:{id}' }),
  tasks:    mutable(
    {
      title: z.string(),
      status: z.enum(['todo', 'doing', 'done']).default('todo'),
      priority: z.number().default(0),
    },
    { parent: 'projects' },
  ),
  settings: readOnly({ theme: z.string() }),
});
```

`mutable.*` marks writable models; `readOnly.*` marks server-owned tables. `syncGroupFormat` declares the scope root; `parent` attaches children. That's the whole schema DSL for the 80% path.

### 2. Declare the typed global — `ablo.schema.d.ts`

One-time, next to the schema file. After this, every hook types itself from your schema with zero generics at the call site.

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

### 3. Wire the runtime — `src/ablo.ts` (or wherever your app boots)

Kept separate from the schema file because this one has side effects (opens a WebSocket). The schema file stays importable from anywhere.

```typescript
// src/ablo.ts
import Ablo from '@ablo/sync-engine';
import { createSyncEngine } from '@ablo/sync-engine/client';
import { schema } from '../ablo.schema';

export const sync = createSyncEngine({
  url: 'wss://mesh.ablo.finance',
  schema,
  apiKey: process.env.ABLO_API_KEY!,
  user: { id: userId, organizationId: orgId },
});

export const ablo = new Ablo({ schema });

await sync.ready();
```

### 4. Use in React

```tsx
import { SyncProvider, useQuery, useMutate } from '@ablo/sync-engine/react';
import { AbloProvider } from './ablo-context';       // from createAbloContext<typeof schema>()
import { sync, ablo } from './ablo';

function App() {
  return (
    <SyncProvider store={sync} organizationId={orgId}>
      <AbloProvider ablo={ablo}>
        <TaskList />
      </AbloProvider>
    </SyncProvider>
  );
}

function TaskList() {
  const tasks = useQuery('tasks', { where: { status: 'todo' }, orderBy: 'priority' });
  const mutate = useMutate('tasks');

  return (
    <ul>
      {tasks.map((task) => (
        <li key={task.id} onClick={() => mutate.update({ id: task.id, status: 'done' })}>
          {task.title}
        </li>
      ))}
      <button onClick={() => mutate.create({ title: 'New task' })}>Add</button>
    </ul>
  );
}
```

No generics, no `schema={}` prop drilling, no `withSync()` wrapping. Types flow from the `AbloSync` global; runtime flows from the two providers. Changes sync in real-time across all connected clients. Works offline. Rolls back on server rejection.

> **Alternative forms.** The plain `model()` declaration and the `InferModel<typeof schema, 'tasks'>` type helper still exist for advanced uses (utility functions outside React, CLI scripts, tests). See [`docs/schema.md`](docs/schema.md) § Reference.

## How It Works

```
Your App (React)
    │
    │  useQuery / useMutate
    ▼
ObjectPool (MobX observable in-memory cache)
    │                           ▲
    │  mutations                │  deltas
    ▼                           │
TransactionQueue ─── WebSocket ─┤
                                │
                         Ablo Sync Server
                                │
                    ┌───────────┼───────────┐
                    ▼           ▼           ▼
                PostgreSQL  Redis pub/sub  Other clients
```

**Optimistic updates** — mutations apply instantly to the ObjectPool. On server rejection, the UI rolls back automatically.

**Offline queue** — mutations made offline are persisted to IndexedDB and flushed on reconnect, in FK-safe topological order.

**Delta confirmation** — every mutation is confirmed via a WebSocket delta with a monotonic `syncId`. No data loss.

**Bootstrap + ghost removal** — on connect, the client fetches an initial snapshot and purges local entities not in the server's view, so stale optimistic state can't linger.

## React Hooks

All hooks assume `<SyncProvider>` is mounted and the `AbloSync` global is declared (see Quick Start). Hooks self-subscribe to the store — no wrapper needed.

| Hook | Purpose |
|------|---------|
| `useQuery('tasks', opts?)` | Reactive collection. IVM-backed — scales to large pools without full recomputes. |
| `useOne('tasks', id)` | Reactive single entity by id. `undefined` while loading or missing. |
| `useReader('tasks')` | Imperative snapshot reads (`findMany`, `findFirst`, `findById`, `count`). Does NOT subscribe. |
| `useMutate('tasks')` | CRUD + batch: `{ create, update, delete, createMany, updateMany, deleteMany, archive, unarchive }`. |
| `useMutators(mutators)` | Zero-style custom mutators. Supports undo/redo via `useUndoScope`. |
| `useUndoScope('editor')` | Per-surface undo/redo stack. |
| `usePresence()` | Your declared `Presence` shape. Wire with `<SyncProvider presence={...}>`. |
| `useIntent('editLayer')` | Typed invoker for a named intent. Wire with `<SyncProvider beginIntent={...}>`. |

```tsx
const tasks   = useQuery('tasks', { where: { status: 'todo' } });   // Task[]
const task    = useOne('tasks', taskId);                              // Task | undefined
const mutate  = useMutate('tasks');                                   // optimistic CRUD
const read    = useReader('tasks');                                   // imperative snapshots
const presence = usePresence();                                       // your Presence shape
const edit     = useIntent('editLayer');                              // (claim) => handle
```

Every return type is inferred from `AbloSync['Schema']`. See [`docs/react.md`](docs/react.md) and [`docs/typed-global.md`](docs/typed-global.md) for the full reference.

## Custom Mutators (Zero-style)

Define mutators alongside the schema — `ablo.schema.ts` is the natural home since `defineMutators` is pure.

```typescript
// ablo.schema.ts (addition)
import { defineMutators } from '@ablo/sync-engine';

export const mutators = defineMutators(schema, {
  tasks: {
    async complete({ tx, args }: { tx; args: { id: string } }) {
      await tx.tasks.update(args.id, { status: 'done', completedAt: new Date() });
    },
  },
});

// React:
const mutate = useMutators(mutators);
await mutate.tasks.complete({ id: taskId });
```

## Offline Support

The SDK works fully offline. No special code required.

1. Mutations queue to IndexedDB when the WebSocket is down.
2. The ObjectPool shows optimistic state so the UI stays responsive.
3. On reconnect, the offline queue flushes in FK-safe topological order.
4. Delta catch-up via WebSocket ensures no mutations are lost.
5. Conflicts resolve via last-write-wins (custom resolvers on the roadmap).

See [`docs/offline-and-sync-groups.md`](docs/offline-and-sync-groups.md).

## AI Agent SDK

Long-lived agents (Node) participate in the sync stream as first-class citizens. Same delta wire format as browser clients; mutations carry `createdBy: { kind: 'agent', id }` in the log.

```typescript
import { SyncAgent } from '@ablo/sync-engine/agent';

const agent = new SyncAgent({
  url: 'wss://mesh.ablo.finance',
  agentId: 'auto-prioritizer',
  organizationId: 'org_...',
  capabilityToken: process.env.ABLO_CAPABILITY_TOKEN!,
  syncGroups: ['org:default'],
});

await agent.connect();

agent.on('tasks', (task, delta) => {
  const priority = task.title.includes('urgent') ? 10 : 0;
  void agent.update('tasks', task.id, { priority });
});
```

For short-lived / per-request agents (AI SDK v6 tool calls), use `AgentPerception` — see [`docs/agent.md`](docs/agent.md).

## Agent Mesh (`new Ablo(...)` + `ablo.join(...)`)

The mesh layer turns any agent-like object into a live sync-mesh participant — capability-scoped, presence-aware, watermark-safe. Ablo owns mesh participation, capability tokens, permission ceilings, and write honesty. Tools, skills, prompts, models stay in your code.

```typescript
import Ablo from '@ablo/sync-engine';
import { schema } from './schema';

// Zero-config — reads ABLO_API_KEY from env (org is derived
// server-side from the key). Override any field by passing it.
const ablo = new Ablo({ schema });

const researcher = { id: 'researcher-q3-1', label: 'Q3 due diligence' };

// Auto-connects. `join` returns a ready-to-use participant.
const participant = await ablo.join(researcher, {
  scope: { matters: 'techco-acquisition' },
});
```

`ablo.join(agent, opts)` mints a Biscuit capability token, subscribes the agent to the scope's sync groups, and returns a wrapper holding the original agent by reference. Admin resources — `ablo.admin.roles`, `ablo.admin.members`, `ablo.admin.audit`, `ablo.admin.capabilities` — are namespaced under `admin` so customer model names never collide. See [`docs/mesh.md`](docs/mesh.md) and [`src/mesh/README.md`](src/mesh/README.md). The named factory `createMesh(opts)` stays exported for functional-style call sites.

## Authentication

- **API keys** (`sk_live_*`, `sk_test_*`) — server-to-server auth for customer backends.
- **Biscuit capability tokens** — cryptographically attenuable, short-lived scoped tokens for agents.
- **Session cookies** (Better Auth) — human users via browser.

See [`docs/auth.md`](docs/auth.md) for minting flow and caveat vocabulary.

## Hosted Service

`mesh.ablo.finance` handles the sync server, PostgreSQL, Redis, and WebSocket infrastructure. Nothing to run locally besides your app. Self-hosting is not offered today; if compliance or data residency requires on-prem deployment, it's a conversation — get in touch.

## Testing

The SDK ships test utilities under `@ablo/sync-engine/testing`. See [`docs/testing.md`](docs/testing.md) for the current helper list and patterns.

## Performance

Measured against production data (4MB dataset, 33 entity types, Neon Postgres in eu-central-1):

| Operation | Latency |
|-----------|---------|
| Mutation round-trip (batchAck) | ~340ms |
| Delta delivery (Redis → WebSocket) | < 50ms |
| Full bootstrap (4MB) | ~4.5s |
| Partial bootstrap (small gap) | ~200ms |
| Offline queue flush | Instant (IndexedDB → HTTP) |

## Documentation

- [Getting Started](docs/getting-started.md) — zero to multiplayer in 5 minutes
- [Schema Definition](docs/schema.md) — Zod models, relations, load strategies
- [Schema vs. Database](docs/schema-vs-db.md) — how `ablo.schema.ts` relates to your DB migrations
- [Monorepo setup](docs/monorepo.md) — schema as a shared workspace package (Ablo's own layout)
- [Client SDK](docs/client.md) — query, mutate, subscribe
- [React Hooks](docs/react.md) — reactive components, typed-global pattern
- [Typed Global](docs/typed-global.md) — the `AbloSync` global, deep reference
- [Offline & Sync Groups](docs/offline-and-sync-groups.md) — offline support, permission scoping
- [Agent SDK](docs/agent.md) — long-lived and short-lived AI agents
- [Mesh](docs/mesh.md) — `createMesh` + `mesh.join`
- [Authentication](docs/auth.md) — API keys, Biscuit capabilities, sessions
- [Architecture](docs/architecture.md) — delta log, ObjectPool, bootstrap
- [Testing](docs/testing.md) — unit, integration, agent tests

## License

Apache License 2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

Copyright 2025-2026 Fablo Innovation AB. "Ablo" is a trademark of Fablo
Innovation AB; the license grants rights to the software, not to the
trademark. See NOTICE for attribution guidance.

The hosted mesh service at `mesh.ablo.finance` is separate commercial
infrastructure and is not covered by this license. Self-hosted deployments
use your own `apps/sync-server` instance.
