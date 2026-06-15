<p align="center">
  <a href="https://abloatai.com"><img src="assets/banner.png" alt="Ablo" width="480" /></a>
</p>

<p align="center">
  <strong>Let people and AI agents work on the same data without overwriting each other.</strong>
</p>

<p align="center">
  <a href="https://docs.abloatai.com">Docs</a> &nbsp;|&nbsp;
  <a href="https://docs.abloatai.com/quickstart">Quickstart</a> &nbsp;|&nbsp;
  <a href="https://docs.abloatai.com/api">API</a> &nbsp;|&nbsp;
  <a href="https://github.com/Abloatai/ablo">GitHub</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@abloatai/ablo"><img src="https://img.shields.io/npm/v/@abloatai/ablo?style=flat-square&color=2563eb" alt="npm" /></a>
  <a href="https://docs.abloatai.com"><img src="https://img.shields.io/badge/docs-docs.abloatai.com-2563eb?style=flat-square" alt="docs" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-2563eb?style=flat-square" alt="license" /></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A524-22c55e?style=flat-square" alt="node >=24" />
  <img src="https://img.shields.io/badge/types-included-2563eb?style=flat-square" alt="types included" />
</p>

---

When an agent and a person change the same thing at once, work gets lost: one
edit silently clobbers another, or the agent acts on data that already moved.
Ablo gives them one shared, typed write path so people, server actions, and
agents can all work on the same rows without working blind.

The core idea is a **claim**. An agent's work is rarely one instant write; it
reads something, thinks, calls an LLM or tool, then writes back. While that is
happening, the row can change underneath it. So before slow work starts, the
agent claims the row. If someone else is already working on it, `claim` waits,
re-reads the fresh row, then hands it over. No stale overwrite, no separate
agent mutation path.

Under the hood, you define your data once with a Zod schema and get the same
typed model client for every actor — people, server actions, and agents:

```ts
await ablo.task.create({ data })                  // create
await ablo.task.retrieve({ id })                  // read
await ablo.task.update({ id, data })              // update
await using task = await ablo.task.claim({ id })  // claim for safe, slow agent work
```

The schema is the public contract. It gives you typed model methods, realtime
fanout, React selectors, agent writes, and the HTTP/Data Source shape for
non-JavaScript services. Every confirmed change shows up everywhere, and active
claims are visible while the work is still in progress.

