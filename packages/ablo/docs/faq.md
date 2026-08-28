# FAQ

> Short answers to the implementation choices developers encounter most often.

## Does Ablo replace PostgreSQL?

No. PostgreSQL remains the durable source of truth. Keep its schema, constraints,
transactions, row-level security, and short write locks. Ablo coordinates work
around that state and can route guarded writes into it.

## Does Ablo replace Redis locks?

It can replace an application-owned reservation layer, but it does not require a
rewrite. Ablo standardizes resource identity, participant identity, leases,
waiting, recovery, stale-work rejection, and visibility. Teams can begin by
coordinating an existing operation while its final transaction remains in the
application.

## Is Ablo only for agents?

No. Agents, workers, application services, and people can coordinate over the
same resources. The package-root client is suited to stateless server work; the
[React client](./react.md) adds live state and presence for human interfaces.

## Which client should I import?

Use the default export from `@abloatai/ablo` for agents, workers, route handlers,
and server operations. It uses ordinary request/response HTTP. Use
`@abloatai/ablo/react` when a live interface needs local synchronized state,
subscriptions, or presence.

## What is the difference between get and read?

`get({ id })` observes the current row. `read({ id })` captures the exact row
version as evidence for a later guarded write. Pass that returned row in the
mutation's `reads` array when the decision must be rejected if its premise
changed.

## When should I claim a resource?

Claim before slow or expensive work when another participant should not perform
conflicting work on the same business resource. Do not add a claim to every
write: a short, independent update can use its normal database and mutation
semantics.

## Is a claim a database lock?

No. A claim is a participant-scoped lease held across work that may outlive one
database transaction. It expires after heartbeat loss. PostgreSQL locks still
protect the short authoritative transaction.

## What if code writes directly to PostgreSQL?

Ablo observes the resulting change through the configured data source, but the
writer bypasses Ablo claims and request ordering. Keep database constraints for
rules that must apply to every writer.

## Are retries exactly once?

Ablo idempotency deduplicates the same Ablo request within its retention window.
It does not make external side effects exactly once. Use the external provider's
idempotency mechanism or an application-owned effect record.

## Does Ablo run long workflows?

No. Temporal, Inngest, queues, and application workers still own scheduling,
retries, and durable workflow progress. Ablo coordinates the shared state those
executions read and change.

## Do I need to understand fencing first?

No. Start from the public behavior: a claim expires, another participant can
take over, and an obsolete owner cannot use an old claim to commit through Ablo.
The implementation mechanism is documented for operators and advanced
integrations, not required for basic SDK use.
