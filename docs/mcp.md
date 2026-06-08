# Model Context Protocol

Ablo publishes **two** MCP servers for two different jobs. Don't confuse them:

| Server | Purpose | Auth | Tools |
|---|---|---|---|
| **Coordination** (`@ablo/mcp`) | Let an agent safely read & mutate your application data | API key (`sk_…` / `rk_…`) | per-model `get` / `list` / `create` / `update` / `delete` / `claim` / `release` |
| **Integration-helper** (hosted `/api/mcp`) | Help an AI coding assistant write SDK integration code that compiles | none (public docs) | doc search, export surface, schema lint, scaffold |

The coordination server **is the data plane** — it is how an agent changes
state. The integration-helper server only serves docs, schema lint, and
scaffolds; it does **not** read or write application data (there are no
per-model data tools on it). Pick by what you're doing: shipping an agent that
edits rows → coordination; teaching your IDE assistant the SDK → helper.

## Coordination server (`@ablo/mcp`)

The coordination server is the MCP projection of the model-scoped API
(`/v1/models/...`) — the same surface as `ablo.<model>.create/update/claim` and
the REST routes, rendered as tools. An agent connects with your API key and
gets one safe loop: **claim → read → commit → release.**

Install over stdio; set your key in the host's MCP env:

```bash
claude mcp add ablo -- npx -y @ablo/mcp
# env:  ABLO_API_KEY=sk_…   (ABLO_API_URL optional; defaults to the hosted API)
```

Each tool mirrors an SDK verb, scoped to a model + id:

| Tool | Mirrors | Does |
|---|---|---|
| `get_model` | `ablo.<model>.get(id)` | read latest state + active claims |
| `list_models` | `ablo.<model>.list({…})` | cursor-paginated list with filters |
| `create_model` | `ablo.<model>.create({ data })` | guarded create |
| `update_model` | `ablo.<model>.update({ id, … })` | guarded update |
| `delete_model` | `ablo.<model>.delete({ id })` | guarded delete |
| `claim_model` | `ablo.<model>.claim({ id })` | acquire / queue a coordination lease |
| `release_claim` | — | release the lease so others proceed |

The agent-facing contract — the safe loop, the "derive idempotency keys from
the business event" rule, and the error-code playbook — ships as a loadable
skill at `@ablo/mcp/skill.md`. Lives in `packages/mcp/`
(`createCoordinationMcpServer`, `src/tools.ts`).

## Integration-helper server

If you're integrating `@abloatai/ablo` with the help of an AI coding
assistant (Claude Code, Cursor, Windsurf, Codex), you don't want it guessing
at the API. This hosted server lets the assistant search the real docs,
inspect the actual export surface, lint your schema, and scaffold a starter —
so the code it writes uses APIs that exist. It serves docs only and returns
nothing org-specific; data access happens through the SDK or the coordination
server above, never here.

> The `@abloatai/ablo` npm package itself bundles neither server — it has
> no `@modelcontextprotocol/sdk` dependency. The helper is a feature of Ablo's
> hosted app, mounted at `/api/mcp`; the coordination server is the separate
> `@ablo/mcp` package.

### Install

Point your assistant at the hosted endpoint — no auth, no token:

```bash
claude mcp add --transport http ablo https://<your-app>/api/mcp
```

Per-client walkthroughs:

- [Claude Code](/docs/mcp/claude-code)
- [Cursor](/docs/mcp/cursor)
- [Windsurf](/docs/mcp/windsurf)

### What it exposes

#### Tools

| Tool | What it does |
|---|---|
| `search_ablo_docs` | Keyword search across the docs corpus. Returns ranked matches with excerpts. Follow up with `get_recipe` on the top hit. |
| `get_recipe` | Returns the full markdown of one doc by name (e.g. `readme`, `quickstart`, `schema-contract`, `integration-guide`, `api`, `guarantees`). |
| `get_api_surface` | Returns the structured export list for an SDK subpath (`@abloatai/ablo`, `./react`, `./schema`, `./testing`, …). Call with no argument to list every subpath. |
| `validate_schema` | Lints `defineSchema` source against the DSL rules (camelCase fields, lowercase model keys, `scope`/`grants` sync groups, valid `load` strategies, no legacy builders) and returns a structured issue list. Runs no code. |
| `scaffold_app` | Emits a starter file tree for a schema-first integration — `next`, `node-agent`, or `plain`, with `managed` or `data-source` storage. |

#### Resources

Every doc file is addressable at `ablo://docs/{name}`, so a
client can list the corpus and fetch individual files on demand instead of
loading everything into context.

#### Prompts

Reusable, parameterised templates that drive an end-to-end flow:

- `integrate-sync-engine` — wire the SDK into an existing project.
- `add-agent` — add an agent worker that coordinates via intents and
  conflict-safe writes.
- `define-schema` — design a Zod-first schema from a description, then run
  `validate_schema` before committing.

### Transport and limits

The endpoint uses the stateless Streamable HTTP transport (`POST /api/mcp`;
`GET` returns 405 — SSE is not supported in stateless mode). A fresh
server is built per request, which suits serverless and horizontally-scaled
deployments.

There is **no authentication**: the server only serves docs, schema lint,
and scaffolds, so there's nothing org-scoped to protect. Abuse is bounded
by IP-based rate limiting — 120 requests per minute per IP. Rate-limit
headers are echoed on every response.

### Where it lives

- Route handler: `apps/sync-web/src/app/api/mcp/route.ts`
- Server setup: `apps/sync-web/src/lib/mcp-ablo/server.ts`
  (`createSyncEngineMcpServer`)
- Tools: `apps/sync-web/src/lib/mcp-ablo/tools/`
