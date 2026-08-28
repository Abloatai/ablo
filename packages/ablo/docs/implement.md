# Choose the Ablo operation

> Find one implementation route from the work you are doing, copy its smallest recipe, and open guarantee details only when you need recovery behavior.

Do not read the documentation front to back. Start with the operation your
application already has, then use one row below.

| What you are implementing | Start here | Add only when |
|---|---|---|
| Get one row by id or list rows with the installed client | [Basic usage](./basic-usage.md) | Use `read`, not `get`, only when a later Ablo write depends on that exact row. |
| Configure a stateless worker's identity, permissions, or lifecycle | [Agents](./agents.md) | Keep the worker on HTTP; live human interfaces use React. |
| Wrap an existing API, service, Postgres transaction, filesystem write, or Git merge | [Coordinate existing work](./coordinate-existing-work.md) | Keep the final write in its existing owner. |
| Expose an existing named operation through GraphQL.js | [GraphQL.js](./approaches/graphql/graphql-js.md) | Keep the resolver dependent on that operation, not directly on Ablo. |
| Hold an Ablo model row while slow work runs, then write it through Ablo | [Coordination](./coordination.md) | Pass the returned claim handle to the write. |
| Reject a write when an earlier decision input changed | [Concurrency convention](./concurrency-convention.md) | Pass the exact object returned by `read` through `reads`. |
| Apply several Ablo writes all-or-none | [Atomic commits](./api.md#atomic-commits) | Put every operation and every captured premise in one `commits.create`. |
| Make a retried Ablo write safe | [Idempotency](./idempotency.md) | Derive one key from the business event and reuse it only for the identical request. |
| Send email, charge money, call a provider, or write a file | Keep that effect in the application | Use the provider's key or an application outbox; an Ablo key covers only the Ablo mutation. |
| Add a live human interface | [React](./react.md) | Humans use the WebSocket/live plane; stateless workers stay on HTTP. |

## The four choices agents most often confuse

```ts
// Observe one current row. No later stale check.
const task = await ablo.tasks.get({ id });

// Declare a premise for one later Ablo write.
const premise = await ablo.tasks.read({ id });
if (!premise) throw new Error('task not found');
await ablo.tasks.update({ id, data, reads: [premise] });

// Hold an Ablo row across slow work. The final write goes through Ablo.
await using claim = await ablo.tasks.claim({ id });
await ablo.tasks.update({ id, data, claim });

// Coordinate row-free work whose final write stays in the application.
await using lease = await ablo.taskRuns.claim(id, {
  contention: { mode: 'skip' },
});
if (lease) await existingTaskService.complete(id);
```

Use only one of those shapes unless the operation genuinely has both a claimed
target and separate captured premises. Claims answer who may work; `reads`
answer whether evidence is still current; `commits.create` answers whether
several Ablo writes land together; the existing database transaction still
owns atomicity for application-owned writes.

## Before writing code

Answer these five questions:

1. Which existing operation am I preserving?
2. Does the final write belong to Ablo or to the application?
3. Is the coordination identity a model row or only a stable business id?
4. Which exact rows influenced the decision?
5. Which writes must land together?

If an answer is unknown, preserve the existing operation and database boundary.
Do not introduce claims, captured reads, or atomic commits merely because they
exist.
