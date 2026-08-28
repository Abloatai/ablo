# Comparison

> How Ablo relates to the coordination tools an experienced team may already use.

Teams do not need Ablo to build a lock. Redis reservations and PostgreSQL locks
are proven, inexpensive primitives. Ablo is useful when the same team would
otherwise have to define ownership, expiry, recovery, waiting, participant
identity, stale-result handling, and visibility for each new workflow.

## Versus PostgreSQL locks

- **Keep the lock.** PostgreSQL should continue to protect the short,
  authoritative database transaction.
- **Coordinate before the transaction.** An Ablo claim can cover the model call,
  document search, browser session, or tool run that happens before commit.
- **Keep the connection short-lived.** The application does not have to hold one
  database session while an agent waits on external work.
- **Revalidate at commit.** The existing service still applies authorization,
  constraints, version checks, and business rules.

## Versus Redis reservations

- **The primitive is familiar.** Ablo uses expiring leases for live ownership
  and waiting; it does not claim that temporary reservations are novel.
- **The lifecycle is defined.** Acquisition, skip, wait, heartbeat, release,
  expiry, cancellation, and recovery share one client contract.
- **Ownership has identity.** A claim belongs to a scoped participant rather
  than only an arbitrary worker string.
- **Correctness stays durable.** PostgreSQL and commit-time version checks remain
  the backstop when an expired worker resumes late.
- **Contention is visible.** Owners, waiters, duration, and rejection reasons use
  the same operational model across workflows.

## Versus queues and workflow engines

- Queues decide who receives a job; claims decide who may act on a contested
  business resource.
- Redelivery still needs idempotency, and delivery does not prove the rows behind
  a decision are unchanged.
- Workflow engines remain the right owner for durable steps, timers, and retry
  history. Ablo coordinates those workflows with other agents, services, and
  people touching the same state.

## Versus rolling your own

- Start without designing Redis key conventions, ownership tokens, renewal,
  safe release, wait queues, and crash recovery for every call site.
- Reuse one participant and authorization model across workers and human
  interfaces.
- Test against one documented failure contract instead of rebuilding delayed
  worker, expiry, retry, and partial-failure tests per workflow.
- Add captured reads, guarded writes, and atomic Ablo commits only when the
  operation needs them.

## When Ablo is not necessary

PostgreSQL or a small internal reservation can be enough when one team controls
every writer, work is short, contention is rare, and stale or duplicate work is
cheap. Ablo becomes more valuable as slow agent work, independent participants,
shared resources, recovery, authority, and operational explanation matter.

The adoption boundary is intentionally small: keep the architecture that
already works and [coordinate one existing operation](./coordinate-existing-work.md).
