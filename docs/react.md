# React Hooks

One provider, self-subscribing hooks. No HOCs.

## Setup

```tsx
import { AbloProvider, SyncGroupProvider } from '@ablo/sync-engine/react';
import { schema } from './ablo.schema';

<AbloProvider
  schema={schema}
  userId={userId}
  organizationId={orgId}
  capabilityToken={capabilityToken}
  fallback={<Skeleton />}
>
  <SyncGroupProvider id={`org:${orgId}`}>
    <App />
  </SyncGroupProvider>
</AbloProvider>
```

`fallback` is rendered during the **first** bootstrap pass only. Once the engine reaches `connected`, the gate latches open for the provider's lifetime — reconnects, auth failures, and subsequent transient `connecting` states render `children` normally. Pass `fallback="passthrough"` to opt out of the gate entirely (children render immediately; you're responsible for your own loading UI). `<ClientSideSuspense>` is still exported for **nested** gating inside an already-ready provider — use it when you want app chrome to render immediately but a heavy subtree (e.g. a canvas) to wait for its own query.

### `<AbloProvider>` props

| Prop | Required | What it does |
|---|---|---|
| `schema` | ✓ | Your `defineSchema()` result |
| `userId` | ✓ | Rotates the engine when this changes |
| `organizationId` | ✓ | Scopes deltas + capability tokens |
| `capabilityToken` | auth | Browser flow — server-minted scoped token |
| `apiKey` | auth | Server-side bindings (`sk_live_...`) |
| `teamIds` | | Additional sync groups `team:{id}` |
| `fallback` | | Rendered during first bootstrap only (see above). Default `null`; `"passthrough"` disables the gate |
| `preventUnsavedChanges` | | Triggers `beforeunload` prompt when `hasUnsyncedChanges` |
| `postBootstrap` | | Array of hooks that run between hydrate and first ready |
| `onSessionExpired` | | Fired after the SDK purges IndexedDB on session loss |
| `onError` | | Engine + WebSocket errors (Sentry/Datadog target) |
| `resolveUsers` | | User-info lookup, called on demand by peer-display UI |
| `lostConnectionTimeout` | | Grace period (ms) before status flips to `disconnected` |

Omit both `capabilityToken` and `apiKey` to fall back to session-cookie auth (`credentials: 'include'`).

## Hooks

| Hook | Returns | Re-renders? |
|---|---|---|
| `useQuery(key, opts?)` | `Entity[]` | ✓ on pool changes |
| `useOne(key, id)` | `Entity \| undefined` | ✓ on entity changes |
| `useMutate(key)` | `{ create, update, delete, createMany, ..., archive, unarchive }` | ✗ |
| `useReader(key)` | `{ findById, findMany, findFirst, count }` | ✗ — imperative snapshot |
| `useMutators(defs, opts?)` | `MutatorInvokers<defs>` | ✗ |
| `useUndoScope(name)` | `{ scope, undo, redo, canUndo, canRedo }` | ✓ on stack changes |
| `useSyncStatus()` | Tagged union (see below) | ✓ on transitions |
| `useCurrentUserId()` | `string` | ✗ — stable until provider remounts |
| `useErrorListener(cb)` | `void` | ✗ |
| `useAblo()` | `AbloClient` | ✗ |
| `useParticipant(opts)` | `{ participant, peers, claims, status, error }` | ✓ on presence/intent changes |
| `usePresence()` | Your `AbloSync['Presence']` shape | ✓ |
| `useIntent(name)` | `(claim) => IntentHandle` | ✗ |
| `useReactive(fn)` | `T` | ✓ — escape hatch for bespoke MobX reads |

All hook types are inferred from the `AbloSync` typed-global. See [typed-global.md](./typed-global.md).

### `useQuery(key, opts?)`

```tsx
const tasks = useQuery('tasks', {
  where: { status: 'todo', projectId: 'proj-1' },
  filter: (t) => t.priority > 3,
  orderBy: 'createdAt',
  order: 'desc',
  limit: 20,
  scope: ModelScope.live, // live | archived | all
});
```

### `useMutate(key)`

```tsx
const { create, update, delete: del, archive } = useMutate('tasks');
await create({ title: 'Ship it', projectId: 'proj-1' });
await update({ id, status: 'done' });
await del(id);
await archive(id);
```

All methods are optimistic. Server rejection rolls back automatically.

### `useMutators(defs, opts?)`

```ts
// Define once
export const mutators = defineMutators(schema, {
  tasks: {
    async complete({ tx, args }) {
      await tx.tasks.update(args.id, { status: 'done', completedAt: new Date() });
    },
  },
});

// Use
const { tasks } = useMutators(mutators);
await tasks.complete({ id });
```

### `useUndoScope(name)`

```tsx
const { scope, undo, redo, canUndo } = useUndoScope('deck-editor');
const mutate = useMutators(mutators, { undoScope: scope });

useHotkey('mod+z', () => canUndo && undo());
```

### `useSyncStatus()`

```ts
type SyncStatusSnapshot =
  | { name: 'initial' }
  | { name: 'connecting'; progress: number }
  | { name: 'connected'; hasUnsyncedChanges: boolean }
  | { name: 'reconnecting'; reason?: string }
  | { name: 'disconnected'; reason?: string }
  | { name: 'needs-auth' };
```

```tsx
const status = useSyncStatus();
switch (status.name) {
  case 'connecting':    return <Pill>Loading…</Pill>;
  case 'connected':     return status.hasUnsyncedChanges ? <Pill>Saving…</Pill> : null;
  case 'reconnecting':  return <Pill title={status.reason}>Reconnecting…</Pill>;
  case 'disconnected':  return <Pill>Offline</Pill>;
}
```

### `useParticipant(opts)`

```tsx
const { participant, peers, claims, status } = useParticipant({
  scope: { matters: matterId },
  label: currentUser.name,
  ttlSeconds: '10m',
  paused: !matterId,
});
```

Full mesh primitives (`presence.editing`, `intents.writing`, `snapshot`) live on `participant`. See [mesh.md](./mesh.md).

### `useReactive(fn)`

Escape hatch for observing MobX values the SDK doesn't expose a dedicated hook for. Handles the cached-snapshot contract of `useSyncExternalStore` internally.

```tsx
const theme = useReactive(() => settingsStore.theme);
```

## Pitfalls

| Don't | Why |
|---|---|
| Wrap `<AbloProvider>` or any provider in `observer()` | Provider re-renders on every MobX tick → cascade → React error #185 |
| Return a new reference from `getSnapshot` in custom hooks | React post-commit consistency check schedules infinite re-renders |
| Watch `pool.size` as a proxy for "is loaded" | Use `useSyncStatus()` instead — `isReady` is a real computed observable |
| Reach for `useSyncExternalStore` directly | Use `useReactive(fn)` — hides the three-arg contract + handles structural equality |

`observer` from `mobx-react-lite` still works on leaf components. The data hooks don't need it.

## See also

- [Typed Global](./typed-global.md) — the `AbloSync` declaration pattern
- [Schema](./schema.md) — models, relations, `mutable` vs `readOnly`
- [Mesh](./mesh.md) — `useParticipant` coordination primitives
- [Authentication](./auth.md) — minting capability tokens server-side
