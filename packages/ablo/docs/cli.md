# CLI

> Scaffold a schema, connect a database, push it, and watch it sync.

The `ablo` CLI gets you from an empty project to live-syncing data: scaffold a
schema, authenticate, push the schema, and watch it sync. Your
`defineSchema(...)` is the single source of truth: whether you run the CLI
locally or push to the hosted server, the same engine turns it into the same
SQL — so what you test is what ships.

```bash
npx ablo init      # scaffold ablo/schema.ts + client
npx ablo login     # authorize in the browser
npx ablo dev       # prepare an isolated Git branch + push/watch
```

**Two setup styles, and they pick your commands.** If your app database is the
source of truth, expose a [Data Source endpoint](./data-sources.md) and keep DB
credentials in your app. If you explicitly want Ablo to open a Postgres
connection, use the **Direct Postgres connector** commands: `ablo migrate`
applies changes to your own `DATABASE_URL`, and `ablo check` / `ablo pull`
adopt tables you already have. Hosted branch commands are tagged **Hosted**;
direct-connector commands are tagged **Direct Postgres**.

## Authenticate

`ablo login` runs the OAuth 2.0 device flow: it opens your browser, you choose
**log in** or **create an account** and approve, and the CLI provisions a
90-day, project-scoped `mk_` management credential. It has no test/live mode
and cannot read or write application data. `ablo dev` uses it to create or
resume a branch and exchanges it for a temporary branch-bound runtime key.

| Command                  | What it does                                                               |
| ------------------------ | -------------------------------------------------------------------------- |
| `ablo login`             | Authorize in the browser, pick a project; store its management credential.  |
| `ablo login --project <slug>` | Same without the picker: scoped to the named project, which becomes active. |
| `ablo logout`            | Remove the stored credentials.                                             |
| `ablo whoami`            | Strictly confirm which project and branch a credential acts on.            |
| `ablo status`            | Show the active org/project, resolved runtime credential, branch target, and server health. |

Credential precedence is deliberately small:

1. `ABLO_API_KEY` in the process environment.
2. An explicitly selected file, for commands that support
   `--env-file <path>`.
3. A stored credential for legacy compatibility.

Read-only orientation commands (`status`, `whoami`, `logs`, and `connect
locate/check`) may inspect the application's `.env.local` so they describe what
the app would use. Mutations (`push`, `connect apply/rotate/register`, and
`connect deregister`) never let an ambient file silently choose a branch. Pass
`--env-file .env.local` when that file is the intended source; the command
reports the server-confirmed branch before it writes. For one-time recovery,
`connect deregister --key-env <NAME>` selects that exact named value without
putting the secret in argv.

Keys live in `~/.config/ablo/credentials.json` (mode `0600`), keyed by project.
The non-secret `config.json` holds the active project. There is one explicit
credential input: `ABLO_API_KEY`. In headless CI it may temporarily contain an
`mk_` credential during branch bootstrap; the runtime receives the resulting
branch-bound `sk_` or restricted `rk_` value through the same variable.

## Development branches and the production root

A branch is your project at full strength over its own rows: the same models,
the same schema artifacts, the same claims and the same rules production runs.

Production is the project root. `ablo dev` creates or reuses a child branch for
your Git branch, then mints a temporary `sk_` key bound to that child.
Reads, writes, schema artifacts, claims, and credentials stay isolated from
production and from other development branches, which is what makes a
schema-changing pull request as routine as a code-only one.

There is no local mode switch. Development selection comes from Git or
`--branch`; production authority comes only from an explicit root-bound
credential.
Production schema changes use the reviewed one-shot path in
[Deployment](./deployment.md).

`ABLO_API_KEY` is the one runtime variable in every environment. Branches
replace manually switching between custom names such as `ABLO_STAGING_KEY` and
`ABLO_DEV_KEY`: rerun `ablo dev` when Git branches change. Use `ablo whoami`
for the narrow identity question, or `ablo whoami --key-env <NAME>` to inspect
an explicitly named CI/legacy key without exposing its value in argv.

## Projects

An org can have multiple **projects**, each with its own isolated keys, schema,
and data. Keys are scoped to a project **at mint** and never re-scoped, so the
CLI keeps a separate credential profile per project. The active project (set
with `projects use`) selects which profile every command authenticates with.

