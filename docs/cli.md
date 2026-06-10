# CLI

The `ablo` CLI gets you from an empty project to live-syncing data: scaffold a
schema, authenticate, push the schema, and watch it sync. Your
`defineSchema(...)` is the single source of truth: whether you run the CLI
locally or push to the hosted server, the same engine turns it into the same
SQL — so what you test is what ships.

```bash
npx ablo init      # scaffold ablo/schema.ts + client
npx ablo login     # authorize in the browser
npx ablo dev       # push schema to the test sandbox + watch
```

**Two setup styles, and they pick your commands.** If your app database is the
source of truth, expose a [Data Source endpoint](./data-sources.md) and keep DB
credentials in your app. If you explicitly want Ablo to open a Postgres
connection, use the **Direct Postgres connector** commands: `ablo migrate`
applies changes to your own `DATABASE_URL`, and `ablo check` / `ablo pull`
adopt tables you already have. Hosted sandbox commands are tagged **Hosted**;
direct-connector commands are tagged **Direct Postgres**.

## Authenticate

`ablo login` runs the OAuth 2.0 device flow: it opens your browser, you choose
**log in** or **create an account** and approve, and the CLI provisions a
**test + live key pair** (90-day, restricted) and stores them locally. This
mirrors `stripe login`.

| Command                  | What it does                                                               |
| ------------------------ | -------------------------------------------------------------------------- |
| `ablo login`             | Authorize in the browser; provisions + stores a test and a live key.       |
| `ablo logout`            | Remove the stored keys.                                                    |
| `ablo status`            | Show the active org, mode, both keys (prefix + expiry), and server health. |
| `ablo mode [sandbox\|production]` | Switch the active environment. With no argument, prompts.                         |

Keys are stored in `~/.config/ablo/config.json` (mode `0600`). In **CI**, don't
log in — set `ABLO_API_KEY`, which always overrides the stored key.

## Test vs live

Like Stripe, every account has a **test** mode and a **live** mode, and a key
belongs to one of them. Test keys are bound to an isolated sandbox: their reads
and writes never touch production data. Switch with `ablo mode`; `ablo dev` is always
the sandbox by design.

The schema, however, is **shared** across the org — pushing a schema (from
either environment) defines the same models sandbox and production see; only the rows differ.

## Commands

| Command                            | What it does                                                                                                                                  | Flags                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `ablo init`                        | Scaffold `ablo/` (`schema.ts`, client, optional Data Source / agent / component), write `.env`, install the SDK. Offers to log in at the end. | —                                                                                                      |
| `ablo login` / `logout` / `status` | Authentication & status (above).                                                                                                              | —                                                                                                      |
| `ablo mode [sandbox\|production]`   | Switch active environment.                                                                                                                           | —                                                                                                      |
| `ablo dev`                         | **Hosted** — push the schema to your test sandbox, then watch `ablo/schema.ts` and re-push on save.                                           | `--no-watch`, `--schema <path>`, `--export <name>`, `--url <url>`                                      |
| `ablo logs`                        | Tail your scope's commit activity (`stripe logs tail`). Follows by default.                                                                   | `-n, --tail <N>`, `--since <dur\|ts>`, `--model`, `--op`, `--json`, `--no-follow`, `--mode sandbox\|production` |
| `ablo push`                        | **Hosted** — upload the schema to Ablo; the server diffs, migrates, and activates it.                                                         | `--force`, `--rename old:new`, `--backfill model.field=value`, `--schema`, `--export`, `--url`         |
| `ablo migrate`                     | **Direct Postgres** — provision just the synced models (plus the adapter's `ablo_outbox` / `ablo_idempotency`) in your own `DATABASE_URL`. Leaves your other tables alone.                                                          | `--dry-run`, `--output <file>`, `--schema`, `--export`                                                 |
| `ablo pull`                        | **Direct Postgres** — generate `defineSchema(...)` from your existing tables (read-only, like `prisma db pull`).                              | `--out <path>`, `--app-schema <name>`, `--import <pkg>`, `--force`                                     |
| `ablo check`                       | **Direct Postgres** — verify your _existing_ tables fit the schema (read-only, no schema changes).                                                       | `--schema <path>`, `--export <name>`, `--app-schema <name>`                                            |
| `ablo generate`                    | Emit TypeScript types from the schema.                                                                                                        | `--out <path>`, `--schema`, `--export`                                                                 |

## `ablo dev`

The development loop. It pushes `ablo/schema.ts` to your **test sandbox**,
prints the env line your app needs, then watches the file and re-pushes on every
save (300 ms debounce). It refuses live keys so a tight save loop can never
churn production data.

```bash
npx ablo dev             # push + watch
npx ablo dev --no-watch  # push once and exit
```

## `ablo logs`

Tail commit activity, like `stripe logs tail`. Scope comes from the key — a test
key streams only its sandbox's writes, a live key the org's — so you never pass
an org. Follows by default; `--no-follow` prints recent and exits.

```bash
npx ablo logs                      # last 50, then stream
npx ablo logs -n 100 --model task  # backfill 100, one model
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
  ✓ tasks     → tasks (id, organization_id ok)
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
Ablo manages the sandbox/hosted store, use `ablo push` and `ablo dev` — the
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
| `z.number()`                                                 | `DOUBLE PRECISION` — never `INTEGER`; a Zod number may be fractional, and truncating is silent data loss |
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
  failedStatement: 'ALTER TABLE "public"."tasks" RENAME COLUMN a TO b;',
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
| `ABLO_API_KEY`                        | Authenticate without `ablo login` (CI). Always overrides the stored key. | —                          |
| `ABLO_API_URL`                        | Control-plane / API host (`push`, `dev`, `status`).                      | `https://api.abloatai.com` |
| `ABLO_AUTH_URL`                       | Dashboard origin for `ablo login`'s device flow.                         | `https://abloatai.com`     |
| `ABLO_CONFIG_DIR` / `XDG_CONFIG_HOME` | Where the credential file lives.                                         | `~/.config/ablo`           |
