# AGENTS.md

Ablo lets AI agents and humans safely edit the same typed data without clobbering each other. When two of them touch the same row, a "claim" makes one wait for the other instead of overwriting it. This file shows a coding assistant the one safe pattern: read a row, claim it, then write.

Claims don't lock. If another writer holds the row, `claim` waits for them and re-reads the fresh row before handing it to you — so two writers serialize instead of clobbering.

## Start here — scaffold with `ablo init`

Don't hand-write the integration. Run the CLI; it generates the current-API schema, client, the database connection (logical replication by default, or a signed Data Source endpoint as the fallback), and (for Next.js) the browser provider + session route:

- **Read the docs for THIS version:** `npx ablo docs` lists every page, `npx ablo docs <page>` prints one. They ship inside the installed package, so they describe the code in `node_modules` and work with no network. Read them instead of a docs URL — a website describes the newest release, so against a pinned version it will hand you a call your package doesn't have (`retrieve`/`list` replaced `get`/`getAll`/`getCount` in 0.35.0).
- **Scaffold:** `npx ablo init --yes` — flag-driven, never prompts. Override defaults with `--framework <nextjs|vite|remix|vanilla>`, `--auth <apikey|…>`, `--no-agent`, `--no-pull`, `--no-install`, `--no-login`. (Plain `ablo init` needs a TTY and will **HANG** in an agent/CI run — always pass `--yes`.)
- **Auth:** set `ABLO_API_KEY` in the environment. Do **NOT** run `ablo login` — it opens a browser device flow and blocks an agent.
- **Connect your database — logical replication (the primary path):** `npx ablo connect` prints the setup SQL (`wal_level=logical`, a publication, a `REPLICATION` role); `npx ablo connect register` registers the source with Ablo in one step. Ablo **consumes your Postgres' logical-replication stream** — it never runs DDL on, writes to, owns, or migrates your database, and your application keeps the write path. Registration **is** the enable; there is no tier or flag to pick. (Ablo hosts only the transaction log + coordination, never your rows.)
- **Fallback — signed Data Source endpoint** (DB can't grant a `REPLICATION` role): the generated `ablo/data-source.ts` exposes one route; Ablo sends signed requests and your app touches its own DB. **Only in this mode** does `npx ablo migrate` provision the adapter's bookkeeping tables (`ablo_outbox`, `ablo_idempotency`) plus your Ablo models — it does **not** touch your other tables. Keep your own migrations (drizzle-kit / prisma migrate) for auth and anything outside the Ablo schema.
- **No database yet?** Run `npx ablo dev --no-watch --branch <name>` to create an isolated non-root branch and obtain its expiring `sk_test_` credential. The branch uses a throwaway hosted data plane; Production remains the protected root. There is no shared Sandbox mode.
- **Adopt an existing DB schema:** `npx ablo pull prisma [path]` / `pull drizzle <module>` (lossless) or `pull` (live DB, lossy). Writes `ablo/schema.ts`.
- **Prepare a branch and push your schema — REQUIRED before any write works.** The server keeps its OWN copy of the schema. After you create or edit `ablo/schema.ts`, run `npx ablo dev --no-watch --branch <git-or-ci-ref>`: it ensures an isolated branch, mints a temporary branch credential, writes it to gitignored `.env.local`, pushes once, and exits. **Skip this and every write to a new or changed model fails with `server_execute_unknown_model`.** Plain `ablo dev` watches forever — never run it bare in an agent. `ablo push` is the lower-level one-shot command for an already selected key, including reviewed production deploys.
- **Other long-running:** `npx ablo logs --no-follow` (default tails forever). `status`, `branch check`, `push`, `pull`, `check`, `generate`, `docs`, and `dev --no-watch` are one-shot.

When you use the signed-endpoint fallback, the generated `ablo/data-source.ts` is the whole endpoint and needs no hand-editing: `dataSourceNext({ schema, apiKey, adapter: prismaDataSource(prisma, schema) })` (or `drizzleDataSource(db, schema)`). The adapter owns commit / idempotency / outbox.

**Working on a real database?** Ablo never runs DDL, migrates, or drops on your database, and every model write is claim-checked and reversible in the log — so reads and `ablo.<model>.update(...)` are yours to run freely, while raw DDL (`ALTER TABLE …`) and a `--yes` cutover belong to a human. When you're unsure whether a write fits, `npx ablo check` reports the live column-by-column fit read-only, before anything runs. Full sorting rule: [Operating on Your Database](./docs/operating-on-your-database.md).

## Rule

Edit the generated files; teach this API only:

```ts
const ablo = Ablo({ schema, apiKey: process.env.ABLO_API_KEY });
```

The schema is the integration contract — it drives typed model clients, React selectors, server and agent writes, the Data Source shape, and schema push. Ablo owns only the models you declare; your auth and other non-synced tables stay in your own ORM schema, side by side in the same database. Don't create a parallel string-keyed write path for rows that belong to a schema model.

Every model verb takes ONE options object. The common loop:

1. **Read** the row — `await ablo.<model>.get({ id })` (async; from the server) or `await ablo.<model>.list({ where })` for many. In React render, read synchronously with `useAblo((a) => a.<model>.local.get(id))`.
2. **See who's active** (optional) — `ablo.<model>.claim.state({ id })` (synchronous; never blocks).
3. **Claim** the row before changing it — `await using claim = await ablo.<model>.claim({ id, description?, ttl? })`. If someone else holds it, this waits for them, then gives you the fresh row on `claim.data`. The claim auto-releases when it goes out of scope (`await using`).
4. **Write** — `await ablo.<model>.update({ id: claim.data.id, data })`. Because you hold the claim, the write is rejected if the row changed underneath you.

Keep coding assistants on this schema-backed path.

## Minimal example

```ts
import Ablo from '@abloatai/ablo';
import { defineSchema, model, z } from '@abloatai/ablo/schema';

const schema = defineSchema({
  weatherReports: model({
    location: z.string(),
    status: z.enum(['pending', 'ready']),
    forecast: z.string().optional(),
  }),
});

const ablo = Ablo({ schema, apiKey: process.env.ABLO_API_KEY });

const report = await ablo.weatherReports.get({ id: 'report_stockholm' });
if (!report) throw new Error('Report not found');

// If someone else holds the row, claim waits for them and re-reads the fresh
// row before resolving. Auto-released at the end of this scope (`await using`).
await using claim = await ablo.weatherReports.claim({
  id: 'report_stockholm',
  description: 'forecasting',
  ttl: '2m',
});
const claimed = claim.data;

// Because we hold the claim, update is rejected if the row changed underneath us.
await ablo.weatherReports.update({
  id: claimed.id,
  data: { status: 'ready', forecast: await getForecast(claimed.location) },
});
```

## Coordination surface

Claims live on a callable namespace beside `create` / `update` / `retrieve`. Every member takes an options object:

- `await using claim = await ablo.<model>.claim({ id })` — acquire the row (waits if held); read it via `claim.data`; auto-releases on scope exit (or call `claim.release()`).
- `ablo.<model>.claim.state({ id })` — who is currently working on the row (synchronous; never blocks).
- `ablo.<model>.claim.queue({ id })` — who is waiting behind the current holder.
- `ablo.<model>.claim.release({ id })` — release a claim early.
- `ablo.<model>.claim.reorder({ id, order })` — reorder the waiting queue.

Most users declare a schema and write through `ablo.<model>.update({ id, data })`.
