# Ablo Sync Engine

Real-time multiplayer data sync for TypeScript. Offline-first, type-safe, with AI agents as first-class participants.

```typescript
// ablo.schema.ts — at your project root
import { defineSchema, mutable, z } from '@ablo/sync-engine/schema';

export const schema = defineSchema({
  tasks: mutable({
    title: z.string(),
    status: z.enum(['todo', 'doing', 'done']).default('todo'),
  }),
});
```

```typescript
// src/ablo.ts — runtime module
import { createSyncEngine } from '@ablo/sync-engine/client';
import { schema } from '../ablo.schema';

export const sync = createSyncEngine({
  url: 'wss://mesh.ablo.finance',
  apiKey: 'sk_live_...',
  schema,
});

await sync.tasks.create({ title: 'Ship it' });
```

One schema file at project root, one runtime module. No server setup required.

## What you get

- **Real-time sync** across all connected clients via WebSocket
- **Offline-first** with IndexedDB persistence and automatic reconnection
- **Type-safe** schema with full TypeScript inference, zero codegen
- **Sync groups** for multi-party permission scoping (buyer sees X, seller sees Y)
- **AI agent SDK** for agents that subscribe to changes and emit mutations
- **Managed cloud** at `mesh.ablo.finance` — hosted service, no infrastructure to run

## Installation

```bash
npx create-ablo-app my-app
```

Or add to an existing project:

```bash
npm install @ablo/sync-engine
```

## Guides

- [Getting Started](./getting-started.md) &mdash; Zero to multiplayer in 5 minutes
- [Schema Definition](./schema.md) &mdash; Define your data models
- [Schema vs. Database](./schema-vs-db.md) &mdash; How the client schema relates to your DB migrations
- [Monorepo setup](./monorepo.md) &mdash; Schema as a shared workspace package
- [Client SDK](./client.md) &mdash; Query, mutate, and subscribe
- [React Hooks](./react.md) &mdash; Reactive hooks, typed-global pattern
- [Offline & Sync Groups](./offline-and-sync-groups.md) &mdash; Offline support, permission scoping
- [Agent SDK](./agent.md) &mdash; AI agents as sync participants
- [Mesh](./mesh.md) &mdash; `createMesh` + `mesh.join` for agent-multiplayer
- [Testing](./testing.md) &mdash; Unit tests, E2E tests, agent tests

## Advanced

- [Authentication](./auth.md) &mdash; API keys, session cookies, capability tokens
- [Architecture](./architecture.md) &mdash; How it works under the hood
