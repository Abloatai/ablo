# Offline & Sync Groups

## Offline Support

The sync engine is offline-first. Data lives locally in IndexedDB. Network is optional.

### How it works

```
Online:   Client ←→ WebSocket ←→ Server ←→ PostgreSQL
Offline:  Client ←→ IndexedDB (mutations queue, replay on reconnect)
```

1. On first load, server sends a full data snapshot (bootstrap)
2. Client stores everything in IndexedDB
3. Subsequent loads read from IndexedDB first, then sync in background
4. Mutations queue locally when offline and flush on reconnect
5. Reconnection fetches only deltas since `lastSyncId` (not a full bootstrap)

### Opt in / opt out

```typescript
// Default: offline enabled
const sync = createSyncEngine({ url, schema });

// Online-only (no IndexedDB, lighter footprint)
const sync = createSyncEngine({ url, schema, offline: false });
```

### What works offline

| Feature | Offline | Notes |
|---------|---------|-------|
| Read cached data | Yes | Everything from last sync |
| Create entities | Yes | Queued, synced on reconnect |
| Update entities | Yes | Queued, synced on reconnect |
| Delete entities | Yes | Queued, synced on reconnect |
| Real-time updates | No | Requires WebSocket |
| Bootstrap | No | Requires server |
| AI agent subscriptions | No | Requires WebSocket |

### Conflict resolution

When a client goes offline, makes changes, and comes back online:

1. Queued mutations are sent to the server in order
2. Server processes them — if a conflict exists (another user changed the same entity), **server wins**
3. The server delta arrives and updates the local state
4. If the server rejected the mutation, the optimistic update rolls back automatically

This is **last-write-wins** at the entity level. Field-level merge is planned but not yet implemented.

## Sync Groups

Sync groups control **who sees what data**. Every delta has a `syncGroups` array. Clients subscribe to groups. A delta is delivered only if the client's groups overlap.

### How they work

```
Server creates a delta:
  { modelName: 'Task', syncGroups: ['org:acme', 'team:engineering'] }

Client A subscribes to: ['org:acme']           → receives it
Client B subscribes to: ['org:rival']           → does NOT receive it
Agent C subscribes to:  ['org:acme']            → receives it
Client D subscribes to: ['team:engineering']    → receives it
```

### Common patterns

| Pattern | Who sees the data | Use case |
|---------|------------------|----------|
| `org:{orgId}` | Everyone in the organization | Most entities |
| `user:{userId}` | Only that user | Personal data, notifications |
| `team:{teamId}` | Only team members | Team-scoped projects/tasks |
| `deal:{dealId}` | All parties in a deal | Multi-party deal rooms |

### Multi-party example

A deal between a buyer and a seller:

```
Buyer org subscribes to:  ['org:buyer',  'deal:D123']
Seller org subscribes to: ['org:seller', 'deal:D123']
```

Both see the shared deal room data (`deal:D123`), but neither sees the other's internal org data. An AI agent reviewing the deal for the buyer:

```typescript
const agent = new SyncAgent({
  syncGroups: ['org:buyer', 'deal:D123'],
  // Sees buyer's org data + shared deal data
  // Does NOT see seller's org data
});
```

### Server-side scoping

The Go server uses PostgreSQL's GIN index on the `sync_groups` array column with the `&&` (overlap) operator:

```sql
SELECT * FROM sync_deltas
WHERE id > $1
  AND sync_groups && $2   -- array overlap
ORDER BY id ASC
LIMIT $3;
```

This is efficient even at scale — the GIN index handles millions of deltas.

### Dynamic group changes

When a user joins or leaves a team, the server emits a "G" (group change) delta:

```json
{
  "actionType": "G",
  "data": {
    "addedGroups": ["team:new-team"],
    "removedGroups": ["team:old-team"]
  }
}
```

The client processes this by forcing a full re-bootstrap, which naturally purges data the user no longer has access to (ghost removal).
