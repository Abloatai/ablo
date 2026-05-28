# Roadmap

What is shipped, what is next, and what we will not build.

## Shipped

- **Models, claims, commits** — the core API.
- **Audit log** — hash-chained per principal, with `delegationChainRoot`.
- **MCP transport** — HTTP server at `/api/mcp`.
- **TypeScript SDK** — `@abloatai/ablo`, with React bindings.
- **Dashboard** — keys, audit, metrics, allowed origins.
- **Schema migrations** — declarative model schema changes. Pure
  diff/classify/cast-safety/backfill planning engine (`diffSchema`,
  `classifyMigration`, `classifyCast`, `isAutoApplicable`) ships in the SDK;
  `ablo generate` emits typed clients from a pushed schema; the server
  applies and activates migrations only on success.
- **Structured error contract** — versioned (`ERROR_CONTRACT_VERSION`),
  drift-guarded code registry shared across the HTTP, WebSocket, and MCP
  planes, with always-on request ids and an OpenAPI error envelope.
- **Relation-driven sync groups** — membership-routed fan-out via branded
  `SyncGroup` + schema-declared identity roles (schema-JSON v2).
- **Intent coordination plane** — Stripe-shaped `Intent` with per-model
  `intent(id)` handles for lease/await/commit coordination between agents.

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
