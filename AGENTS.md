# AGENTS.md

Ablo lets AI agents and humans safely edit the same typed data without clobbering each other. When two of them touch the same row, a "claim" makes one wait for the other instead of overwriting it. This file shows a coding assistant the one safe pattern: read a row, claim it, then write.

Claims don't lock. If another writer holds the row, `claim` waits for them and re-reads the fresh row before handing it to you — so two writers serialize instead of clobbering.

## Start here — scaffold with `ablo init`

Don't hand-write the integration. Run the CLI; it generates the current-API schema, client, the database connection (logical replication by default, or a signed Data Source endpoint as the fallback), and (for Next.js) the browser provider + session route:

- **Scaffold:** `npx ablo init --yes` — flag-driven, never prompts. Override defaults with `--framework <nextjs|vite|remix|vanilla>`, `--auth <apikey|…>`, `--no-agent`, `--no-pull`, `--no-install`, `--no-login`. (Plain `ablo init` needs a TTY and will **HANG** in an agent/CI run — always pass `--yes`.)
- **Auth:** set `ABLO_API_KEY` in the environment. Do **NOT** run `ablo login` — it opens a browser device flow and blocks an agent.
- **Connect your database — logical replication (the primary path):** `npx ablo connect` prints the setup SQL (`wal_level=logical`, a publication, a `REPLICATION` role); `npx ablo connect --register` registers the source with Ablo in one step. Ablo **consumes your Postgres' logical-replication stream** — it never runs DDL on, writes to, owns, or migrates your database, and your application keeps the write path. Registration **is** the enable; there is no tier or flag to pick. (Ablo hosts only the transaction log + coordination, never your rows.)
- **Fallback — signed Data Source endpoint** (DB can't grant a `REPLICATION` role): the generated `ablo/data-source.ts` exposes one route; Ablo sends signed requests and your app touches its own DB. **Only in this mode** does `npx ablo migrate` provision the adapter's bookkeeping tables (`ablo_outbox`, `ablo_idempotency`) plus your Ablo models — it does **not** touch your other tables. Keep your own migrations (drizzle-kit / prisma migrate) for auth and anything outside the Ablo schema.
- **No database yet?** A sandbox `sk_test` key holds throwaway **test data** (Stripe-test-mode style) so you can try Ablo before connecting your own Postgres. Test-mode only — in production every row lives in your database.
- **Adopt an existing DB schema:** `npx ablo pull prisma [path]` / `pull drizzle <module>` (lossless) or `pull` (live DB, lossy). Writes `ablo/schema.ts`.
- **Push your schema — REQUIRED before any write works.** The server keeps its OWN copy of the schema. After you create or edit `ablo/schema.ts`, run `npx ablo push` (one-shot) — or `npx ablo dev --no-watch`. **Skip this and every write to a new or changed model fails with `server_execute_unknown_model`.** (Plain `ablo dev` watches forever — never run it bare in an agent.)
- **Other long-running:** `npx ablo logs --no-follow` (default tails forever). `npx ablo mode test|live` ALWAYS pass the argument. `status`, `push`, `pull`, `check`, `generate` are one-shot — safe as-is.

When you use the signed-endpoint fallback, the generated `ablo/data-source.ts` is the whole endpoint and needs no hand-editing: `dataSourceNext({ schema, apiKey, adapter: prismaDataSource(prisma, schema) })` (or `drizzleDataSource(db, schema)`). The adapter owns commit / idempotency / outbox.

## Rule

Edit the generated files; teach this API only:

```ts
const ablo = Ablo({ schema, apiKey: process.env.ABLO_API_KEY });
```

The schema is the integration contract — it drives typed model clients, React selectors, server and agent writes, the Data Source shape, and schema push. Ablo owns only the models you declare; your auth and other non-synced tables stay in your own ORM schema, side by side in the same database. Don't create a parallel string-keyed write path for rows that belong to a schema model.

Every model verb takes ONE options object. The common loop:

1. **Read** the row — `await ablo.<model>.retrieve({ id })` (async; from the server) or `await ablo.<model>.list({ where })` for many. In React render, read synchronously with `useAblo((a) => a.<model>.get(id))`.
2. **See who's active** (optional) — `ablo.<model>.claim.state({ id })` (synchronous; never blocks).
3. **Claim** the row before changing it — `await using claim = await ablo.<model>.claim({ id, reason?, ttl? })`. If someone else holds it, this waits for them, then gives you the fresh row on `claim.data`. The claim auto-releases when it goes out of scope (`await using`).
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

const report = await ablo.weatherReports.retrieve({ id: 'report_stockholm' });
if (!report) throw new Error('Report not found');

// If someone else holds the row, claim waits for them and re-reads the fresh
// row before resolving. Auto-released at the end of this scope (`await using`).
await using claim = await ablo.weatherReports.claim({
  id: 'report_stockholm',
  reason: 'forecasting',
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
