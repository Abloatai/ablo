# Model Context Protocol

> Two MCP servers for two different jobs — one of them is a data plane, one is not.

Ablo publishes **two** MCP servers for two different jobs. Don't confuse them:

| Server | Purpose | Auth | Tools |
|---|---|---|---|
| **Coordination** (`@abloatai/mcp`) | Manage your Ablo the way the CLI does, and let an agent safely read & mutate application data | API key (`sk_…` / `rk_…`) | projects, schema, logs, usage: plus `get` / `list` / `create` / `update` / `delete` / `claim` / `release` over your rows |
| **Integration-helper** (hosted `/api/mcp`) | Help an AI coding assistant write SDK integration code that compiles | none (public docs) | doc search, export surface, schema lint, scaffold |

The coordination server manages your account **and is the data plane** — it is
how an agent changes state. The integration-helper server only serves docs,
schema lint, and scaffolds; it does **not** read or write application data (there are no
per-model data tools on it). Pick by what you're doing: shipping an agent that
edits rows → coordination; teaching your IDE assistant the SDK → helper.

## Coordination server (`@abloatai/mcp`)

The coordination server does two jobs: it manages your Ablo the way the `ablo`
CLI does, and it renders the model-scoped API (`/api/v1/models/...`) as tools —
the same surface as `ablo.<model>.create/update/claim`. An agent connects with
your API key and gets one safe loop: **claim → read → commit → release.**

Install over stdio; set your key in the host's MCP env:

```bash
claude mcp add ablo -- npx -y @abloatai/mcp
# env:  ABLO_API_KEY=sk_…   (ABLO_API_URL optional; defaults to the hosted API)
```

### Managing your Ablo

| Tool | Mirrors | Does |
|---|---|---|
| `get_schema` | `ablo status` | the models this key can address, and its environment + project |
| `list_projects` | `ablo projects list` | the org's projects (needs `sk_`) |
| `create_project` | `ablo projects create` | create one (needs `sk_`) |
| `tail_logs` | `ablo logs` | recent commits and the actor behind each |
| `get_usage` |: | usage in daily buckets |

There are no key-management tools. A mint returns the plaintext once — only a
hash is kept — so no tool can hand it back later, and returning it at mint time
would write a live secret into the agent's context and the conversation
transcript, where it outlives any revocation. Listing and revoking will arrive
once a grant identifies the caller as a person rather than a key. Manage keys
with `ablo login` or the dashboard.

`ablo init`, `push`, `pull`, and `generate` have no tools: they read and write
files in your repo, which the server cannot see. Run those in a shell — then
call `get_schema` to see the result.

### Reading and changing rows

Each tool mirrors an SDK verb, scoped to a model + id. Model names come from
`get_schema`:

| Tool | Mirrors | Does |
|---|---|---|
| `get_model` | `ablo.<model>.local.retrieve(id)` | read latest state + active claims |
| `list_records` | `ablo.<model>.list({…})` | cursor-paginated list with filters |
| `create_model` | `ablo.<model>.create({ data })` | guarded create |
| `update_model` | `ablo.<model>.update({ id, … })` | guarded update |
| `delete_model` | `ablo.<model>.delete({ id })` | guarded delete |
| `claim_model` | `ablo.<model>.claim({ id })` | acquire / queue a coordination lease |
| `release_claim` |: | release the lease so others proceed |

The agent-facing contract — the safe loop, the "derive idempotency keys from
the business event" rule, and the error-code playbook — ships as a loadable
skill at `@abloatai/mcp/skill.md`.

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
> `@abloatai/mcp` package.

### Install

Point your assistant at the hosted endpoint — no auth, no token:

```bash
claude mcp add --transport http ablo https://<your-app>/api/mcp
```

The endpoint is identical for every client — only the config surface differs:

- **Claude Code:** run the `claude mcp add` command above; verify with `/mcp list`, remove with `claude mcp remove ablo`.
- **Cursor:** add the server to `~/.cursor/mcp.json` (macOS / Linux), then restart.
- **Windsurf:** add the same JSON via Settings → Cascade → MCP, then restart.

Cursor and Windsurf use the same config shape:

```json
{
  "mcpServers": {
    "ablo": { "transport": "http", "url": "https://<your-app>/api/mcp" }
  }
}
```

Each client then lists the Ablo tools (`search_ablo_docs`, `get_recipe`, `get_api_surface`, `validate_schema`, `scaffold_app`) in its MCP panel.

### What it exposes

#### Tools

| Tool | What it does |
|---|---|
| `search_ablo_docs` | Keyword search across the docs corpus. Returns ranked matches with excerpts. Follow up with `get_recipe` on the top hit. |
| `get_recipe` | Returns the full markdown of one doc by name (e.g. `readme`, `quickstart`, `schema-contract`, `integration-guide`, `api`, `guarantees`). |
| `get_api_surface` | Returns the structured export list for an SDK subpath (`@abloatai/ablo`, `./react`, `./schema`, `./testing`, …). Call with no argument to list every subpath. |
| `validate_schema` | Lints `defineSchema` source against the DSL rules (camelCase fields, lowercase model keys, `scope`/`grants` sync groups, valid `load` strategies, no legacy builders) and returns a structured issue list. Runs no code. |
| `scaffold_app` | Emits a starter file tree for a schema-first integration: `next`, `node-agent`, or `plain`, with a `data-source` (your own database) endpoint. |

#### Resources

Every doc file is addressable at `ablo://docs/{name}`, so a
client can list the corpus and fetch individual files on demand instead of
loading everything into context.

#### Prompts

Reusable, parameterised templates that drive an end-to-end flow:

- `integrate-sync-engine` — wire the SDK into an existing project.
- `add-agent` — add an agent worker that coordinates via claims and
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