| Command                       | What it does                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| `ablo projects list`          | List the org's projects (marks the active one and the org-default).                |
| `ablo projects create <slug>` | Create a project (`--name "Display Name"`). Its keys/schema/data are isolated.     |
| `ablo projects use <slug>`    | Switch the active project. `ablo projects use default` returns to the org-default. |
| `ablo login`                  | Pick a project in the terminal; store its management access and make it active.    |
| `ablo login --project <slug>` | The same for a named project, with no picker.                                      |

Because keys are fixed to a project, `projects use` only changes which profile
is active — it never re-scopes an existing key. Switch to a project you haven't
logged into yet and the CLI tells you to mint one:

```bash
npx ablo projects use war-room
#   ✓ now targeting project war-room (prj_…)
#   No key stored for this project yet — run `ablo login --project war-room` to mint one.

npx ablo login --project war-room   # stores its management credential, keeps it active
```

A plain `npx ablo login` reaches the same place through a picker: once the
browser has approved, the terminal lists the organization's projects, with the
cursor on the active one, and the choice becomes the credential's project. An
organization holding only its default project is not asked.

If you run a project-scoped command (`push`, `dev`) while the active project has
no key — but other projects do — the CLI **refuses** rather than silently
deploying with the wrong project's credential, and names the fix
(`ablo login --project <slug>`). In CI, an explicit `mk_` in `ABLO_API_KEY`
bypasses profiles for project/branch administration. Replace it with the
branch-bound runtime credential before starting application code.

## Commands

