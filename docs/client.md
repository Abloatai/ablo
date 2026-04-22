# Client SDK

Connect to a sync server and start querying data in one function call.

```typescript
import { createSyncEngine } from '@ablo/sync-engine/client';
import { schema } from './schema';

const sync = createSyncEngine({
  url: 'wss://api.example.com',
  schema,
});
```

All internal wiring (WebSocket, IndexedDB, ObjectPool, mutation queue) is handled automatically.

## Authentication

### Managed Cloud (API Key)

The simplest setup. Get an API key from the dashboard and pass it directly.

```typescript
const sync = createSyncEngine({
  url: 'wss://sync.ablo.dev',
  apiKey: 'sk_live_a1b2c3d4e5f6...',
  schema,
});
```

The API key handles authentication, organization scoping, and usage tracking. No session cookies, no JWT, no auth provider needed.

### Session cookie (browser)

Browser integrations skip `apiKey` entirely and authenticate via the session cookie the Ablo web app already sets. No extra wiring needed — `credentials: 'include'` is the default for same-origin calls.

```typescript
const sync = createSyncEngine({
  url: 'wss://mesh.ablo.finance',
  schema,
  // no apiKey — session cookie carries identity
});
```

## Configuration

```typescript
const sync = createSyncEngine({
  url: 'wss://api.example.com',     // required
  schema,                            // required
  apiKey: 'sk_live_...',            // server-side auth (omit in browser — uses session cookie)
  organizationId: 'org_123',        // optional — derived from apiKey/session otherwise
  logger: customLogger,             // default: console
  maxPoolSize: 10000,               // in-memory entity limit
  offline: true,                    // IndexedDB persistence (default: true)
});
```

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `url` | `string` | Yes | | WebSocket/HTTP URL of the sync server |
| `schema` | `Schema` | Yes | | Schema from `defineSchema()` |
| `apiKey` | `string` | No | | Server-side API key (`sk_live_...`). Browsers omit — session cookie carries identity. |
| `organizationId` | `string` | No | `''` | Optional org pin. Derived from `apiKey` or session otherwise. |
| `logger` | `SyncLogger` | No | console | Custom logger |
| `maxPoolSize` | `number` | No | `10000` | Max entities in memory |
| `offline` | `boolean` | No | `true` | Enable IndexedDB offline persistence |

## Querying

Every model in your schema becomes a property on the sync engine with query methods.

### `findMany()`

Find multiple entities with optional filtering, sorting, and pagination.

```typescript
// All tasks
const tasks = sync.tasks.findMany();

// With filter
const todoTasks = sync.tasks.findMany({
  where: { status: 'todo' },
});

// With sorting
const prioritized = sync.tasks.findMany({
  where: { status: 'todo' },
  orderBy: { priority: 'desc' },
});

// With pagination
const page = sync.tasks.findMany({
  where: { status: 'todo' },
  limit: 20,
  offset: 40,
});
```

| Option | Type | Description |
|--------|------|-------------|
| `where` | `Partial<Model>` | Filter by field values (exact match) |
| `orderBy` | `{ [field]: 'asc' \| 'desc' }` | Sort by a field |
| `limit` | `number` | Max results to return |
| `offset` | `number` | Skip this many results |

### `findById()`

Find a single entity by its ID.

```typescript
const task = sync.tasks.findById('task_123');
// Task | undefined
```

### `findFirst()`

Find the first entity matching a filter.

```typescript
const urgent = sync.tasks.findFirst({
  where: { priority: 'high', status: 'todo' },
});
```

### `count()`

Count entities matching a filter.

```typescript
const todoCount = sync.tasks.count({ where: { status: 'todo' } });
```

## Mutations

All mutations are optimistic. The UI updates immediately, and the change syncs to the server in the background. If the server rejects the change, it rolls back automatically.

### `create()`

Create a new entity. The `id` is auto-generated if not provided.

```typescript
const task = await sync.tasks.create({
  title: 'Review PR #42',
  status: 'todo',
  projectId: 'proj_123',
});

console.log(task.id); // auto-generated UUID
```

Required fields (those without defaults) must be provided. Fields with defaults are optional.

### `update()`

Update an existing entity by ID. Only pass the fields you want to change.

```typescript
const updated = await sync.tasks.update('task_123', {
  status: 'done',
});
```

### `delete()`

Delete an entity by ID.

```typescript
await sync.tasks.delete('task_123');
```

## Subscriptions

Subscribe to real-time changes. The callback fires whenever matching data changes, from any source (local mutations, other users, AI agents).

```typescript
const unsubscribe = sync.tasks.subscribe((tasks) => {
  console.log('Todo tasks:', tasks.length);
}, {
  where: { status: 'todo' },
});

// Later: stop listening
unsubscribe();
```

The subscription is reactive. When a task's status changes from `'todo'` to `'done'`, the callback fires with the updated list (without the completed task).

## Offline Support

Offline mode is enabled by default. The sync engine persists data to IndexedDB so your app works without a network connection.

```typescript
// Default: offline enabled
const sync = createSyncEngine({ url, schema });

// Opt out: online-only (no IndexedDB, lighter footprint)
const sync = createSyncEngine({ url, schema, offline: false });
```

When offline is enabled:
- **Reads** work from the local IndexedDB cache, even with no connection
- **Mutations** queue locally and flush when the connection restores
- **Reconnection** fetches only deltas since `lastSyncId` (not a full bootstrap)
- **Tab close** preserves data — reopening the app loads instantly from cache

When offline is disabled:
- Data lives only in memory (ObjectPool)
- Tab close loses all state — next load requires a full bootstrap
- Useful for ephemeral UIs, dashboards, or server-side rendering

## Connection Status

```typescript
sync.status // 'connecting' | 'connected' | 'disconnected' | 'error'
```

## Cleanup

Disconnect and release resources when done.

```typescript
await sync.dispose();
```

## How It Works

Under the hood, `createSyncEngine()` sets up:

1. **ObjectPool** &mdash; In-memory reactive cache with MobX observables
2. **IndexedDB** &mdash; Offline persistence that survives tab close
3. **WebSocket** &mdash; Real-time delta streaming from the server
4. **TransactionQueue** &mdash; Batched mutations with optimistic updates and rollback
5. **Bootstrap** &mdash; Initial data load with smart partial sync on reconnect

You don't interact with any of these directly. The `sync.tasks.*` API is all you need.