**[Get started](#set-up)** &nbsp;·&nbsp; point your coding agent at the shipped
`llms.txt` &nbsp;·&nbsp; **upgrading?** see the
[Version History &amp; Migration Guide](./docs/migration.md)

It works with the auth and database you already have. **In production, your
database is the system of record.** Ablo is the transaction layer on top of it:
realtime data is scoped to *sync groups* from your own identity, and every
committed row lives in your Postgres. (Trying Ablo with no database yet? The
hosted **sandbox** can host rows in Ablo's test plane — apiKey only, like
Stripe test mode — so you can explore before pointing it at your Postgres.)

**Built for** collaborative editors, AI agent workflows, and internal tools —
anywhere people and agents change shared state and everyone has to see it live.

## Set up

The CLI takes you from nothing to a synced schema — it handles the account,
the key, and the env file. You bring one thing: a Postgres you already have —
the same `DATABASE_URL` (local, Neon, RDS — any will do) that backs your auth,
audit, and log tables. Ablo syncs a *subset* of models against it; **in
production, your database is the system of record**.

```bash
npm install @abloatai/ablo
npx ablo login     # opens the browser: sign in (or sign up) → a sk_test_ key is saved locally
npx ablo init      # scaffolds ablo/schema.ts (offers to log in if you skipped it)
npx ablo push      # pushes your schema (sandbox), writes ABLO_API_KEY to .env.local, watches for changes
```

Then point Ablo at the tables for your synced models. Most teams **already
have those tables** (often Prisma- or Drizzle-managed) — adopt them with
`npx ablo pull` / `npx ablo check`, the common case. Let Ablo own its own
tables instead? `npx ablo migrate` provisions them in your Postgres (reads
`DATABASE_URL`). Either way your other tables are left untouched.

After `ablo push`, the [Quick Start](#quick-start) below runs as-is —
`ABLO_API_KEY` is already in `.env.local` (frameworks load it automatically;
plain Node: `node --env-file=.env.local app.ts`). `npx ablo status` shows
what's configured at any time.

**Keys & runtime.** Ablo needs Node 24+ and TypeScript 5+. Keys come in two of
*your* environments — `sk_test_` and `sk_live_`, like Stripe — and `ablo login`
mints both. Keep the key and the database URL in trusted server runtimes only.
In the browser, `<AbloProvider>` authenticates with the signed-in user's
session — never the raw key, never the database URL. Prefer the connection
string never leaving your infrastructure? Expose a signed
[Data Source endpoint](./docs/data-sources.md) instead and omit `databaseUrl`.

For production (React, an existing backend, Data Source, agents), the
[Integration Guide](./docs/integration-guide.md) is the deeper map.

**Prefer to let an agent wire it?** The package ships an `llms.txt` — a precise
map of the API — so Claude Code or Cursor integrates from the real surface
instead of guessing:

> Read `node_modules/@abloatai/ablo/llms.txt`, then add an Ablo schema, a `<AbloProvider>`, and my first create / retrieve / update.

## Quick Start

```ts
import Ablo from '@abloatai/ablo';
import { defineSchema, model, z } from '@abloatai/ablo/schema';
```

The schema is registered once (init scaffolds `ablo/register.ts` for you), and
every type is one parameter away — no `typeof schema` re-stating, anywhere:

```ts
// ablo/register.ts — scaffolded by `npx ablo init`, sits beside ablo/schema.ts
import type { schema } from './schema';
declare module '@abloatai/ablo' {
  interface Register { Schema: typeof schema }
}
export {};
```

It's a regular `.ts` module, not a hand-authored `.d.ts`. The top-level
`import type { schema }` makes the `declare module` block *merge* into (augment)
the SDK's `Register` interface instead of colliding with it — the same shape
[TanStack Router uses in `src/router.tsx`](https://tanstack.com/router/latest/docs/framework/react/guide/type-safety). Any `.ts` file in your
`tsconfig` `include` works; it never needs to be imported.

```ts
import type { Model } from '@abloatai/ablo/schema';

type WeatherReport = Model<'weatherReports'>; // fully typed from YOUR schema
```

(The same `Register` binding types every hook and client — it's the
TanStack-Router pattern: declare the source of truth once, everything
infers from it.)

### Naming the client type

When you need to pass the client around (a function parameter, a context value),
**infer the type from the value** — `type Sync = typeof sync`:

```ts
export const sync = Ablo({ schema, apiKey: process.env.ABLO_API_KEY });
export type Sync = typeof sync; // fully-typed, schema-aware

function persist(client: Sync) { /* ... */ }
```

This is the same idiom as tRPC's `type AppRouter = typeof appRouter` and
Drizzle's `typeof db` — the factory resolves the typed overload at the call
site, so `typeof sync` carries your schema. Do **not** write
`ReturnType<typeof Ablo>`: that collapses to the untyped last overload and
loses your model types. There is no bespoke client-type generic to import —
`typeof` your client value is the type.

```ts
const schema = defineSchema({
  weatherReports: model({
    location: z.string(),
    status: z.enum(['pending', 'ready']),
    forecast: z.string().optional(),
  }),
});

const ablo = Ablo({
  schema,
  apiKey: process.env.ABLO_API_KEY, // written to .env.local by `npx ablo push`
  databaseUrl: process.env.DATABASE_URL, // your Postgres, passed explicitly — rows live here
});

await ablo.ready();

const created = await ablo.weatherReports.create({
  data: {
    location: 'Stockholm',
    status: 'pending',
  },
});

// An agent claims the row, does its slow work, then writes back. While the
// claim is held nobody else can overwrite it; anyone else who tries waits in
// line and re-reads the result. This is the whole point of Ablo.
await using claim = await ablo.weatherReports.claim({ id: created.id });
const report = claim.data;
const forecast = await fetchForecast(report.location); // slow: API or LLM call
await ablo.weatherReports.update({ id: report.id, data: { status: 'ready', forecast } });

const ready = ablo.weatherReports.get(created.id);
console.log({ id: ready?.id, status: ready?.status });

await ablo.dispose();
```

Expected output:

```txt
{ id: '...', status: 'ready' }
```

## Reading

Two ways to read, depending on whether you can wait. `get(id)` / `getAll({ where })`
/ `getCount({ where })` are instant — they read what's already local and re-render
on their own when it changes, so they're what your UI uses. `retrieve(id)` /
`list({ where })` go ask the server and return a `Promise`, for when you need the
authoritative answer right now.

```ts
ablo.weatherReports.get('report_stockholm');

const pending = ablo.weatherReports.getAll({
  where: { status: 'pending' },
  orderBy: { location: 'asc' },
  limit: 20,
});

const ready = await ablo.weatherReports.list({
  where: { status: 'ready' },
  type: 'complete',
});
```

An array value in `where` means `IN`. On `list`, `type: 'complete'` waits for
the server; `'unknown'` returns what's local now and refreshes in the background.

## Writing

`create` / `update` apply optimistically and resolve to the row. Two options
matter day to day:

| Option | Values | What it does |
| --- | --- | --- |
| `wait` | `'queued'` \| `'confirmed'` | `'confirmed'` resolves only after the server acks the write; `'queued'` resolves as soon as it's locally queued (fire-and-forget). |
| `idempotencyKey` | `string` | Auto-generated per call. Override only when you own the retry boundary (e.g. a job id) so a re-run dedupes server-side. |

```ts
await ablo.weatherReports.update({ id, data: { status: 'ready' }, wait: 'confirmed' });
```

To guard a write against a row that changed under you, pass `readAt` + `onStale`
— see [Coordinating long agent work](#coordinating-long-agent-work).

## Coordinating long agent work

An agent reads a row, thinks for 30s, writes back — and clobbers whatever changed
meanwhile, or worse, acts on stale state. `claim` holds the row across that gap:

```ts
await using claim = await ablo.weatherReports.claim({ id: 'report_stockholm' });
const report = claim.data;
const forecast = await weatherAgent.getWeather(report.location);
await ablo.weatherReports.update({ id: report.id, data: { forecast, status: 'ready' } });
```

If someone else holds the row, `claim()` waits in a fair queue, then re-reads —
so `report` is the current row, never a stale snapshot. Reads stay open by
default; only acting on the row serializes. The claim releases when the `await
using` scope exits.

See who's mid-edit before you act — decide to wait, or skip:

```ts
ablo.weatherReports.claim.state({ id: 'report_stockholm' });
ablo.weatherReports.claim.queue({ id: 'report_stockholm' });

{
  await using claim = await ablo.weatherReports.claim({ id, wait: false });
  /* do the held work */
}

{
  await using claim = await ablo.weatherReports.claim({ id, maxQueueDepth: 2 });
  /* do the held work */
}
```

`claim.state` returns the holder (or `null`); `claim.queue` returns the line waiting
behind it. `wait: false` skips rather than waiting when the row is held;
`maxQueueDepth: 2` bails when two or more are already ahead.

Default reads keep working while a row is claimed. Server reads that need claimed
semantics can opt in with `ifClaimed: 'return' | 'wait' | 'fail'`.

Even an unclaimed write can't land on stale reasoning — the commit is guarded:

```ts
try {
  await ablo.weatherReports.update({ id, data: { status: 'ready' }, readAt, onStale: 'reject' });
} catch (e) {
  if (e instanceof AbloStaleContextError) { /* row moved under you — re-read, retry */ }
}
```

> Use `await using` for ordinary held work — the claim releases when the scope
> exits. Call `claim.release({ id })` only to give a manually held claim back
> early.

See [Coordination](./docs/coordination.md) for the full `claim` / `claim.state` /
`claim.queue` / `claim.release` reference.

## React

In a React app it's the **same `ablo.<model>` API** — just mounted through a
provider and read with hooks, from `@abloatai/ablo/react`. Wrap your tree once;
everything inside is live.

```tsx
import Ablo from '@abloatai/ablo';
import { AbloProvider, useAblo } from '@abloatai/ablo/react';
import { schema } from './ablo/schema';

// Build the client once — it authenticates via your session route, no key in the browser.
const ablo = Ablo({ schema, authEndpoint: '/api/ablo-session' });

function App() {
  return (
    <AbloProvider client={ablo}>
      <Report id="report_stockholm" />
    </AbloProvider>
  );
}

function Report({ id }: { id: string }) {
  const report = useAblo((ablo) => ablo.weatherReports.get(id));
  const ablo = useAblo();

  if (!report) return null;

  return (
    <button onClick={() => ablo?.weatherReports.update({ id, data: { status: 'ready' } })}>
      {report.status}
    </button>
  );
}
```

The `useAblo(selector)` read re-renders whenever the row changes — whether you,
a teammate, or an agent changed it. The write is the same optimistic, fan-out
method as the server example above.

`<AbloProvider>` owns the connection — no API key in the browser. That's the
whole loop: read with `useAblo(selector)`, write with `ablo.<model>`, and every
other client (human or agent) on that row sees it in real time. See
[React](./docs/react.md) for the `<AbloProvider>` prop surface (`client`,
`userId`, `fallback`, `onError`) — schema, scope, and team membership live on the
`Ablo({ … })` client you pass it — plus status hooks.

## Identity & Sync Groups

Ablo is **not** an auth provider — you keep your own (Clerk, Auth0, NextAuth,
whatever). Ablo's job starts after you've authenticated a request: you tell it
*who* is connecting, and it scopes their realtime data to the right **sync
groups** (named channels like `org:acme` or `deck:abc123` that are both the unit
of fan-out and the unit of access).

The model is a proxy: your `ABLO_API_KEY` stays on your trusted server, your
server resolves the signed-in user (org / team / user) from your own auth, and
the browser connects as an already-scoped participant — it never holds the key
and can't widen its own scope. Your schema's `identityRoles` map that identity
to sync-group strings.

`userId` / `teamIds` come from your auth, resolved server-side:

```tsx
// team membership is asserted server-side when the session route mints the token.
const ablo = Ablo({ schema, authEndpoint: '/api/ablo-session' });

<AbloProvider client={ablo} userId={user.id}>
  <App />
</AbloProvider>
```

If it isn't obvious where org / team / user come from in the Quick Start above,
that's because they come from *your* app — see
[Identity & Sync Groups](./docs/identity.md) for the full picture: what a sync
group is, the two halves of scoping (`identityRoles` + per-model `orgScoped` /
`syncGroupFormat`), and how identity reaches Ablo without an API key in the
browser.

## Multiplayer

There is no separate multiplayer mode. When human UI, server actions, and agent
workers share the same schema and write through `ablo.<model>`, they all see
each other's changes in real time — that's the default, not a feature you turn on.

- `ablo.<model>.create/update/delete` fan out confirmed deltas to subscribers.
- `useAblo(...)` gives React clients the live row, kept current automatically.
- `ablo.<model>.claim({ id })` / `claim.state({ id })` / `claim.queue({ id })` let humans and agents coordinate (and observe) active work on a row — and the line waiting behind it — before a write lands.

Always write through Ablo — either the SDK model methods
(`ablo.<model>.create/update/delete`) or the HTTP write endpoint below. If you
write straight to your own database instead, those changes won't reach connected
clients.

## HTTP Writes

Use the SDK when you are in JavaScript and want typed models or realtime. Use the
HTTP endpoint when a server-to-server caller needs to write without opening a
WebSocket:

```bash
curl https://api.abloatai.com/v1/commits \
  -H "Authorization: Bearer sk_test_..." \
  -H "Content-Type: application/json" \
  -d '{ "operations": [
        { "action": "update", "model": "weatherReports", "id": "report_stockholm", "data": { "status": "ready" } }
      ] }'
```

```json
{ "object": "commit_receipt", "status": "confirmed", "serverTxId": "tx_…", "lastSyncId": 1042, "ops": 1 }
```

## Your Database

In production, every schema model is backed by **your own database** — Ablo is
the transaction layer on top of it. Two ways to connect it:

| | How Ablo reaches your Postgres | Use when |
| --- | --- | --- |
| **Connection string** (primary) | `databaseUrl` at init — passed explicitly, never auto-read from the environment. Ablo registers the connection once (sent over TLS, stored sealed, never echoed back) and commits each write directly — through a non-superuser role, behind row-level security. | You can hand over a scoped connection string. |
| **Signed endpoint** | Your app exposes one route built from an ORM adapter (`prismaDataSource` / `drizzleDataSource`); Ablo sends signed commit requests and your app writes its own database. | Database credentials must never leave your infrastructure. |

(No database yet? The hosted **sandbox** can host rows in Ablo's test plane —
omit `databaseUrl` and pass an `apiKey` only, like Stripe test mode — so you can
try Ablo before connecting your Postgres.)

Same product, same truth either way: in production your database is the system of
record. See
[Connect Your Database](./docs/data-sources.md) for both shapes.

## Configuration

`Ablo({ ... })` takes your schema, your key, and — in production — your database,
either as an explicit `databaseUrl` here or as a signed
[Data Source endpoint](./docs/data-sources.md) in your app. (`databaseUrl` is
never auto-read from the environment; omit it to try Ablo against the hosted
sandbox.) Every other option has correct defaults:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `schema` | `Schema` | — (required) | Typed model proxies (`ablo.<model>.*`) |
| `apiKey` | `string \| ApiKeySetter \| null` | `process.env.ABLO_API_KEY` | Server key — a string, or an async function for rotation |
| `databaseUrl` | `string \| null` | `—` | Your Postgres, registered as the data plane. **Must be passed explicitly — it is not auto-read from the environment.** If you have a `DATABASE_URL` set for another tool (Prisma, Drizzle, docker-compose), `Ablo()` ignores it unless you pass `databaseUrl` explicitly. Server runtimes only — the SDK throws if it sees this in a browser. Omit it when your app exposes a signed [Data Source endpoint](./docs/data-sources.md) instead, or when trying Ablo against the hosted sandbox. |

Keep `apiKey` in trusted server runtimes. In the browser, `<AbloProvider>`
authenticates with the signed-in user's session; the raw-key path is gated
behind `dangerouslyAllowBrowser` for server-proxy setups only. Advanced hooks
(custom `fetch`, logging, observability, transport overrides) live in
[Client Behavior](./docs/client-behavior.md).

## Errors

Every SDK error extends `AbloError` and carries a `requestId` for support.
Discriminate with `instanceof` or the `type` string — the string form also
survives worker / `postMessage` boundaries, where `instanceof` does not:

```ts
try {
  await ablo.weatherReports.update({ id, data: { status: 'ready' }, readAt, onStale: 'reject' });
} catch (e) {
  if (e instanceof AbloStaleContextError) { /* row moved under you — re-read, retry */ }
  if ((e as AbloError).type === 'AbloClaimedError') { /* another participant holds it */ }
}
```

| Error | When |
| --- | --- |
| `AbloAuthenticationError` | Invalid / missing / expired credentials |
| `AbloPermissionError` / `CapabilityError` | Action forbidden by scope |
| `AbloRateLimitError` | Rate limited (carries `retryAfterSeconds`) |
| `AbloIdempotencyError` | Same `idempotencyKey` reused with a different body |
| `AbloValidationError` | Invalid request payload |
| `AbloStaleContextError` | Write carried `readAt`, but the row has newer changes (`conflicts`) |
| `AbloClaimedError` | Target is claimed by another participant (`claims`) |
| `AbloConnectionError` / `AbloServerError` | Transport failure / server 5xx |
| `SyncSessionError` | Session expired (prompts re-auth) |

## Reconnect & retries

The client owns reconnection so your code doesn't have to. A dropped WebSocket
reconnects automatically with exponential backoff (1s → 30s, ±15% jitter, up to
~7.5 minutes); session errors (401/403) suppress it so you re-authenticate
instead of looping. Commits are idempotent by client transaction id, and a
commit that times out is never silently rolled back — the client reconciles
against authoritative server state on reconnect. These defaults are the
contract; there are no retry or timeout knobs to tune.

## Production Reference

- [Version History & Migration Guide](./docs/migration.md) — every breaking change, what to change, and which version introduced it. Read before bumping a minor.
- [Identity & Sync Groups](./docs/identity.md) — use your own authentication; tell Ablo who's connecting and how org / team / user map to sync-group scope.
- [Schema Contract](./docs/schema-contract.md) — one schema becomes typed model clients, React reads, agent writes, Data Source shape, and schema push.
- [Guarantees](./docs/guarantees.md) — confirmed writes, stale-write protection, claim coordination, and agent lifecycle.
- [Integration Guide](./docs/integration-guide.md) — integrate React, your database, multiplayer, and agents.
- [React](./docs/react.md) — `<AbloProvider>`, `useAblo`, presence, status, and bootstrap gating.
- [Coordination](./docs/coordination.md) — `claim` / `claim.state` / `claim.queue` / `claim.release` reference: hold a row across slow agent work, and observe the line waiting behind it.
- [Client Behavior](./docs/client-behavior.md) — options, errors, retries, timeouts, and public imports.
- [Connect Your Database](./docs/data-sources.md) — connect your Postgres by connection string (`databaseUrl`) or signed endpoint; your database is the system of record either way.
- [Existing Python Backend](./docs/examples/existing-python-backend.md) — migrate existing Python endpoints to multiplayer and agent-safe writes gradually.
- [AI SDK Tool](./docs/examples/ai-sdk-tool.md) — use Ablo inside an AI SDK tool call.
- [Server Agent](./docs/examples/server-agent.md) — schema-backed worker.

## License

Apache License 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