| Command                            | What it does                                                                                                                                  | Flags                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `ablo init`                        | Scaffold `ablo/` (`schema.ts`, client, optional Data Source / agent / component), write `.env`, install the SDK. Offers to log in at the end. |: |
| `ablo login` / `logout` / `whoami` / `status` | Authentication, exact credential identity, and readiness (above).                                                                              | `whoami --key-env <NAME>`, `whoami --json`, `status --json` |
| `ablo projects list\|create\|use\|rename` | Manage projects and the active one (see [Projects](#projects)). Each project's keys/schema/data are isolated.                          | `--name "<display>"` (create/rename)                                                                    |
| `ablo dev`                         | Ensure an isolated Git branch, wire its temporary key, push, then watch `ablo/schema.ts`. `--local` also serves local Postgres over an outbound signed connector. | `--branch <slug>`, `--branch-ttl-hours <1-168>`, `--local`, `--source <path>`, `--no-watch`, `--schema`, `--export`, `--url` |
| `ablo branch list\|status\|check\|create\|ensure\|credential\|delete` | Manage and diagnose immutable branch planes and expiring credentials.                          | Run `ablo branch --help`; use `--json` for automation.                                                   |
| `ablo logs`                        | Tail the resolved runtime credential's branch activity. Follows by default.                                                                          | `-n, --tail <N>`, `--since <dur\|ts>`, `--model`, `--op`, `--json`, `--no-follow` |
| `ablo push`                        | **Hosted**: upload the schema to Ablo; the server diffs, migrates, and activates it.                                                         | `--force`, `--rename old:new`, `--backfill model.field=value`, `--schema`, `--export`, `--url`         |
| `ablo migrate`                     | **Direct Postgres**: provision just the synced models (plus the adapter's `ablo_outbox` / `ablo_idempotency`) in your own `DATABASE_URL`. Leaves your other tables alone.                                                          | `--dry-run`, `--output <file>`, `--schema`, `--export`                                                 |
| `ablo pull`                        | **Direct Postgres**: generate `defineSchema(...)` from your existing tables (read-only, like `prisma db pull`).                              | `--out <path>`, `--app-schema <name>`, `--import <pkg>`, `--force`                                     |
| `ablo check`                       | **Direct Postgres**: verify your _existing_ tables fit the schema (read-only, no schema changes).                                                       | `--schema <path>`, `--export <name>`, `--app-schema <name>`                                            |
| `ablo connect plan\|apply\|check\|rotate\|deregister` | **Direct Postgres**: register and maintain a database plane. Here `--schema` means the existing PostgreSQL namespace, never a TypeScript file. | `--url <postgres-url>`, `--schema <postgres-schema>`, `--env-file <path>`, `--yes` |
| `ablo generate`                    | Emit TypeScript types from the schema.                                                                                                        | `--out <path>`, `--schema`, `--export`                                                                 |
| `ablo docs`                        | Read these pages for the version you installed: offline, no network (see [`ablo docs`](#ablo-docs)).                                          | `--json`                                                                                               |

## `ablo docs`

The documentation for the version in your `node_modules`, not the version on the
website.

```bash
npx ablo docs                  # every page, with what it covers
npx ablo docs coordination     # one page, as markdown
npx ablo docs --json           # the page list, machine-readable
```

These pages ship inside the npm package, so they describe the code beside them
and stay reachable with no network — isolated agent environments and CI runners
often have none. That matters most when a project is pinned: `claim` took a
callback before it returned a disposable handle, and a website always describes
the newest release, so an agent on an earlier version reads the new shape and
writes a call its own package doesn't have.

Pass a slug (`coordination`), a path (`docs/coordination.md`), or a file name
(`AGENTS.md`). A miss names the closest page. The same pages are served over
HTTP at `/api/docs/<slug>` and through the docs MCP server.

## `ablo dev`

The branch-first development loop. It discovers your Git/CI branch, ensures the
matching Ablo child branch, exchanges the stored `mk_` project credential for an
expiring branch-only key, writes that key to gitignored `.env.local`, pushes
`ablo/schema.ts`, and re-pushes on every save.

```bash
npx ablo dev                              # discover from Git, push + watch
npx ablo dev --branch preview-pr-482      # explicit branch
npx ablo dev --no-watch                   # prepare, push once, exit
npx ablo dev --branch-ttl-hours 24        # change temporary-key lifetime
npx ablo dev --local                      # keep Postgres private on localhost
```

`--local` loads `ablo/data-source.ts` (override with `--source <path>`), registers
the branch as connector-only, and opens an outbound authenticated WebSocket to
Ablo. Commit, load, list, and outbox-event requests run through the same signed
Data Source handler as production; no database credential leaves your process
and no public tunnel is opened. Because the connector is long-lived, `--local`
cannot be combined with `--no-watch`.

It does not start your app, run migrations, create a database-provider branch,
or copy production rows. Read [Branch-first development](./branch-development.md)
for the exact discovery order, CI flow, database boundary, and troubleshooting.

## `ablo logs`

Tail commit activity. Scope comes from the persisted key binding: a child-bound
key streams only that child, while a root-bound key
streams production. You never pass a project or branch. Follows by default;
`--no-follow` prints recent and exits.

```bash
npx ablo logs                      # last 50, then stream
npx ablo logs -n 100 --model record  # backfill 100, one model
npx ablo logs --since 15m --json   # last 15m as NDJSON, then stream
```

Each line is `time · op · model · id · actor`. `--json` emits one event per line
(NDJSON) for piping to `jq` or an agent.

## `ablo pull`

Generate `defineSchema(...)` from the tables you already have — the inverse of
provisioning, and read-only (like `prisma db pull`). It introspects
`DATABASE_URL`, emits a model per adoptable table (one that has `id` +
`organization_id`), maps Postgres types back to Zod, and writes `ablo/schema.ts`.

```bash
DATABASE_URL=postgres://… npx ablo pull
```

It never touches the database, and won't overwrite an existing schema without
`--force`. Introspection is lossy — enum members, JSON shape, relations, and
defaults can't be recovered from columns — so treat the output as a starting
point: review it, then run `ablo check`.

## `ablo check`

`ablo check` is how you adopt a database you already own. Instead of creating or
altering tables, it inspects your existing ones and tells you which fit the
schema: it introspects `DATABASE_URL`, compares each table to your
`defineSchema(...)`, and reports — per model — whether the table is adoptable.
It never writes or alters anything.

A table is adoptable when it has a primary key `id` and (for org-scoped models)
an `organization_id` column — the tenancy marker the engine isolates on. Every
other table in your database is ignored.

**Why `organization_id`?** It's the one column that makes a table safe to
multiplayer-sync. Row-level security scopes every read and write by it (org A
can't see org B's rows), and the engine routes realtime deltas by `org:<id>`. A
table without a tenancy key has no isolation boundary, so Ablo excludes it
**by default** rather than risk exposing it across tenants. If your tenancy
column has a different name, keep that table behind a
[Data Source endpoint](/data-sources) for now.

```bash
DATABASE_URL=postgres://… npx ablo check
```

```text
  ✓ records     → records (id, organization_id ok)
  ✗ projects  → projects
      • missing "organization_id" — add it, or move this model behind a Data Source
  2 models · 1 ok · 1 error
  12 other tables in your database — ignored by Ablo
```

If a table can't carry `organization_id` (or has business logic Ablo shouldn't
bypass), keep it behind a [Data Source endpoint](/data-sources) rather than
reshaping it. `ablo check` is read-only; it never proposes a migration.

## `migrate` (Direct Postgres) vs `push` (Hosted)

Same engine, two setups. If you use the **Direct Postgres connector**, use
`ablo migrate` — it provisions the synced models in your own `DATABASE_URL`. If
Ablo manages the hosted store, use `ablo push` and `ablo dev` — the
server applies the change and version-gates connecting clients.

```bash
ablo migrate --dry-run            # preview the exact SQL
ablo migrate                      # apply to DATABASE_URL
ablo migrate --output schema.sql  # write SQL to a file
```

### One database, two schemas

`ablo migrate` does **not** own your whole database. It creates exactly the
models in your `defineSchema(...)` — the synced, collaborative tables — plus the
adapter's bookkeeping tables (`ablo_outbox`, `ablo_idempotency`). Nothing else.

Your auth, billing, and any other non-synced tables stay in **your own ORM
schema** (Drizzle's `schema.ts`, Prisma's `schema.prisma`) and are provisioned by
**your own migrations** (`drizzle-kit push` / `prisma migrate`). The Ablo schema
is not a replacement for `schema.prisma`, and `ablo migrate` won't touch, drop,
or adopt the tables it doesn't manage. One database, two schemas, side by side —
each owned by its own migration tool.

## Zod → Postgres type mapping

The one type map, shared by both paths (there is no second mapping):

| Zod                                                          | Postgres                                                                                                 |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `z.string()`                                                 | `TEXT`                                                                                                   |
| `z.number()`                                                 | `DOUBLE PRECISION`: never `INTEGER`; a Zod number may be fractional, and truncating is silent data loss |
| `z.boolean()`                                                | `BOOLEAN`                                                                                                |
| `z.date()`                                                   | `TIMESTAMPTZ`                                                                                            |
| `z.enum([...])`                                              | `TEXT` + a `CHECK (col IN (...))` constraint                                                             |
| `z.object` / `z.array` / `z.record` / `z.union` / `z.custom` | `JSONB`                                                                                                  |
| `.optional()` / `.nullable()`                                | nullable column                                                                                          |

Each table also gets the platform columns (`id`, `organization_id`,
`created_by`, `created_at`, `updated_at`), an `organization_id` index, and
row-level security so each org only sees its own rows — the engine sets this per
request (via `current_setting('app.current_org_id')`); you don't manage it.

`.default(...)` is **not** emitted as a SQL column default — Zod applies the
default at write time (`create`), in one place, so a DB default and a schema
default can't drift.

## Structured errors

A failed migration aborts the whole transaction (nothing partial lands) and
reports the same `migration_failed` shape on both paths — naming the statement
that broke and the Postgres SQLSTATE, not just "migration failed".

`ablo migrate` (local) logs it:

```txt
[migrate] migration plan failed {
  code: 'migration_failed',
  failedStatement: 'ALTER TABLE "public"."records" RENAME COLUMN a TO b;',
  failedStatementIndex: 4,
  pgCode: '42P01',
  durationMs: 133
}
```

`ablo push` (hosted) returns the canonical error envelope (HTTP 500),
which the SDK reconstructs as a typed `AbloServerError`:

```json
{
  "type": "AbloServerError",
  "code": "migration_failed",
  "message": "schema migration failed: relation \"...\" does not exist",
  "doc_url": "https://docs.abloatai.com/errors#migration_failed",
  "failedStatement": "ALTER TABLE ... RENAME COLUMN a TO b;",
  "pgCode": "42P01"
}
```

The pushed artifact is recorded `failed` and is never activated, so a broken
migration can't leave clients gated against tables that don't match.

## Environment

| Variable                              | Purpose                                                                  | Default                    |
| ------------------------------------- | ------------------------------------------------------------------------ | -------------------------- |
| `ABLO_API_KEY`                        | Authenticate without `ablo login` (CI). Always overrides the stored key. |: |
| `ABLO_API_URL`                        | Control-plane / API host (`push`, `dev`, `status`).                      | `https://api.abloatai.com` |
| `ABLO_AUTH_URL`                       | Dashboard origin for `ablo login`'s device flow.                         | `https://www.abloatai.com` |
| `ABLO_CONFIG_DIR` / `XDG_CONFIG_HOME` | Where the credential file lives.                                         | `~/.config/ablo`           |
