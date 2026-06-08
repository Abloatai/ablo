# Roadmap

What is shipped, what is next, and what we will not build.

## Shipped

- **Models, claims, commits** — the core API.
- **Audit log** — a tamper-evident, hash-chained record of who did what,
  per principal.
- **MCP transport** — HTTP server at `/api/mcp`.
- **TypeScript SDK** — `@abloatai/ablo`, with React bindings.
- **Dashboard** — keys, audit, metrics, allowed origins.
- **Schema migrations** — change a model's shape after it already has data.
  Ablo plans the migration, tells you which changes are safe to auto-apply,
  and backfills the rest; the server applies and activates a migration only
  if it succeeds. `ablo generate` emits typed clients from a pushed schema.
- **Structured errors** — every error has a stable code and a request id,
  and the same codes work whether you reach Ablo over HTTP, WebSocket, or MCP.
- **Sync groups** — clients automatically receive only the records they have
  access to, based on relationships you declare in the schema.
- **Agent coordination** — when several agents work on the same model, they
  take turns instead of overwriting each other, via `intent(id)` handles
  that claim, wait, and commit.

## In flight

- **Real-time presence** — see who else is viewing/editing a model
  (coordination primitives landed; presence surface in progress).
- **Cross-instance fan-out via Redis** — pub/sub deltas at scale.

## On deck

- **Field-level subscriptions** — subscribe to one path, not the whole row.
- **Bulk import/export** — CSV/JSON round-trip with chain verification.

## Maybe, if demand

- **Python SDK** — when a customer is shipping a Python-only product.
- **Go SDK** — same.
- **Multi-region replication** — when latency requirements force it.

## We will not build

- **A general-purpose Postgres wrapper** — Ablo is for state with
  concurrency semantics, not for storing every table.
- **Server-side compute** — no triggers, no stored procedures. Compute
  belongs in your application code.
- **A document database UI** — your data lives in Ablo; the UI is your
  product, not ours.

## How priorities shift

We move items between sections based on what customers ask for in
production. Filing a [feature request](/docs/contact) with a concrete use
case is more effective than a thread on Twitter.
