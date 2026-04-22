# React Hooks

One umbrella provider owns the lifecycle; hooks self-subscribe via `useSyncExternalStore`. No HOCs required, no singleton gymnastics, no `beforeunload` wiring, no session-expiry cleanup to remember. v0.3.0 inspired by Zero's `ZeroProvider` and Liveblocks' `LiveblocksProvider`.

## The short version

### 1. Declare your global once — `ablo.schema.d.ts`

```ts
// ablo.schema.d.ts (at project root, next to ablo.schema.ts)
import type { schema } from './ablo.schema';

declare global {
  interface AbloSync {
    Schema: typeof schema;
    Presence: { cursor: { x: number; y: number } | null };
    Intents: { editTask: { taskId: string } };
  }
}
export {};
```

### 2. Wire `<AbloProvider>` at the app root

```tsx
import {
  AbloProvider,
  ClientSideSuspense,
  SyncGroupProvider,
} from '@ablo/sync-engine/react';
import { schema } from './ablo.schema';

function Root() {
  const { userId, orgId, capabilityToken } = useSession();
  return (
    <AbloProvider
      schema={schema}
      url={process.env.NEXT_PUBLIC_SYNC_URL!}
      userId={userId}
      organizationId={orgId}
      // Auth — pick one; see "Authentication" below
      capabilityToken={capabilityToken}
      // Declarative behavior
      preventUnsavedChanges
      postBootstrap={[prefetchDeckThumbnails, prefetchVaultData]}
      onSessionExpired={() => router.replace('/signin')}
      onError={(err) => Sentry.captureException(err)}
    >
      <SyncGroupProvider id={`org:${orgId}`}>
        <ClientSideSuspense fallback={<Skeleton />}>
          <App />
        </ClientSideSuspense>
      </SyncGroupProvider>
    </AbloProvider>
  );
}
```

The provider owns:

- Singleton lifecycle (rotates on `userId` / `organizationId` / `url` change).
- React Strict-Mode safe bootstrap (internal `AbortController`).
- `beforeunload` handler — when `preventUnsavedChanges` is set and there are unflushed writes, triggers the browser's standard leave-site prompt.
- Session-expiry handling — on `session_error` events the SDK calls `engine.purge()` (disconnect + wipe every `ablo_*` IndexedDB) before firing your `onSessionExpired` callback.
- Mesh client construction — `useAblo()` and `useParticipant(opts)` are always available downstream. Mesh is canonical in v0.3.0, not opt-in.
- Post-bootstrap hooks — run once between hydrate and first render past the skeleton.

### 3. Use the hooks

```tsx
import {
  useQuery, useOne, useMutate, useReader, usePresence, useIntent,
} from '@ablo/sync-engine/react';

function TaskList() {
  const tasks = useQuery('tasks', { where: { status: 'todo' }, orderBy: 'priority' });
  const mutate = useMutate('tasks');
  const presence = usePresence();
  const startEdit = useIntent('editTask');

  return (
    <ul>
      {tasks.map(task => (
        <li key={task.id}>
          <button
            onClick={() => {
              startEdit({ taskId: task.id });
              mutate.update({ id: task.id, status: 'done' });
            }}
          >
            {task.title} {presence?.cursor && '👀'}
          </button>
        </li>
      ))}
      <button onClick={() => mutate.create({ title: 'New task' })}>Add</button>
    </ul>
  );
}
```

Hooks self-subscribe via `useSyncExternalStore` — no `withSync()` wrapper required.

Every return type is inferred from your `AbloSync` global. `tasks` is `Task[]`, `mutate.create` expects an `InferCreate<typeof schema, 'tasks'>`, `presence` is your declared `Presence` shape, `startEdit`'s arg is typed against `Intents['editTask']`.

## Hook reference (typed-global form)

### `useQuery(modelKey, options?)`

Reactive collection. Re-renders on any change to matching entities. IVM-backed (incremental view maintenance) — scales to large pools without full recomputes.

```tsx
import { ModelScope } from '@ablo/sync-engine/react';

const tasks = useQuery('tasks', {
  where: { status: 'todo', projectId: 'proj-1' },  // AND'd field-match filter
  filter: (t) => t.priority > 3,                    // predicate after `where`
  orderBy: 'createdAt',
  order: 'desc',
  limit: 20,
  offset: 0,
  scope: ModelScope.live,                           // live | archived | all
});
```

### `useOne(modelKey, id?)`

Reactive single entity by ID. Returns `undefined` while loading or if not found.

```tsx
const task = useOne('tasks', taskId);
```

### `useMutate(modelKey)`

CRUD methods for one model type. Returns `{ create, update, delete, createMany, updateMany, deleteMany, archive, unarchive }`. All are optimistic — UI updates instantly, rollback on server rejection.

```tsx
const mutate = useMutate('tasks');

await mutate.create({ title: 'Ship it', projectId: 'proj-1' });
await mutate.update({ id: task.id, status: 'done' });
await mutate.delete(task.id);
await mutate.createMany([{ title: 'A' }, { title: 'B' }]);
await mutate.archive(task.id);
```

