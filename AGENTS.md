# AGENTS.md — `@ablo/sync-engine` install playbook

**For LLM assistants (Claude Code, Cursor, etc.) integrating this SDK
into a consumer's application.** Follow these steps in order. Each step
names the concrete files to create + the verification command.

This playbook produces the canonical setup: **one schema file at project
root (`ablo.schema.ts`)**, **one ambient declaration (`ablo.schema.d.ts`)**,
**one runtime module** (the consumer's `src/ablo.ts` or similar). After
that, every hook types itself from the `AbloSync` global with zero
generics at the call site.

---

## Step 1 — Install

```bash
npm install @ablo/sync-engine mobx mobx-react-lite react zod
```

Requires:
- Node 22.0.0+ (Web Crypto globals)
- TypeScript 5.0+
- React 19+ (hooks use `useEffectEvent`)

## Step 2 — Define the schema — `ablo.schema.ts`

Create `ablo.schema.ts` **at the project root** (not under `src/`). This is the canonical location — same relative position as `tsconfig.json`, `next.config.js`, `package.json`. Keep it pure: `defineSchema`, `defineMutators`, `defineQueries` only. No runtime instantiation, no `new Ablo()` here.

```ts
// ablo.schema.ts
import { defineSchema, mutable, readOnly, relation, z } from '@ablo/sync-engine/schema';

export const schema = defineSchema(
  {
    projects: mutable(
      { name: z.string() },
      {
        syncGroupFormat: 'project:{id}',
        relations: { tasks: relation.hasMany('tasks', 'projectId') },
        typename: 'Project',
        tableName: 'projects',
      },
    ),
    tasks: mutable(
      {
        title: z.string(),
        status: z.enum(['todo', 'doing', 'done']).default('todo'),
        priority: z.number().default(0),
        projectId: z.string().optional(),
      },
      {
        parent: 'projects',
        relations: { project: relation.belongsTo('projects', 'projectId') },
        typename: 'Task',
        tableName: 'tasks',
      },
    ),
  },
  {
    // camelCase JS field names + snake_case DB columns (Postgres convention).
    // Omit `casing` when your DB columns match your JS fields literally.
    casing: 'snake_case',
  },
);
```

**Field-name constraint**: fields must be standard camelCase (single uppercase letter per word). `themeCSS` fails at build time — use `themeCss`. Enforced by `assertRoundTrippableCamelCase` inside `defineSchema` to prevent silent snake↔camel round-trip bugs.

**Not a database migration.** This file is the client-side type + sync-group contract. Keep your Prisma / Drizzle / raw-SQL migrations as-is.

## Step 3 — Declare the typed global — `ablo.schema.d.ts`

Create `ablo.schema.d.ts` next to `ablo.schema.ts` at project root:

```ts
// ablo.schema.d.ts
import type { schema } from './ablo.schema';

declare global {
  interface AbloSync {
    Schema: typeof schema;

    // Your presence shape — whatever you want to broadcast per session.
    Presence: {
      cursor: { x: number; y: number } | null;
      status: 'online' | 'away';
    };

    // Your intent vocabulary — named claims for stale-read coordination.
    Intents: {
      editTask: { taskId: string };
    };

    // Your user-metadata shape — trusted from auth.
    UserMeta: {
      id: string;
      email: string;
    };
  }
}
export {};
```

**This file is what makes every hook typed without generics.** One
declaration, every `useQuery`/`useOne`/`useMutate`/`usePresence`/
`useIntent` call site inherits the types.

If your `tsconfig.json` doesn't pick this up automatically, add it to
`include`:

```json
{
  "include": ["src/**/*", "ablo.schema.ts", "ablo.schema.d.ts"]
}
```

## Step 4 — Wire the runtime — `src/ablo.ts`

This is the one module with side effects (opens a WebSocket, mints tokens). Keep it separate from `ablo.schema.ts` so the schema stays importable from server components, Node agents, and tests without accidentally opening a connection.

```ts
// src/ablo.ts
import { createSyncEngine } from '@ablo/sync-engine/client';
import { schema } from '../ablo.schema';

export const engine = createSyncEngine({
  url: 'wss://mesh.ablo.finance',              // hosted; override only for staging/local-dev
  schema,
  user: { id: userId, organizationId: orgId },
  bootstrapBaseUrl: 'https://mesh.ablo.finance/api',
});

await engine.ready(); // wait for bootstrap before rendering hook consumers
```

## Step 5 — Mount the provider once

```tsx
// src/app/root-layout.tsx (or wherever your React tree roots)
import { SyncProvider } from '@ablo/sync-engine/react';
import { engine } from './ablo';

export function Root({ children, orgId }: { children: React.ReactNode; orgId: string }) {
  return (
    <SyncProvider
      store={engine._store}
      organizationId={orgId}
      // Optional: wire a presence source + intent initiator for
      // `usePresence` / `useIntent`. Omit until you need them.
      // presence={myPresenceStore}
      // beginIntent={(name, claim) => agent.beginIntent({...claim})}
    >
      {children}
    </SyncProvider>
  );
}
```

No `schema={schema}` prop — the `AbloSync` global carries the types; the `engine` carries the runtime.

## Step 6 — Use the hooks (zero-arg form)

```tsx
// Any component
import { useQuery, useOne, useMutate } from '@ablo/sync-engine/react';

export function TaskList() {
  // All three are fully typed against AbloSync['Schema']. No imports
  // of `schema`, no `<Task>` generics, no runtime args.
  const tasks = useQuery('tasks', {
    where: { status: 'todo' },
    orderBy: 'priority',
    order: 'desc',
  });
  const mutate = useMutate('tasks');

  return (
    <ul>
      {tasks.map((t) => (
        <li key={t.id}>
          <button onClick={() => mutate.update({ id: t.id, status: 'done' })}>
            {t.title}
          </button>
        </li>
      ))}
      <button onClick={() => mutate.create({ title: 'New task' })}>Add</button>
    </ul>
  );
}
```

Hooks self-subscribe via `useSyncExternalStore` — no `withSync()` wrapper required.

## Step 7 — Verify

```bash
npx tsc --noEmit
```

Should compile clean. Then run your dev server and confirm the hook
renders data. If `useQuery('tasks')` returns `Record<string, unknown>[]`
instead of `Task[]`, the typed global isn't being picked up — check:

1. `ablo.schema.d.ts` at project root exists and contains `declare global`
2. Both `ablo.schema.ts` and `ablo.schema.d.ts` are in your `tsconfig.json` `include` glob
3. You're importing the schema type with `import type { schema } from ...`
   not `import { schema } from ...` inside the `.d.ts`

## Common pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| Hooks return `Record<string, unknown>[]` | `.d.ts` not picked up by tsconfig | Add to `include`; restart TS server |
| "Cannot find name 'AbloSync'" | Missing `declare global` wrapper | Wrap your augmentation in `declare global { interface AbloSync { ... } }` |
| Hook throws "no schema available" | `SyncProvider` missing `schema` prop | Pass `schema={yourSchema}` to `SyncProvider` |
| `contentJSON` field fails at startup | Double-uppercase breaks snake↔camel transform | Rename to `contentJson` |
| `related: ['parts']` returns empty | FK casing mismatch | Ensure `casing: 'snake_case'` on `defineSchema` when DB uses snake_case columns |
| `postQuery` results empty but expected rows | Server-side compile error on query | Check sync-server logs for `[query.error]` prefix |

## Escape hatch — legacy explicit API

If you don't want the typed global, every hook still accepts the
legacy explicit-schema form:

```tsx
import { useQuery } from '@ablo/sync-engine/react';
import { schema } from '../ablo.schema';

const tasks = useQuery(schema, 'tasks', { where: { status: 'todo' } });
```

Both overloads coexist — zero-break migration path. Use whichever you
prefer; mix freely within the same app.

## Custom mutators

For business logic that needs multi-model atomicity, use
`defineMutators` + `useMutators`. See `docs/react.md#mutators`.

## Agent-side SDK (Node.js backends)

For agents that subscribe to shared state and make mutations as a
non-human participant, use `@ablo/sync-engine/agent`:

```ts
import { SyncAgent } from '@ablo/sync-engine/agent';

const agent = new SyncAgent({
  url: 'wss://mesh.ablo.finance',
  capabilityToken: process.env.ABLO_CAPABILITY_TOKEN,
  agentId: 'my-agent',
});

await agent.connect();
```

See `docs/agent.md` and `docs/auth.md` for capability-token minting.

## References

- [README.md](README.md) — full overview
- [docs/typed-global.md](docs/typed-global.md) — the pattern in depth
- [docs/getting-started.md](docs/getting-started.md) — longer walkthrough
- [docs/react.md](docs/react.md) — every React hook documented
- [docs/schema.md](docs/schema.md) — schema DSL reference
- [docs/agent.md](docs/agent.md) — Node-side agent SDK
- [docs/auth.md](docs/auth.md) — capability tokens + API keys
