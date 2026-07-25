# Guarantees

> Exactly what a confirmed write, a rejected stale write, and a held claim each promise.

When an Ablo write succeeds, the server has accepted it — and when two agents
touch the same row, Ablo coordinates them instead of letting one silently
overwrite the other. This page is the precise list of what you can count on:
confirmed writes, stale-write protection, claims, and the audit trail behind
every change.

Claims don't lock. If another writer holds the row, `claim` waits for them,
re-reads the fresh row, then hands it to you — so two writers serialize instead
of clobbering.

## Confirmed Writes

`wait: 'confirmed'` resolves only after the server accepts the write and returns
the authoritative sync cursor.

```ts
const updated = await ablo.weatherReports.update({
  id: 'report_stockholm',
  data: { status: 'ready' },
  wait: 'confirmed',
});
```

If the call resolves, the write was accepted by the server. If it rejects, the
typed error tells you exactly why — the most common reasons being failed
authorization, a schema validation error, or a stale-state or claim conflict
(each covered below).

Schema model writes return the updated model row.

## Optimistic Local State

Schema model writes update local state optimistically. This keeps UI and agent
tools responsive while the commit is sent to the server.

- With `wait: 'queued'` or omitted, the promise resolves after the local mutation
  is queued.
- With `wait: 'confirmed'`, the promise waits for server confirmation.
- If the server rejects the write, the SDK rolls back the optimistic change and
  raises a typed error.

The server remains the source of truth.

## Stale-Write Protection

Use `snapshot(...)` and `readAt` when a write depends on state the agent already
read:

```ts
const snap = ablo.snapshot({ weatherReports: 'report_stockholm' });

await ablo.weatherReports.update({
  id: 'report_stockholm',
  data: { status: 'ready' },
  readAt: snap.stamp,
  onStale: 'reject',
  wait: 'confirmed',
});
```

`onStale: 'reject'` prevents lost updates. If the target changed after the
snapshot, the server rejects the write instead of applying stale reasoning.

Two other dispositions exist. `overwrite` applies the write with no stale check
at all. `notify` **holds** the write, so the row is left as it stands, and hands
back a `StaleNotification` carrying the current value for the actor to reconcile
and re-issue; the rest of the batch still commits.

See [Concurrency Convention](./concurrency-convention.md) for the full taxonomy,
what each disposition is checked against, and where the convention stops.

## Claim Coordination

> The guarantee, not the how-to. Methods, the claim-state object, and the `claim.queue`
> live in [Coordination](./coordination.md).

Claims are live coordination signals. They are not database locks.

`ablo.<model>.claim({ id })` serializes on contention: if another human or agent
already holds the row, the claim waits for them to finish, then re-reads the row
before handing it back, so you proceed from fresh state. Reads stay open while a
claim is held — `ablo.<model>.claim.state({ id })` returns the current claim state
(or `null`) without ever blocking. A server read can pass `ifClaimed: 'fail'` to
error out, when it should not return a row while someone else is mid-edit. Reads
never block on a claim — to wait for a row to free up, `claim({ id })` it (the
claim queues fairly behind the holder).

A claim does not reject or block other writers; it announces work so peers
serialize behind it rather than racing. While you hold a claim, the matching
`ablo.<model>.update({ id, ... })` is rejected with `AbloStaleContextError` if the row
changed underneath you after your claim point.

## Agent Runs

Agents should import the same schema as the app and write through
`ablo.<model>.claim(...)` plus `ablo.<model>.update(...)`.

## Audit Trail

Attribution is not a separate log you opt into. It rides on the change itself.
Every broadcast delta names the actor, the authority it acted under, the
credential that authorized it, and the approval stage it was in:

```ts
{
  modelName:         'weatherReports',
  modelId:           'report_stockholm',
  actionType:        'U',
  actor:             { kind: 'agent', id: 'weather-agent-v3' },
  onBehalfOf:        { kind: 'user',  id: 'user_8f2a' },
  capabilityId:      '…',       // the key the write was authorized by
  confirmationState: 'auto',    // previewed | approved | required_human_approval
  createdAt:         '2026-05-14T14:22:01.034Z',
}
```

`actor` and `onBehalfOf` are derived from the credential, not from the call site,
so an agent cannot name a different actor in its own write. `capabilityId` is
non-null for every agent and system commit, so a write can always be traced to
the key that made it, and from that key to the person it was issued to.

The stored history goes one step further than recording. Audit rows are chained
with a keyed hash, so the log is tamper-*evident*: `verify-chain` walks the chain
and, if it breaks, names the sequence number and the hashes that disagree. No
chain roots at an agent. The delegation root is always the person who set the
work in motion.

For agent work this is what answers, after the fact: what changed, who authorized
it, which run did it, and whether a human was in the loop.

See [Audit Log](./audit.md) for the stored row shape, the filters, verification,
and export.

## Persistence

Ablo defaults to in-memory persistence ('memory'), so nothing is written to disk
unless you ask for it.

Opt into a durable browser cache that survives reloads when you need it:

```ts
const ablo = Ablo({
  schema,
  apiKey: process.env.ABLO_API_KEY,
  persistence: 'indexeddb',
});
```

Node, SSR, tests, and agents use in-memory persistence ('memory') automatically.

Cache persistence and outbound-write recovery are separate concerns. Most
clients need only the default memory cache: once the server confirms a write,
the server is durable and the idempotency key makes a retry safe. A long-running
worker that must also recover an unacknowledged write after its own process dies
can opt into a durable write journal:

```ts
const ablo = Ablo({
  schema,
  apiKey: process.env.ABLO_API_KEY,
  durableWrites: {
    store: workerWriteStore,
    namespace: 'report-worker',
  },
});
```

The store can be backed by the worker's workflow state, SQLite, or another
durable system. Actor identity is derived from authentication; `namespace` only
separates workflow or deployment lanes sharing the same store.

## Storage Boundary

Your rows live in your database; Ablo holds only the transaction log and the
coordination state. Writes enter Ablo's commit chokepoint and land in your
Postgres through a scoped writer role, and the WAL echo confirms them
(`queued` → `confirmed`). For a database that can't grant replication, Ablo
forwards the write to a signed Data Source endpoint instead — the marked
fallback. Either way Ablo never holds a database connection string. See
[Connect Your Database](./data-sources.md).

## Writes

Use `ablo.<model>.create/update/delete` for state changes. The server validates
authorization, stale state, active claim conflicts, and idempotency before
accepting the write.