### `useReader(modelKey)`

Imperative snapshot reads. Does NOT subscribe the component. Use inside event handlers or callbacks where you need a current view without re-renders.

```tsx
const read = useReader('tasks');

const handleClick = () => {
  const snapshot = read.findMany({ where: { projectId: id } });
  const first = read.findFirst({ where: { status: 'todo' } });
  const count = read.count({ where: { status: 'todo' } });
  const byId = read.findById(taskId);
};
```

### `useMutators(mutators, options?)`

Zero-style custom mutators. Define them once with `defineMutators`; invoke via the hook. Supports undo/redo via `useUndoScope`.

```ts
// Define once
import { defineMutators } from '@ablo/sync-engine';

export const mutators = defineMutators(schema, {
  tasks: {
    async complete({ tx, args }) {
      await tx.tasks.update(args.id, { status: 'done', completedAt: new Date() });
    },
  },
});
```

```tsx
const mutate = useMutators(mutators);
await mutate.tasks.complete({ id: taskId });
```

### `useUndoScope(name, options?)`

Per-surface undo/redo stack. Pass `scope` to `useMutators` to record every invocation as an undo entry.

```tsx
const { scope, undo, redo, canUndo, canRedo } = useUndoScope('deck-editor');
const mutate = useMutators(mutators, { undoScope: scope });

useHotkey('mod+z', () => canUndo && undo());
useHotkey('mod+shift+z', () => canRedo && redo());
```

### `useSyncStatus()`

Reactive snapshot of the sync lifecycle as a discriminated union. Impossible states (e.g., "connected AND offline") are unrepresentable — each variant carries only the fields that make sense in that state.

```tsx
function StatusPill() {
  const status = useSyncStatus();
  switch (status.name) {
    case 'initial':
    case 'connecting':     return <Pill>Loading…</Pill>;
    case 'connected':      return status.hasUnsyncedChanges ? <Pill>Saving…</Pill> : null;
    case 'reconnecting':   return <Pill title={status.reason}>Reconnecting…</Pill>;
    case 'disconnected':   return <Pill title={status.reason}>Offline</Pill>;
    case 'needs-auth':     return null;  // onSessionExpired already fired
  }
}
```

Snapshot shape:

```ts
type SyncStatusSnapshot =
  | { readonly name: 'initial' }
  | { readonly name: 'connecting'; readonly progress: number }
  | { readonly name: 'connected'; readonly hasUnsyncedChanges: boolean }
  | { readonly name: 'reconnecting'; readonly reason?: string }
  | { readonly name: 'disconnected'; readonly reason?: string }
  | { readonly name: 'needs-auth' };
```

The hook bridges MobX into React via `useSyncExternalStore` with a cached snapshot, so it's immune to the `getSnapshot should be cached` infinite-loop class of bugs (React error #185). Inspired by Liveblocks' `useStatus()` and Zero's `useConnectionState()`.

### `useCurrentUserId()`

Returns the `userId` passed to `<AbloProvider>`. Stable until the provider remounts on auth change. Prefer this over reading `store.currentUserId` — a plain string with no MobX tracking overhead.

```tsx
const userId = useCurrentUserId();
```

### `useErrorListener(callback)`

Imperative error callback. Fires on engine errors, WebSocket errors, and uncaught `postBootstrap` exceptions. Use for Sentry / Datadog integrations — it won't trigger re-renders.

```tsx
function ErrorToaster() {
  useErrorListener((err) => {
    toast.error(err.message);
    Sentry.captureException(err);
  });
  return null;
}
```

### `useAblo()` / `useParticipant(opts)`

The mesh surface. Always available inside `<AbloProvider>`. `useAblo()` returns the raw `AbloClient`; `useParticipant({ scope, label })` joins the mesh for a given scope and returns the participant + lifecycle status.

```tsx
const { participant, status, error } = useParticipant({
  scope: { matters: matterId },
  label: currentUser.name,
  ttlSeconds: '10m',
  paused: !matterId,
});
```

See `docs/mesh.md` for the full coordination primitives (`participant.presence.editing(...)`, `participant.intents.writing(...)`, `participant.snapshot(...)`, etc.).

### `usePresence()`

Returns the consumer-supplied presence state with `ResolvePresence` typing. The SDK doesn't own a wire format — wire whatever backs your cursors/status into your app.

```tsx
const presence = usePresence();
// presence: { cursor: { x: number; y: number } | null } | undefined
```

### `useIntent(intentName)`

Typed invoker for a named intent, narrowed by your `AbloSync['Intents']` global augmentation.

```tsx
const startEdit = useIntent('editTask');
startEdit({ taskId: task.id });  // `{ taskId: string }` — enforced at compile time
```

## Authentication

Pick one of three auth paths on `<AbloProvider>`:

