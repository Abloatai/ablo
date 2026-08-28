# Coordinate Existing Work

> Start here. Preserve the application, coordinate one operation, and read another page only when the routing table sends you there.

Use this guide to coordinate expensive work while its existing PostgreSQL
transaction remains authoritative.

Many production systems already reserve slow work in Redis and protect the
final write with a PostgreSQL transaction. That is a sound architecture. The
cost appears when every workflow must independently define ownership, expiry,
heartbeat, waiting, recovery, participant identity, and operational visibility.

Ablo standardizes that coordination lifecycle. It does not replace the
application's authoritative transaction.

## Existing backend: copy this shape

For an application that already owns its API and Postgres transaction:

1. Choose one named operation, such as `completeTask`.
2. Keep its API, authorization, validation, transaction, locks, and constraints.
3. Give each concurrent worker a distinct scoped credential.
4. Claim the operation's stable business identifier before expensive work.
5. While the claim is held, call the existing operation to commit.

```ts
const ablo = Ablo({
  schema,
  apiKey: process.env.ABLO_API_KEY,
  transport: 'http',
});

await using lease = await ablo.taskRuns.claim(taskId, {
  contention: { mode: 'skip' },
  ttl: '30s',
  heartbeat: { every: '10s' },
});
if (!lease) return { outcome: 'skipped' };

const prepared = await performExpensiveWork(taskId);
return existingTaskService.commitPrepared(taskId, prepared);
```

The string passed to `claim` is an identifier-only lease. It does not require an
Ablo row and returns no row data. `commitPrepared` must still re-read and validate
inside the application's Postgres transaction. An Ablo lease does not join a
transaction in another process.

If the operation only needs to inspect an Ablo row before calling the existing
write path, keep it this small:

```ts
const task = await ablo.tasks.get({ id: taskId });
if (!task) throw new Error('task not found');

await completeTask({ id: task.id, expectedTitle: task.title });
return task.id;
```

`get({ id })` observes a row. Use `read({ id })` only when its captured evidence
will be passed to an Ablo write through `reads`.

## Change the shape only when required

| Your operation requires this | Use | Read |
|---|---|---|
| The claimed target is an Ablo model row and the final write goes through that model. | Row-backed claim; pass the returned `claim` to the write. | [Coordination](../coordination.md) |
| The result depends on an Ablo row that may change while work runs. | `read(...)` the premise and pass it through `reads`. | [Concurrency Convention](../concurrency-convention.md) |
| Several Ablo writes must all land or none may land. | One `commits.create(...)`. | [API Reference](../api.md) |
| A person needs live state, presence, or reactive local reads. | WebSocket client for that human interface. Workers stay on HTTP. | [React](../react.md) |
| The operation sends email, charges money, writes a file, or calls another provider. | That system's idempotency key or an application outbox. | [Idempotency](../idempotency.md) |

Do not add a mechanism unless its condition is true. In particular, do not
replace an existing database operation merely because Ablo coordinates it.

## Check these boundaries before editing

- What existing operation and public result must remain unchanged?
- What stable identifier represents the contested work?
- Which process performs expensive work, and which process commits?
- Does Postgres or Ablo own each final write?
- What does the caller receive on contention, failure, and retry?

If an answer is unknown, preserve the existing write path. Do not copy an
advanced example or expand the schema to hide the missing decision.

## Prove the implementation

For the adopted operation, test that:

1. The coordinated and existing paths return the same public result.
2. Two distinct participants do not both perform the expensive work.
3. A contender follows the chosen skip or wait behavior.
4. Failure or expiry allows a later attempt to proceed.
5. The existing authorization and database transaction still run.

Local tests prove application behavior. Run
[`examples/coordination-conformance`](../../../../examples/coordination-conformance/README.md)
against hosted Ablo to prove participant identity, heartbeat, exclusion, release,
and expiry. Run staging against the real database and authorization to prove the
production boundary.

For setup, read the [Integration Guide](../integration-guide.md). The complete
implementation on this page is the starter route for an existing backend.
