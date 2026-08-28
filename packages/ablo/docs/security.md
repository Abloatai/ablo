# Security

> The authority boundaries to preserve when agents, applications, and people coordinate through Ablo.

Ablo carries authenticated participant identity into coordination and writes.
It does not replace your application's authorization, PostgreSQL constraints, or
transactional invariants.

## Keep secret credentials on the server

Trusted agents, workers, route handlers, and services use a server-side `sk_`
credential, normally supplied through `ABLO_API_KEY`. Never include it in a
browser bundle or agent-generated output.

Browsers use either a publishable read-only `pk_` credential or a short-lived,
scoped session minted by your backend through `authEndpoint`. See [API
Keys](./api-keys.md) and [Sessions](./sessions.md) for the credential classes and
minting flow.

## Give every participant its own identity

Claims are re-entrant for the same participant. Two workers that share one
credential can therefore appear to Ablo as the same owner. Use separate scoped
participant credentials when independently operating agents must contend.

The credential also determines project, branch, organization, and allowed
operations. Callers cannot broaden that authority by adding ids to a request.

## Treat claims as coordination, not authorization

A claim says who currently owns a piece of work. It does not grant permission to
read or write that resource. Authorization is evaluated independently, and the
final write must still satisfy the database schema and application invariants.

Claims are leases rather than permanent locks. They expire when their owner
stops heartbeating. A guarded Ablo write checks ownership again at commit time so
an expired participant cannot use an old claim handle.

## Keep PostgreSQL authoritative

Ablo coordinates work before and during a write; PostgreSQL remains the durable
source of truth. Existing constraints, transactions, row-level security, and
short database locks can remain in place.

A direct database write bypasses Ablo's claims and request ordering. Logical
replication makes the result visible to Ablo readers, but cannot retroactively
coordinate the writer. Preserve database constraints for every invariant that
must also hold for bypass writers.

## Bound external side effects separately

Ablo idempotency covers an Ablo request. It cannot make an email, payment, model
call, or third-party API mutation exactly once. Give the external provider its
own idempotency key, or persist an application-owned effect record and reconcile
ambiguous outcomes.

## Report vulnerabilities privately

Do not put credentials, customer data, or an unpatched vulnerability in a public
issue. Report it through [GitHub Security
Advisories](https://github.com/Abloatai/ablo/security/advisories/new).

For operational checks and key rotation, continue to [API Keys](./api-keys.md),
[Audit Log](./audit.md), and [Operating on Your Database](./operating-on-your-database.md).
