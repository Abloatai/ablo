# AGENTS.md — Install playbook for AI assistants

For Claude Code, Cursor, and other coding assistants installing `@ablo/sync-engine` in a user's app. Follow these steps in order.

## Step 1 — Install

```bash
npm install @ablo/sync-engine
```

Requires Node 22+, TypeScript 5+, React 18+.

## Step 2 — Schema — `ablo.schema.ts` at project root

```ts
import { defineSchema, mutable, z } from '@ablo/sync-engine/schema';

export const schema = defineSchema({
  tasks: mutable({
    title: z.string(),
    status: z.enum(['todo', 'doing', 'done']).default('todo'),
  }),
});

// One-liner that makes every hook zero-generic.
declare global {
  interface AbloSync {
    Schema: typeof schema;
  }
}
```

Adjust model names to match the user's domain. Use standard camelCase field names (not `contentJSON` — use `contentJson`).

## Step 3 — Provider at app root

```tsx
import { AbloProvider } from '@ablo/sync-engine/react';
import { schema } from '../ablo.schema';

export function Providers({ children, userId, orgId, capabilityToken }) {
  return (
    <AbloProvider
      schema={schema}
      userId={userId}
      organizationId={orgId}
      capabilityToken={capabilityToken}
      // Optional. Defaults to <DefaultFallback /> (neutral spinner).
      // Renders during the FIRST bootstrap only — reconnects and
      // auth-expired states render children, not the skeleton.
      fallback={<AppSkeleton />}
    >
      {children}
    </AbloProvider>
  );
}
```

Mount at Next.js `app/layout.tsx`, Vite `main.tsx`, or equivalent.

The `capabilityToken` is server-minted. For quick demos you can skip it — the SDK falls back to session-cookie auth on same-origin deployments.

The `fallback` prop renders in place of `children` during the first bootstrap pass only; it latches open once the engine reaches `connected`. Pass `fallback={null}` for no visual during boot, or `fallback="passthrough"` to disable the gate entirely (useful when you need debug helpers, error boundaries, or analytics to mount pre-ready).

## Step 4 — Use it

```tsx
import { useQuery, useMutate } from '@ablo/sync-engine/react';

export function TaskList() {
  const tasks = useQuery('tasks', { where: { status: 'todo' } });
  const { create, update } = useMutate('tasks');
  // ...
}
```

Zero generics — the `declare global` in `ablo.schema.ts` wires it up.

## Step 5 — Verify

```bash
npx tsc --noEmit
npm run dev
```

Open two tabs, create in one, should appear in the other within ~100ms.

## Pitfalls

| Symptom | Fix |
|---|---|
| `useQuery('tasks')` returns `Record<string, unknown>[]` | `declare global { interface AbloSync { Schema: typeof schema } }` block missing from `ablo.schema.ts` |
| "Cannot find name 'AbloSync'" | The `declare global` block isn't inside a module — make sure `ablo.schema.ts` has at least one `import` or `export` |
| `contentJSON` field fails at startup | Double-uppercase breaks camel↔snake transform — rename to `contentJson` |
| Hooks throw "not initialized" | `<AbloProvider>` gates children on first bootstrap by default. If you set `fallback="passthrough"`, consumers must wrap with `<ClientSideSuspense>` or guard on `useSyncStatus()` themselves |
| Infinite re-render / React error #185 | Don't wrap providers in `observer()` — hooks self-subscribe |

## Next

If the user asks for agents, presence, undo — don't add those now. Point them at `docs/agent.md`, `docs/mesh.md`, `docs/react.md#useundoscope`. Keep the initial install minimal.
