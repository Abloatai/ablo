# Ablo

[![npm](https://img.shields.io/npm/v/@abloatai/ablo.svg)](https://www.npmjs.com/package/@abloatai/ablo)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![types](https://img.shields.io/badge/types-included-blue.svg)](#)
[![runtime](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](#keys--runtime)

**Let people and AI agents work on the same data without overwriting each other.**

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

Under the hood, you define a Zod schema once and get typed model clients for
every actor:

```txt
schema -> ablo.<model>.create/retrieve/update/claim(...)
```

The schema is the public contract. It gives you typed model methods, realtime
fanout, React selectors, agent writes, and the HTTP/Data Source shape for
non-JavaScript services. Every confirmed change shows up everywhere, and active
claims are visible while the work is still in progress.

[Get started ↓](#quick-start) · point your coding agent at the shipped `llms.txt`

It works with the auth and database you already have: realtime data is scoped to
*sync groups* from your own identity, and your database can stay the source of
truth via a Data Source.

**Built for** collaborative editors, AI agent workflows, and internal tools —
anywhere people and agents change shared state and everyone has to see it live.

## Set up

```bash
npm install @abloatai/ablo
```

**Keys & runtime.** Ablo needs Node 22+ and TypeScript 5+. Grab an `sk_test_*`
key for a sandbox
(`export ABLO_API_KEY=sk_test_...`); keep keys in trusted server runtimes only.
In the browser, `<AbloProvider>` authenticates with the signed-in user's
session — never the raw key.

Then wire it by hand — the [Quick Start](#quick-start) below is the shape to
copy. For production (React, an existing backend, Data Source, agents), the
[Integration Guide](./docs/integration-guide.md) is the deeper map.

**Prefer to let an agent wire it?** The package ships an `llms.txt` — a precise
map of the API — so Claude Code or Cursor integrates from the real surface
instead of guessing:

> Read `node_modules/@abloatai/ablo/llms.txt`, then add an Ablo schema, a `<AbloProvider>`, and my first create / retrieve / update.

## Quick Start

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

const ablo = Ablo({
  schema,
  apiKey: process.env.ABLO_API_KEY,
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
console.log({ id: ready.id, status: ready.status });

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
import { AbloProvider, useAblo } from '@abloatai/ablo/react';
import { schema } from './ablo/schema';

function App() {
  return (
    <AbloProvider schema={schema}>
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
[React](./docs/react.md) for the full `<AbloProvider>` prop surface (`userId`,
`teamIds`, `syncGroups`, `fallback`, `bootstrapMode`) and status hooks.

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
<AbloProvider schema={schema} userId={user.id} teamIds={user.teamIds}>
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

## Connect Your Database

Every schema model has a backing store. By default, Ablo stores rows for the
models you declare, so `ablo.weatherReports.create({ data })` and `ablo.weatherReports.update({ id, data })`
write to Ablo-managed state.

If your existing database stays the source of truth, connect it as a Data
Source: Ablo sends signed commit requests to an endpoint you host, and your app
writes its own database. Your `DATABASE_URL` stays in your app — Ablo only ever
sees the API key.

See [Connect Your Database](./docs/data-sources.md) for the integration shape.

## Configuration

`Ablo({ ... })` takes one required option and a couple of transport overrides:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `schema` | `Schema` | — (required) | Typed model proxies (`ablo.<model>.*`) |
| `apiKey` | `string \| ApiKeySetter \| null` | `process.env.ABLO_API_KEY` | Server key — a string, or an async function for rotation |
| `baseURL` | `string` | `wss://api.abloatai.com` | Point at a self-hosted or private API |

Keep `apiKey` in trusted server runtimes. In the browser, `<AbloProvider>`
authenticates with the signed-in user's session; the raw-key path is gated
behind `dangerouslyAllowBrowser` for server-proxy setups only. Self-hosted
deployments can pass `authToken` instead of `apiKey`. Advanced hooks (custom
`fetch`, logging, observability) live in [Client Behavior](./docs/client-behavior.md).

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

- [Identity & Sync Groups](./docs/identity.md) — bring your own auth; tell Ablo who's connecting and how org / team / user map to sync-group scope.
- [Schema Contract](./docs/schema-contract.md) — one schema becomes typed model clients, React reads, agent writes, Data Source shape, and schema push.
- [Guarantees](./docs/guarantees.md) — confirmed writes, stale-write protection, claim coordination, and agent lifecycle.
- [Integration Guide](./docs/integration-guide.md) — pick the backing mode and integrate React, Data Source, multiplayer, and agents.
- [React](./docs/react.md) — `<AbloProvider>`, `useAblo`, presence, status, and bootstrap gating.
- [Coordination](./docs/coordination.md) — `claim` / `claim.state` / `claim.queue` / `claim.release` reference: hold a row across slow agent work, and observe the line waiting behind it.
- [Client Behavior](./docs/client-behavior.md) — options, errors, retries, timeouts, and public imports.
- [Connect Your Database](./docs/data-sources.md) — keep canonical rows in your app database without giving Ablo database credentials.
- [Existing Python Backend](./docs/examples/existing-python-backend.md) — migrate existing Python endpoints to multiplayer and agent-safe writes gradually.
- [AI SDK Tool](./docs/examples/ai-sdk-tool.md) — use Ablo inside an AI SDK tool call.
- [Server Agent](./docs/examples/server-agent.md) — schema-backed worker.

## License

Apache License 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
