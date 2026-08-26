# GraphQL.js over an existing backend

> Keep an existing GraphQL API while one named domain operation coordinates its shared-row effects through Ablo.

This recipe uses GraphQL.js with the
[TypeScript library](../../libraries/typescript.md). It adds Ablo behind one
existing query or mutation. It does not generate GraphQL CRUD from every Ablo
model or move business policy into resolvers.

## Preserve these boundaries

- GraphQL remains the public request and response contract.
- The application service or domain operation owns transition policy.
- Ablo coordinates reads, claims, idempotency, and confirmed writes.
- Postgres remains authoritative and keeps its constraints and transactions.
- Existing authentication, migrations, search, files, and workflow execution
  remain in their current owners.

## File structure

```text
src/graphql/index.ts
  -> src/graphql/schema.ts
  -> src/graphql/resolvers.ts
       -> src/tasks/index.ts
            -> src/tasks/completeTask/index.ts
                 -> src/tasks/completeTask/existingPath.ts
                 -> src/tasks/completeTask/coordinatedPath.ts
                 -> src/tasks/completeTask/contract.ts
                 -> src/ablo/index.ts
                      -> src/ablo/client.ts
                      -> src/ablo/schema.ts
```

Replace `tasks` with the nearest domain owner in the application. Do not create
a generic resolver utility or generic domain-operation registry.

## Domain operation

The operation accepts a stable business operation id, coordinates the contested
row, validates the transition, and writes through Ablo:

```ts
// src/tasks/completeTask/index.ts
import { completeTaskThroughCoordinatedPath } from './coordinatedPath.js';
import { completeTaskThroughExistingPath } from './existingPath.js';

export function createCompleteTaskOperation(mode, dependencies) {
  return mode === 'coordinated'
    ? (input) => completeTaskThroughCoordinatedPath(dependencies, input)
    : (input) => completeTaskThroughExistingPath(dependencies, input);
}
```

The complete runnable operation is in
[`examples/graphql-existing-backend`](../../../../../examples/graphql-existing-backend/README.md).
The existing path performs preparation inside the application's current
critical section. The coordinated path acquires claim-or-skip, prepares once,
then calls the same service owner through `commitPrepared(input, result)`. That
method re-reads and commits with a stable idempotency key while retaining the
database integrity boundary.

For a coordination-only rollout, claim the identifier with
`model.claim(id, options)`. This row-free lease avoids an Ablo snapshot read and
does not require synchronizing the application's domain row merely to assign
work. The existing service remains responsible for its authoritative re-read.

The critical section belongs to the injected existing service. Keep its
Postgres transaction, locks, validation, and commit together in that service;
do not wrap an Ablo HTTP call in a transaction callback and assume the remote
write joined the local transaction.

For a remote PostgreSQL database, implement the coordinated happy path as one
locked statement when the transition permits it. A transaction-level advisory
lock acquired in that statement is released automatically when the implicit
transaction ends. This removes client round trips without weakening the
database boundary. Keep the existing multi-statement transaction for the old
path and for operations whose preparation truly depends on transaction-local
state.

## Resolver

The resolver delegates its typed input. It does not perform table reads or
rebuild the transition:

```ts
// src/graphql/resolvers.ts
import type { TaskOperations } from '../tasks/index.js';

export function createResolvers(
  operations: Pick<TaskOperations, 'get' | 'complete'>,
) {
  return {
    task: ({ id }: { id: string }) => operations.get({ id }),
    completeTask: (input: Parameters<TaskOperations['complete']>[0]) =>
      operations.complete(input),
  };
}
```

The executable reference builds its GraphQL schema code-first. Field sources
and resolver return values are typed from the domain operation result instead of
repeating that result in handwritten SDL.

## Verification

Run the same gates as the reference:

```bash
cd examples/graphql-existing-backend
npm test
npm run typecheck
```

The tests prove:

- the documented ownership files exist;
- GraphQL.js executes the real mutation;
- the resolver delegates one input to the named operation;
- domain failures become GraphQL errors rather than resolver-owned recovery; and
- the old and coordinated paths produce the same uncontended GraphQL result;
- two coordinated workers perform expensive preparation once;
- preparation moves outside the retained database critical section; and
- a failed owner releases coordination before rollback to the existing path;
- every file compiles under strict TypeScript.

The optional live proof creates an isolated test branch, executes and replays
the mutation, verifies the resulting row through a separate Ablo client, and
deletes the branch:

```bash
npm run test:live
```

To exercise the incremental-adoption boundary with PostgreSQL authoritative,
provide a staging database:

```bash
DATABASE_URL=postgres://... npm run test:live:postgres
```

That proof creates one uniquely named table, uses a real transaction-level
advisory lock in the injected existing service, and drops the exact table in
`finally`. It compares old and coordinated lock duration, races distinct
delegated worker identities, verifies one expensive preparation, and confirms
that a child process exiting without release remains excluded until its lease
expires. A temporary hosted Ablo branch owns only the claims and is also deleted
in `finally`.

Distinct workers must use distinct delegated sessions. Reusing one API key for
both workers represents one participant and therefore does not prove
exclusion.

Measure end-to-end latency as well as lock duration. A remote lease adds an
acquire and release round trip even when nobody contends. Adopt it where
duplicate work, long database occupancy, crash recovery, or visible ownership
is worth that cost; do not put it around every fast mutation by default.

## Latency and connection topology

Use the live proof to measure four values separately:

| Measurement | What it decides |
| --- | --- |
| Claim acquire and release | Whether coordination belongs around this operation |
| Plain database round trip | Whether the worker and database are too far apart |
| Explicit transaction | How much sequential protocol traffic costs |
| Locked prepared commit | Whether one statement preserves policy and removes that cost |

Do not switch from a pooled database endpoint merely because a transaction is
slow. Benchmark pooled and direct endpoints under the same workload first.
Transaction pooling supports transaction-level advisory locks, while
session-level advisory locks require a persistent session and are a different
contract. PostgreSQL also releases transaction-level advisory locks
automatically at transaction end. See
[Neon connection pooling](https://neon.com/docs/connect/connection-pooling) and
[PostgreSQL advisory-lock functions](https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS).

Prefer reducing dependent round trips and placing the worker, coordination
service, and database in the same region. Regional latency measurements show
that proximity has a much larger effect than query tuning when the query itself
is already cheap. See the
[Neon regional latency dashboard](https://neon.com/demos/regional-latency).

Keep a long-lived server client for workers. Node's HTTP dispatcher reuses
persistent connections, so the first request may include connection setup that
later requests do not. Record cold and warm percentiles separately; do not
present a warmed median as the production tail. See
[Node.js HTTP connection reuse](https://nodejs.org/api/http.html#class-httpagent).

## Failure boundary

A claim coordinates only participating callers. Existing direct SQL writers do
not begin obeying that claim merely because Ablo observes their changes through
WAL. Adopt one complete mutation lane at a time, and keep the existing Postgres
transaction as the final integrity boundary.

## Roll out without changing product behavior

Put the operation behind a per-operation switch. Before enabling it, capture
the current GraphQL contract, authorization decisions, business effects,
latency, and database-lock duration. Exercise the existing and coordinated
paths with the same inputs, including contention, replay, timeout, and worker
exit cases.

Enable the coordinated path only when it preserves the public contract and
does not lengthen the database critical section. Keep the existing path
deployable until production measurements show that coordination reduces the
selected race without regressing latency or recovery.
