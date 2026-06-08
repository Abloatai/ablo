# Ablo Docs

You have a database, and you want an AI agent to edit the same rows your
users are editing — without the two clobbering each other's work. Ablo gives
the agent a narrow, audited write path: you declare your models, then everyone
(React components, server actions, and agents) calls the same
`ablo.deck.update(...)`. Ablo streams confirmed changes to everyone live and
rejects any write based on stale data.

The flow is four steps: declare your models, read the current rows, claim the
row you're about to change, then write — and the write is rejected if someone
changed the row first.

```ts
// The same call, whether a person, a server action, or an agent makes it.
await ablo.deck.update({ id: deckId, data: { title: "Q3 Strategy" } });
```

Claims don't lock. If another writer holds the row, `claim` waits for them,
re-reads the fresh row, then hands it to you — so two writers serialize
instead of clobbering.

## What you get

Three things stay true no matter how you use Ablo:

- **One model API for every actor.** `ablo.<model>.update(...)` is the
  call from React components, server actions, background workers, and
  AI agents alike. No separate "agent SDK," no parallel mutation path.
  Attribution comes from the credential, not the call site.
- **You declare tenancy scopes once.** Tenancy / per-entity scope
  prefixes (`org:`, `deck:`, or your own `region:` / `customer:`) are
  declared once on the schema's `identityRoles`, so application code
  never builds an `org:123` string by hand — which keeps tenant
  boundaries from leaking.
- **Stale writes are rejected.** If the row changed after you read it,
  your write is turned away instead of silently overwriting the change
  you didn't see.

## Start here

- [Quickstart](./quickstart.md) — Make your first schema-backed write.
- [Schema Contract](./schema-contract.md) — One schema becomes typed model clients, React reads, agent writes, Data Source shape, and schema push.
- [CLI & Migrations](./cli.md) — `init` / `migrate` / `push` / `generate`, the shared Zod→Postgres type map, and structured migration errors.
- [Identity & Sync Groups](./identity.md) — Bring your own auth; tell Ablo who's connecting and how org / team / user map to sync-group scope.
- [Integration Guide](./integration-guide.md) — Choose Ablo-managed state, Data Source, React, multiplayer, and agent patterns.
- [Guarantees](./guarantees.md) — What confirmed writes, stale checks, and claims guarantee.
- [Interaction Model](./interaction-model.md) — The schema, claim, update, confirmation loop.
- [API Reference](./api.md) — Model-by-model method shape.
- [Client Behavior](./client-behavior.md) — Options, errors, retries, timeouts, and imports.
- [Connect Your Database](./data-sources.md) — Keep canonical rows in your app database without giving Ablo database credentials.
- [React](./react.md) — Provider, hooks, and reactive reads for React apps.
- [API Keys](./api-keys.md) — Bearer tokens for the public API.

## API shape

| Plane | Primitives | Purpose |
|---|---|---|
| State | `Schema`, `Model`, `Claim`, `Receipt` | The product path. Load, coordinate, write, confirm. |
| Storage | `Managed State`, `Data Source` | Ablo stores declared models by default; existing app tables use a signed Data Source. |

## Use cases

- **Let agents write to shared state** — Give an AI agent scoped, revocable write access to your typed data.
- **Coordinate multiple actors** — Use claims to show pre-write work across humans and agents.
- **Audit every agent action** — Trace any write back to a human in one query.
- **Build collaborative editors** — Humans and agents on the same record, with realtime updates and stale-read protection.
- **Meter and gate API usage** — Per-key, per-team usage reports and quota enforcement.
- **Integrate with A2A and MCP** — Speak the same protocols as Claude, Cursor, Gemini.

## Concepts

- [Schema Contract](./schema-contract.md) — What the schema drives across SDK, React, agents, Data Source, and migrations.
- [Model Methods](./api.md#model-methods) — Load and write typed state.
- [Integration Guide](./integration-guide.md) — The normal app path and optional pieces.
- [Guarantees](./guarantees.md) — Confirmed writes, optimistic state, stale-write protection, and agent lifecycle.
- [Coordination](./coordination.md) — `claim`, `claim.state`, and `claim.queue` for active work.
- [Connect Your Database](./data-sources.md) — Where data lands when your app database is canonical.
- [Receipt](./api.md#receipt) — Confirm what landed.
- [Usage](./api.md#usage) — Metering and audit dimensions.
- [Audit Log](./audit.md) — Trace any confirmed write back to the human behind it.
- [MCP](./mcp.md) — Expose Ablo models to MCP clients (Claude, Cursor).

## Examples

- [AI SDK Tool](./examples/ai-sdk-tool.md) — Put Ablo inside an AI SDK tool call.
- [Existing Python Backend](./examples/existing-python-backend.md) — Add multiplayer and future agent writes without replacing a Python API server.
- [Agent + Human](./examples/agent-human.md) — Yield when a human is editing the same report.
- [Agent Scoped to One Deck](./examples/scoped-agent.md) — Scope an agent to one entity with `scope` / `parent`; realtime for just that deck.
- [Server Agent](./examples/server-agent.md) — Schema-backed worker.
- [Next.js](./examples/nextjs.md) — App-router setup with React bindings.

## Runtime builds

- `@abloatai/ablo` — schema-powered sync client for typed model operations, realtime claims, and receipts.

## More

- [README](../README.md) — product overview and first example.
- [AGENTS.md](../AGENTS.md) — short installation guidance for coding assistants.
- [Changelog](../CHANGELOG.md) — what shipped recently.
- [Roadmap](./roadmap.md) — what's planned next.
