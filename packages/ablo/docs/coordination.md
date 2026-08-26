# Coordination

> Choose plain writes, functional updates, stale guards, or claims without losing concurrent work.

Ablo gives you several concurrency tools because not every write has the same
meaning. Choose the narrowest one that matches the operation.

| Situation | Use | Result |
|---|---|---|
| Set an independent value | `update({ id, data })` | Last-write-wins when no claim applies. |
| Compute a value from the current row | `update(id, current => next)` | Re-reads and retries if the row changes concurrently. |
| Write only if earlier rows are still current | `reads: [record, rules]` | Rejects when an explicitly named dependency changed. |
| Read, call a model, then write | `claim({ id })` | Other participants cannot write the claimed target by default until your claim ends. |

**If a model call sits between the read and the write, take a claim.** A stale
guard tells you the row moved after you have already paid for the turn. A claim
makes the contender wait before it spends anything, and it reads the winner's
result rather than reasoning against state that has since moved.

The important boundary is explicit: a plain update does not claim a row and
does not carry a stale premise. It is intentionally last-write-wins.

## Explicit read dependencies

Pass the exact rows that produced a decision on the write:

```ts
const record = await ablo.records.read({ id: recordId });
const policy = await ablo.policies.read({ id: policyId });
if (!record || !policy) throw new Error('required input is missing');

const result = await model({ record, policy });

await ablo.records.update({
  id: record.id,
  data: result,
  reads: [record, policy],
});
```

This means “apply this update only if the rows used to produce it have not
changed.” The exact returned objects carry opaque evidence; no watermark is
exposed. Same-row and cross-row dependencies use one shape. Incidental reads do
nothing, and cloned, fabricated, or cross-client rows fail locally.

When one decision needs several Ablo reads plus application-owned memory or
retrieval results, [Context](./context.md) assembles those values and returns
the exact authoritative rows as `ctx.reads`.

An `undefined` result cannot carry evidence. Guarded absence therefore remains
a separate low-level design; do not treat a missing read as an automatic
create-if-absent condition.

## Functional updates

When the next value is a function of the current one, pass an updater rather
than fixed data:

```ts
const document = await ablo.records.update(recordId, (current) => ({
  revision: current.revision + 1,
  content: revise(current.content),
}));
```

The SDK reads the current row, runs the updater, and writes only if that row is
still current. If another write wins first, it re-reads and runs the updater
again. This prevents the usual lost-update race without holding a claim across
your application code.

Use this form only for a pure calculation. Because the updater may run more than
once, do not send email, charge a card, call a model, or perform another side
effect inside it.

You can bound or cancel reconciliation:

```ts
await ablo.records.update(
  recordId,
  (current) => ({ revision: current.revision + 1 }),
  { retries: 8, signal: request.signal },
);
```

If contention continues beyond the retry budget, the call rejects with
`AbloContentionError` and does not apply a stale calculation.

## Stale guards

Use explicit returned rows when application code reads first and writes later,
but does not need to reserve the row:

```ts
const report = await ablo.reports.read({ id: reportId });
if (!report) throw new Error('report missing');

await ablo.reports.update({
  id: report.id,
  data: { status: 'ready' },
  reads: [report],
});
```

There is no stale-mode option on the write. If a declared row changed, Ablo
rejects the whole mutation with `AbloStaleContextError`. Re-read and recompute,
or use the functional update form when the computation is pure and retryable.
To make an unconditional assignment, omit `reads` deliberately.

See [Concurrency Convention](./concurrency-convention.md) for guarded batches
and the `get` / `read` boundary.

## Claims

Use a claim when work must remain exclusive across a slow gap such as an LLM
call or another external service:

```ts
await using claim = await ablo.reports.claim({
  id: reportId,
  description: 'generating forecast',
});

const forecast = await generateForecast(claim.data.location);

await ablo.reports.update({
  id: claim.data.id,
  data: { forecast, status: 'ready' },
});
```

If another participant already holds the target, `claim` waits its turn and
then resolves with a fresh row in `claim.data`. Ordinary reads remain open. By
default, a write from a participant that does not hold the active claim is
rejected.

Bind claims with `await using` whenever possible. The claim then releases when
the scope exits, including when the external call or write throws. For runtimes
without explicit resource management, use `try/finally` and
`await claim.release()`.

### One identity per participant

Explicit claims coordinate authenticated participants. Two clients using the
same credential represent the same participant and do not exclude one another.
Mint a distinct scoped session for each independently coordinated agent:

```ts
const { token } = await server.sessions.create({
  agent: { id: `forecast-agent-${workerId}` },
});

const agent = Ablo({ schema, apiKey: token });
```

Functional updates do not require distinct participant identities because they
protect the row version rather than a participant-held claim.

### Skip instead of wait

For deduplicated jobs, skip work when another participant already owns it:

```ts
const claim = await ablo.records.claim({
  id: recordId,
  contention: { mode: 'skip' },
});

if (!claim) return;

try {
  await processTask(claim.data);
} finally {
  await claim.release();
}
```

To wait with limits, keep the contention settings together:

```ts
const claim = await ablo.records.claim({
  id: recordId,
  contention: {
    mode: 'wait',
    maxDepth: 3,
    timeoutMs: 30_000,
    signal: request.signal,
  },
});
```

### Claim part of a row

Narrow a claim when independent fields may be edited concurrently:

```ts
await using claim = await ablo.records.claim({
  id: recordId,
  fields: (record) => record.status,
});
```

