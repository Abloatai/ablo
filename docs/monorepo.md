# Monorepo setup

A single-app customer puts `ablo.schema.ts` at their project root (see [Getting Started](./getting-started.md)). In a monorepo where multiple apps — a Next.js web app, a Node agent-worker, a test harness — all need the same schema, put the schema in its own workspace package instead. Same SDK, same hooks, different file layout.

This is the shape **Ablo itself uses** (`packages/ablo-schema/`), so it's what the internal codebase validates against.

## The layout

```
my-monorepo/
├── packages/
│   └── my-schema/
│       ├── package.json
│       └── src/
│           ├── index.ts            # re-exports schema
│           └── schema.ts           # defineSchema({...})
│
├── apps/
│   ├── web/
│   │   ├── src/
│   │   │   ├── ablo-sync.d.ts      # AbloSync global, imports @my-org/schema
│   │   │   └── ablo.ts             # runtime module, createSyncEngine + new Ablo
│   │   └── package.json            # depends on @my-org/schema, @ablo/sync-engine
│   │
│   └── agent-worker/
│       ├── src/
│       │   ├── ablo-sync.d.ts      # same global declaration, same import
│       │   └── index.ts            # SyncAgent setup
│       └── package.json            # also depends on @my-org/schema
```

## Schema package — `packages/my-schema/`

```json
// packages/my-schema/package.json
{
  "name": "@my-org/schema",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": { "default": "./src/index.ts" } },
  "dependencies": {
    "@ablo/sync-engine": "file:../sync-engine",
    "zod": "^3.24.0"
  }
}
```

```typescript
// packages/my-schema/src/schema.ts
import { defineSchema, mutable, readOnly, z } from '@ablo/sync-engine/schema';

export const schema = defineSchema({
  projects: mutable({ name: z.string() }, { syncGroupFormat: 'project:{id}' }),
  tasks:    mutable({ title: z.string() }, { parent: 'projects' }),
});
```

```typescript
// packages/my-schema/src/index.ts
export { schema } from './schema';
export type * from './types';
```

**Keep the package pure.** No `new Ablo()`, no `createSyncEngine()` here — those live in each app's runtime module. The schema package is type + validation only, safe to import anywhere.

## App-side — `apps/web/`

```typescript
// apps/web/src/ablo-sync.d.ts
import type { schema } from '@my-org/schema';

declare global {
  interface AbloSync {
    Schema: typeof schema;
    Presence: { cursor: { x: number; y: number } | null };
    Intents: { editTask: { taskId: string } };
  }
}
export {};
```

```typescript
// apps/web/src/ablo.ts — runtime module
import Ablo from '@ablo/sync-engine';
import { createSyncEngine } from '@ablo/sync-engine/client';
import { schema } from '@my-org/schema';

export const sync = createSyncEngine({
  url: 'wss://mesh.ablo.finance',
  apiKey: process.env.ABLO_API_KEY!,
  schema,
  user: { id: userId, organizationId: orgId },
});

export const ablo = new Ablo({ schema });
```

Every app in the monorepo repeats these two files, importing the same schema from `@my-org/schema`. One schema, many consumers.

## Why the workspace-package shape

1. **One source of truth across apps.** Web, agent-worker, and tests all see the same models. No schema drift between a browser client and a Node agent working on the same org's data.
2. **Independent app runtimes.** Each app builds its own `createSyncEngine` / `new Ablo` graph with its own auth posture (web uses session cookies, agent-worker uses an API key). The schema is identical; the runtime shape varies.
3. **Type-check once per schema change.** A breaking field rename in `packages/my-schema/` fails `tsc` in every dependent app at once — same as any other shared internal package.
4. **Dogfooded.** Ablo's own monorepo uses exactly this shape: `packages/ablo-schema/` is the schema package, `apps/web`, `apps/agent-worker`, and `apps/sync-server` all depend on it.

## When to pick which shape

| Shape | Pick when |
|---|---|
| `ablo.schema.ts` at project root | You have one app (Next.js, Remix, SvelteKit, Vite). The schema is app-local. No other services consume it. |
| `packages/my-schema/` workspace package | You have ≥2 apps / agents / test suites that need the same schema, OR you anticipate splitting one now. |

No runtime difference. The SDK ignores file layout — it only cares about the `schema` value you pass into `createSyncEngine({ schema })` and the `AbloSync['Schema']` global augmentation.
