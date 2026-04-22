# Architecture

How Ablo Sync works under the hood.

## Overview

```
┌──────────────────────────────────────────────────────────┐
│  Client (Browser / Node.js / Agent)                      │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ ObjectPool   │  │ Transaction  │  │ SyncWebSocket  │  │
│  │ (MobX)       │←→│ Queue        │←→│ (delta stream) │  │
│  └──────┬───────┘  └──────────────┘  └───────┬────────┘  │
│         │                                     │          │
│  ┌──────┴───────┐                             │          │
│  │ IndexedDB    │                             │          │
│  │ (offline)    │                             │          │
│  └──────────────┘                             │          │
└───────────────────────────────────────────────┼──────────┘
                                                │ WebSocket
┌───────────────────────────────────────────────┼──────────┐
│  Server (Go)                                  │          │
│                                               │          │
│  ┌──────────────┐  ┌──────────────┐  ┌───────┴────────┐ │
│  │ Bootstrap    │  │ Mutation     │  │ WebSocket Hub  │ │
│  │ Handler      │  │ Service      │  │ (broadcast)    │ │
│  └──────┬───────┘  └──────┬───────┘  └───────┬────────┘ │
│         │                 │                   │          │
│         └────────┬────────┘                   │          │
│           ┌──────┴───────┐           ┌───────┴────────┐ │
│           │ PostgreSQL   │           │ Redis Pub/Sub  │ │
│           │ (sync_deltas)│           │ (cross-server) │ │
│           └──────────────┘           └────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

## The Delta Log

Everything flows through `sync_deltas` &mdash; a single append-only table in PostgreSQL.

```sql
sync_deltas
├── id           BIGSERIAL    -- monotonic ordering
├── action_type  VARCHAR(1)   -- 'I' insert, 'U' update, 'D' delete, 'A' archive
├── model_name   VARCHAR(50)  -- 'Task', 'Project', etc.
├── model_id     TEXT         -- entity UUID
├── data         JSONB        -- full entity state after change
├── previous_data JSONB       -- state before change (for undo/conflict resolution)
├── sync_groups  TEXT[]       -- who should see this delta
├── created_by   TEXT         -- user or agent who made the change
├── transaction_id TEXT       -- idempotency key
└── created_at   TIMESTAMPTZ  -- when it happened
```

Every mutation (create, update, delete) produces exactly one delta. The delta is the source of truth. Clients don't query the entity tables directly &mdash; they receive deltas and apply them locally.

## Data Flow

### Write path

```
1. Client calls sync.tasks.create({ title: 'Fix bug' })
2. TransactionQueue batches the mutation
3. Optimistic update: ObjectPool adds entity immediately (UI updates)
4. GraphQL batchAck sent to server
5. Server inserts entity + sync_delta in one transaction
6. Server publishes delta to Redis
7. WebSocket Hub broadcasts delta to subscribed clients
8. Client receives delta confirmation → transaction complete
```

### Read path

```
1. Client connects via WebSocket with lastSyncId
2. Server sends all deltas since lastSyncId (catch-up)
3. Client applies deltas to ObjectPool
4. MobX reactivity triggers UI re-renders
5. Ongoing: new deltas arrive via WebSocket in real-time
```

### Bootstrap

First load or after extended offline:

```
1. Client requests GET /api/sync/bootstrap
2. Server queries all entity tables in parallel (priority-ordered)
3. Returns full snapshot + lastSyncId
4. Client populates ObjectPool + IndexedDB
5. WebSocket connects with lastSyncId
6. Server sends any deltas that arrived during bootstrap
```

## ObjectPool

The in-memory reactive cache. Every entity in the sync engine lives here.

- **MobX observables** &mdash; UI components re-render when entities change
- **Type-indexed** &mdash; `getByType('Task')` is O(1) via `typeIndex: Map<string, Set<string>>`
- **FK-indexed** &mdash; `getByFK('SlideLayer', 'slideId', id)` is O(1)
- **WeakRef GC** &mdash; Long-running sessions don't leak memory
- **Deduplication** &mdash; Same entity ID always returns the same object reference

## Sync Groups

The permission primitive. Every delta has a `sync_groups` array. Clients subscribe to groups. A delta is delivered to a client only if their groups overlap.

```
Delta: { modelName: 'Task', syncGroups: ['org:acme', 'team:eng'] }

Client A: syncGroups = ['org:acme']       → receives (org:acme matches)
Client B: syncGroups = ['org:rival']       → does NOT receive
Agent C:  syncGroups = ['org:acme']        → receives
Client D: syncGroups = ['team:eng']        → receives (team:eng matches)
```

PostgreSQL uses a GIN index on the `sync_groups` array column with the `&&` (overlap) operator for efficient filtering.

## Offline Support

1. **IndexedDB persistence** &mdash; ObjectPool state persisted to IndexedDB on every delta
2. **Transaction queue** &mdash; Mutations queued locally when offline
3. **Automatic flush** &mdash; Queued mutations sent when connection restores
4. **Smart bootstrap** &mdash; On reconnect, only fetch deltas since `lastSyncId` (not full bootstrap)

## Conflict Resolution

Default strategy: **last-write-wins** with rollback.

```
1. Client A updates task.status = 'doing'  (optimistic)
2. Client B updates task.status = 'done'   (wins on server)
3. Server rejects A's mutation (or A's delta arrives after B's)
4. Client A receives B's delta → rolls back optimistic update
5. Client A's UI shows 'done' (server state wins)
```

The `previous_data` field on every delta enables future merge strategies (field-level merge, custom resolvers).

## Multi-Server Scaling

Redis Pub/Sub enables horizontal scaling. Multiple sync server instances share the delta stream.

```
Server 1 (clients A, B)  ←→  Redis  ←→  Server 2 (clients C, D)
```

When Server 1 processes a mutation:
1. Inserts delta into PostgreSQL
2. Publishes delta to Redis channel `sync:deltas`
3. Server 2 receives via Redis subscription
4. Server 2 broadcasts to its connected clients (C, D)
