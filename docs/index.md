# Ablo Docs

Ablo is a state control API for **humans and AI agents editing the same
typed state in real time, with attribution, conflict handling, and
fast cutoff**.

It gives agents a narrow way to write production state: declare models, load current state, coordinate active work, and write with stale-state checks. Capabilities, tasks, commits, and receipts are the protocol underneath, not first-integration ceremony.

Multiplayer is not a separate product mode. If humans, server actions, and agents
use the same `Ablo({ schema, apiKey })` client and write through
`ablo.<model>`, Ablo fans out confirmed deltas, exposes active intents, and
rejects stale writes for every participant.

## What you get, in three commitments

These commitments drive every design choice in the rest of the docs; if
they don't match what you're building, the trade-offs land elsewhere
(Replicache, ElectricSQL, PowerSync for human-only real-time; Zero for
query-shaped sync).

- **One model API for every actor.** `ablo.<model>.update(...)` is the
  call from React components, server actions, background workers, and
  AI agents alike. No separate "agent SDK," no parallel mutation path.
  Attribution comes from the credential, not the call site.
- **Server owns the scope convention.** Tenancy / per-entity scope
  prefixes (`org:`, `deck:`, or your own `region:` / `customer:`) are
  declared once on the schema's `identityRoles`. Consumer code never
  composes group strings. Same boundary Liveblocks (`prepareSession`),
  PowerSync (named streams), and Zero (synced queries) settled on.
- **Capabilities, not API keys, for agents.** Per-run, per-scope, leased
  credentials with per-request signature verification and instant
  revocation. The 2025-26 AI-agent auth consensus (OAuth 2.1 / MCP,
  AWS STS, Vault leases, Auth0 Token Vault) converged on this shape;
  capabilities are Ablo's instance. See
  [Capabilities](./capabilities.md#why-capabilities-not-api-keys) for
  the design rationale.

## Start here

- [Quickstart](./quickstart.md) — Make your first schema-backed write.
- [Integration Guide](./integration-guide.md) — Choose Ablo-managed state, Data Source, React, multiplayer, and agent patterns.
- [Guarantees](./guarantees.md) — What confirmed writes, stale checks, and intents guarantee.
- [Interaction Model](./interaction-model.md) — The commit plane and control plane.
- [API Reference](./api.md) — Resource-by-resource method shape.
- [Client Behavior](./client-behavior.md) — Options, errors, retries, timeouts, and imports.
- [Connect Your Database](./data-sources.md) — Keep canonical rows in your app database without giving Ablo database credentials.
- [API Keys](./api-keys.md) — Bearer tokens for the public API.

## API shape

| Plane | Primitives | Purpose |
|---|---|---|
| State | `Schema`, `Model`, `Intent`, `Receipt` | The product path. Load, coordinate, write, confirm. |
| Commit | `Resource`, `Commit` | Advanced protocol path for custom runtimes and batches. |
| Control | `Capability`, `Task`, `Usage` | The authority path. Scope, attribute, meter, audit. |
| Storage | `Managed State`, `Data Source` | Ablo stores declared models by default; existing app tables use a signed Data Source. |

## Use cases

- **Let agents write to shared state** — Give an AI agent scoped, revocable write access to your typed data.
- **Coordinate multiple actors** — Use intents to broadcast pre-write declarations across humans and agents.
- **Audit every agent action** — Trace any write back to a human in one query.
- **Build collaborative editors** — Humans and agents on the same record, with realtime updates and stale-read protection.
- **Meter and gate API usage** — Per-key, per-team usage reports and quota enforcement.
- **Integrate with A2A and MCP** — Speak the same protocols as Claude, Cursor, Gemini.

## Concepts

- [Model Methods](./api.md#model-methods) — Load and write typed state.
- [Integration Guide](./integration-guide.md) — The normal app path and optional pieces.
- [Guarantees](./guarantees.md) — Confirmed writes, optimistic state, stale-write protection, and agent lifecycle.
- [Intent](./api.md#intent) — Broadcast proposed work before committing.
- [Advanced Commit API](./api.md#advanced-commit-api) — Apply custom batch mutations.
- [Connect Your Database](./data-sources.md) — Where data lands when your app database is canonical.
- [Receipt](./api.md#receipt) — Confirm what landed.
- [Capability](./api.md#capability) — Signed credentials for a bounded actor, operation set, sync group, and lease.
- [Task](./api.md#task) — One agent run; the audit envelope for commits and cost.
- [Usage](./api.md#usage) — Metering and audit dimensions.

## Examples

- [AI SDK Tool](./examples/ai-sdk-tool.md) — Put Ablo inside an AI SDK tool call.
- [Existing Python Backend](./examples/existing-python-backend.md) — Add multiplayer and future agent writes without replacing a Python API server.
- [Agent + Human](./examples/agent-human.md) — Yield when a human is editing the same task.
- [Server Agent](./examples/server-agent.md) — Schema-backed worker plus advanced schema-less run.
- [Next.js](./examples/nextjs.md) — App-router setup with React bindings.

## Runtime builds

- `@ablo/sync-engine` — schema-powered sync client for typed model operations, realtime, intents, and receipts.
- `Ablo({ apiKey })` — advanced resource client for runtimes that intentionally cannot import a schema.

## More

- [README](../README.md) — product overview and first example.
- [AGENTS.md](../AGENTS.md) — short installation guidance for coding assistants.
- [Changelog](../CHANGELOG.md) — what shipped recently.