Claims on disjoint fields can coexist. A whole-row claim conflicts with every
field claim on that row.

### Relations do not create hierarchical claims

A `parent: true` relation controls ownership, access inheritance, and sync
routing. It does not make claims conflict across related rows. For example, a
claim on one document row and a claim on one of its page rows have different
model-and-ID targets and can coexist.

Choose the row that represents the actual unit of exclusive work. Page rows
allow different pages to process concurrently. If a whole-document operation
must exclude every page operation, enumerate the authoritative page manifest,
acquire page claims in one stable order, and guard the manifest against change.
Do not infer that exclusion from the schema relation alone.

The target options are:

| Option | Purpose |
|---|---|
| `options.field` | Claim one field by its wire-level name. Prefer the typed selector in application code. |
| `options.fields` | Claim one or more schema fields with a typed selector. |
| `options.meta` | Attach application-defined metadata observers may display. |

## Observe coordination

Read current claim state without blocking:

```ts
const holder = ablo.records.claim.state({ id: recordId });
const queue = ablo.records.claim.queue({ id: recordId });
```

Use this state for presence and progress UI. Do not use an observed `null` as a
substitute for claiming: another participant can acquire the row immediately
after your read.

The main methods are:

| Method | Purpose |
|---|---|
| `claim({ id, ...options })` | Read and claim an existing model row; the handle includes fresh row data. |
| `claim(id, options)` | Claim an identifier in a registered model namespace without reading a row. |
| `claim.state({ id })` | Read the current holder without blocking. |
| `claim.queue({ id })` | Read the current wait order. |
| `claim.release({ id })` | Release early when you do not hold a handle. |
| `join({ scope })` | Observe presence for a broader scope. |

Choose the overload deliberately:

| Form | Evidence requirement | Typical use |
|---|---|---|
| `model.claim({ id })` | The row exists and the caller may read it. | Coordinate work on a synchronized row while using `handle.data`. |
| `model.claim(id, options)` | The model namespace is registered; no row is read. | Select one participant before calling an existing authoritative service. |

The identifier-only form is row-free, not schema-free. It does not authorize a
worker or test fixture to push an unrelated model into an inherited production
schema. Register the namespace through the application's normal schema process,
or select an already registered namespace whose ownership matches the operation.

## Coordinate an existing database operation

Use this pattern when an application already has a service that protects a
transition with a Postgres row lock or advisory lock, but slow preparation such
as OCR, a model call, or another tool currently happens while that database
lock is held.

Keep the ownership boundary explicit:

| Owner | Responsibility |
|---|---|
| Ablo claim | Select one participating worker before expensive work begins. |
| Application service | Authoritative re-read, transition policy, database lock, idempotency, and commit. |
| Postgres | Canonical row, constraints, and final integrity boundary. |

The operation runs in this order:

```text
claim identifier
  -> prepare expensive result once
    -> application service re-reads and commits under its database lock
      -> release claim in finally
```

Model the service seam as two operations rather than moving database policy
into a resolver, worker, or agent tool:

```ts
interface ExistingOperationService<Input, Result, Row> {
  run(
    input: Input,
    prepare: () => Promise<Result>,
  ): Promise<Row>;

  commitPrepared(
    input: Input,
    prepared: Result,
  ): Promise<Row>;
}
```

The existing rollout path calls `run` and preserves current behavior. The
coordinated path wins the claim, prepares once, then calls `commitPrepared`.
Both methods stay under the same application-service owner and enforce the same
authorization and transition rules.

When the transition permits it, implement `commitPrepared` as one SQL statement
that acquires a transaction-level advisory lock, re-reads the row, validates
its current state, and updates it. The statement's implicit transaction
releases the advisory lock automatically. This can remove several sequential
client/database round trips without replacing the existing database lock.

Do not make any of these substitutions:

- Do not assume a remote Ablo request joins a local Postgres transaction.
- Do not remove database constraints or locks during the coordination rollout.
- Do not prepare expensive work speculatively before the claim resolves.
- Do not assume direct SQL writers obey an Ablo claim. A claim coordinates only
  callers routed through the participating operation.
- Do not use a claim as durable workflow state. A lease expires; workflow
  progress must survive independently.

Measure the old and coordinated paths with the same inputs. Record cold and
warm claim acquire/release latency, database round-trip latency, database-lock
duration, end-to-end latency, duplicate work under contention, and recovery
after worker exit. Keep a per-operation switch to the old path until the new
path preserves behavior and improves the selected race at production
percentiles.

For a runnable GraphQL.js implementation and PostgreSQL race/crash proof, see
[GraphQL.js over an existing backend](./approaches/graphql/graphql-js.md).
For a domain-neutral hosted lease proof, see
[Verify hosted coordination separately](./examples/coordination-conformance.md).
For the same operation boundary applied to source-versioned document
processing, see
[Process an existing document once](./examples/existing-document-pipeline.md).

## Choosing correctly

- Prefer a plain update for values that do not depend on an earlier read.
- Prefer a functional update for a quick, pure read-modify-write calculation.
- Prefer a stale guard when your caller should decide how to reconcile.
- Prefer a claim when you must hold exclusivity across slow or side-effecting
  work.
- Prefer idempotency for safe retries; it solves a different problem from
  concurrency.

For exact error codes and recovery guidance, see [Errors](./errors.md). For what
a confirmed write promises, see [Guarantees](./guarantees.md).