```tsx
// 1. Browser app with server-minted capability (Stripe-shape).
//    Your server calls `ablo.admin.capabilities.create(...)` and
//    ships the token to the client. No API key in the bundle.
<AbloProvider capabilityToken={tokenFromServer} {...rest}>

// 2. Server-side agent / webhook / CLI tool.
//    Loaded from ABLO_API_KEY env if the prop is unset.
<AbloProvider apiKey="sk_live_..." {...rest}>

// 3. Cookie-backed app (Better Auth, NextAuth, same-origin session).
//    SDK falls back to `credentials: 'include'`. Don't set either prop.
<AbloProvider {...rest}>
```

## Imperative access

Skip the typed hooks entirely and read directly from the `SyncEngine` proxy via `useSync()`. Wrap components in `observer` from `mobx-react-lite` if you want MobX reactivity around these imperative reads.

```tsx
import { useSync } from '@ablo/sync-engine/react';
import { observer } from 'mobx-react-lite';

const TaskList = observer(() => {
  const sync = useSync<(typeof schema)['models']>();
  const todos = sync.tasks.findMany({
    where: { status: 'todo' },
    orderBy: { priority: 'desc' },
  });

  return (
    <ul>
      {todos.map(task => (
        <li key={task.id} onClick={() => sync.tasks.update(task.id, { status: 'done' })}>
          {task.title}
        </li>
      ))}
    </ul>
  );
});
```

Single-entity reads use `sync.<model>.findById(id)`. Mutations call `sync.<model>.create/update/delete` directly — optimistic, queued when offline.

For side effects outside of React rendering (notifications, sounds), use `sync.<model>.subscribe()`:

```tsx
useEffect(() => {
  const unsub = sync.tasks.subscribe(
    (tasks) => { if (tasks.length > prevCount) playNotificationSound(); },
    { where: { status: 'todo' } },
  );
  return unsub;
}, []);
```

### Connection status

Use the `useSyncStatus()` tagged union instead of reading `sync.syncStatus` directly — see the hook reference above.

## Pitfalls — things we learned the hard way

These are bugs that took multiple engineers + one production loading-skeleton outage to untangle. The SDK guards against them now; the patterns still matter if you're extending the bindings or writing your own hooks.

### Don't wrap providers in `observer()`

```tsx
// WRONG — the provider re-renders on every MobX tick it touches
//    (pool size, isReady, currentUserId, ...). Context value churns,
//    every consumer re-subscribes, re-renders, re-subscribes.
//    React error #185: "Maximum update depth exceeded".
export const MyDataProvider = observer(({ children }) => {
  const syncStore = useSyncStore();
  const isReady = syncStore.isReady;       // ← subscribes provider
  const userId = syncStore.currentUserId;  // ← subscribes provider
  // ...
  return <Ctx.Provider value={...}>{children}</Ctx.Provider>;
});

// RIGHT — providers hand out stable context values. Pull
//    reactive state via `useSyncStatus()` or bridge MobX into
//    React state via `reaction` inside useEffect.
export function MyDataProvider({ children }) {
  const { isReady } = useSyncStatus();
  const userId = useMyUserId();  // your own hook, React-state-backed
  return <Ctx.Provider value={{ isReady, userId }}>{children}</Ctx.Provider>;
}
```

The rule: **`observer` belongs on leaf consumers that read data**. Providers hand out a stable context; they don't react to it.

### Don't return a new reference from `getSnapshot`

When you build your own hooks on top of the SDK, obey `useSyncExternalStore`'s cache-or-die contract:

```ts
// WRONG — fresh array on every call. React's post-commit
//    consistency check sees the new identity, schedules a
//    re-render, calls getSnapshot again, gets another new array,
//    schedules another re-render. Error #185.
useSyncExternalStore(
  subscribe,
  () => view.results.slice(),
  () => EMPTY,
);

// RIGHT — cache in a ref, mutate inside the subscribe callback.
const snap = useRef(view.results.slice());
useSyncExternalStore(
  (onChange) => reaction(
    () => view.results.length,
    () => { snap.current = view.results.slice(); onChange(); },
  ),
  () => snap.current,
  () => EMPTY,
);
```

The built-in `useQuery`, `useOne`, and `useSyncStatus` already do this correctly.

### Sync-status getters are observable — read them directly

`isReady`, `isSyncing`, `isOffline`, `isReconnecting`, `isError`, `hasUnsyncedChanges` are `computed` MobX values on the store. You have three good options:

1. `useSyncStatus()` — zero MobX knowledge required, idiomatic React.
2. `observer(Component)` that reads `store.isReady` directly — plain MobX.
3. `reaction(() => store.isReady, ...)` inside `useEffect` — manual bridge.

**Don't watch `pool.size` as a proxy for "is the store loaded?"** Older SDK versions accidentally rewarded that pattern because their status fields weren't observable. They are now.

## Real-time multiplayer

Open the app in two tabs. Create a task in one — it appears in the other instantly. Complete a task — it disappears from both todo lists. No extra code. `withSync` handles the reactivity; the sync engine handles the wire.
