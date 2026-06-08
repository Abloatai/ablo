# Integration Guide

If humans and AI agents both edit the same records in your app, they overwrite
each other and there's no good place to coordinate. Ablo gives them one shared,
typed write path — the same `ablo.<model>.update(...)` call for a React
component, a server action, a background worker, or an agent — and reconciles the
edits. This guide adds it to a product that already has a backend and database,
one model at a time.

Three things hold no matter which actor is writing:

- **One model API for every actor.** `ablo.<model>.update(...)` is what
  React components, server actions, background workers, and AI agents
  all call. No separate "agent SDK," no parallel mutation path. The
  attribution comes from the credential, not the call site.
- **You never type `org:123` in client code.** The server derives what each
  caller can see from their authenticated identity, using the `identityRoles`
  you declare once in the schema. The client just names which model and id it
  wants. The `org:` / `user:` / `team:` (or your own `region:` / `customer:`)
  prefixes live in the schema, never in consumer code.
- **Agents don't use your account API key.** Each agent run gets a short-lived
  credential scoped to just what that run can touch, verified per request and
  revocable instantly. (See the Agents section below for the actual calls.)

## The integration in one diagram

The normal integration is one client:

```ts
import Ablo from '@abloatai/ablo';
import { defineSchema, model, z } from '@abloatai/ablo/schema';
```

Declare the models Ablo coordinates, then read and write through
`ablo.<model>`. React, server actions, backend workers, and agents should all use
that same model path.

```txt
schema -> ablo.<model>.list(...) -> ablo.<model>.update(...)
```

Commits and receipts exist under the hood. Most apps do not create protocol
objects by hand.

## Pick The Backing Mode

Every schema model has a backing store. The SDK call shape stays the same.

| Mode         | Rows live in      | Use when                                                                         |
| ------------ | ----------------- | -------------------------------------------------------------------------------- |
| Ablo-managed | Ablo              | New collaborative or agent-written state can live in Ablo.                       |
| Data Source  | Your app database | You already have tables, service logic, and API endpoints that remain canonical. |

Do not pass a database URL to `Ablo(...)`. Application and agent code use
`ABLO_API_KEY`. If your database stays canonical, expose a signed Data Source
endpoint from your app and keep the database credentials inside your app.

## Test With Sandboxes

Use the public `/sandbox` page to understand the state flow. It is a visual,
deterministic demo; it does not call your API key or mutate hosted Ablo data.
It is also built for coding agents: copy the sandbox prompt into Claude Code or
Codex and ask it to wire one real model through the schema model API.

Use the authenticated org dashboard sandbox for real integration work. The
default sandbox is the equivalent of Stripe test mode:

- it is scoped to the organization,
- it has an isolated sync group prefix,
- it mints `sk_test_*` keys,
- it can be reset without touching live state,
- additional sandboxes can start blank or from copied live configuration.

Live keys and sandbox keys are separate. Use `sk_test_*` while wiring your app,
agents, and Data Source endpoint; move to `sk_live_*` only when the same schema
and write path are ready for production.

When handing this to a coding agent, give it a concrete target:

```txt
Add Ablo to this app for one model that humans and agents both edit.
Use the org sandbox sk_test_* key. Declare schema, add the Ablo client, replace
one write with ablo.<model>.update(..., { readAt, onStale: 'reject',
wait: 'confirmed' }), and add a smoke test for two concurrent writers.
```

## 1. Declare A Schema

Start with fields and relations. Keep load strategies, indexing hints, and
read-only/mutable shortcuts out of the first version unless you already need
them.

```ts
// src/ablo/schema.ts
import { defineSchema, model, z } from '@abloatai/ablo/schema';

export const schema = defineSchema(
  {
    weatherReports: model({
      id: z.string(),
      projectId: z.string(),
      location: z.string(),
      status: z.enum(['pending', 'ready']),
      assigneeId: z.string().nullable(),
      updatedAt: z.string(),
    }),
  },
  {
    // Identity-anchored sync-group roles. The server walks these to build each
    // participant's allowed subscription set from the resolved identity context.
    // `kind` is the group prefix; `source` is the identity field to read — both
    // consumer-controlled, no hardcoded `org:` / `user:` convention anywhere in
    // the engine. Pure data (no closures), so the schema stays JSON-serializable.
    // Omit `identityRoles` entirely if you don't need identity-derived scoping.
    identityRoles: [
      identityRole({ kind: 'org', source: 'organizationId' }),
      identityRole({ kind: 'user', source: 'userId' }),
    ],
  }
);
```

### Declaring scope on a model

> **Canonical reference: [Identity & Sync Groups](./identity.md).** This is the
> short version — `scope` (root), `parent` (containment), `grants` (membership),
> and the model-form `scope` prop are all covered in depth there. Read it once;
> this guide only shows the minimal shape inline.

Per-row tenancy and per-entity sync-group anchors live on the `model(...)`
options. The two halves compose: the identity roles above produce a
participant's _allowed_ set; the per-model options below define how rows are
filtered server-side and which sync-group each row fans out on.

```ts
model(
  {
    /* fields */
  },
  /* relations */ {},
  {
    // Rows carry organization_id and bootstrap filters on it.
    orgScoped: true,

    // Scope root: rows form the group `matter:<id>`. Children point at it with
    // `relation.belongsTo('matters', 'matterId', { parent: true })` to inherit.
    scope: 'matter',
  }
);
```

For rows that don't carry `organization_id` themselves but inherit
tenancy via a foreign key, use `scopedVia` instead of `orgScoped:
false` — the latter exposes the entire table cross-tenant. See
`packages/sync-engine/src/schema/model.ts` for the full option set.

## 2. Create The Client

Trusted runtimes can use `ABLO_API_KEY`.

```ts
// src/ablo.ts
import Ablo from '@abloatai/ablo';
import { schema } from './ablo/schema';

export const ablo = Ablo({
  schema,
  apiKey: process.env.ABLO_API_KEY,
});
```

Browser apps should use the React provider or a scoped session token, not a
server API key in the bundle.

```tsx
// app/providers.tsx
'use client';

import { AbloProvider } from '@abloatai/ablo/react';
import { schema } from '@/ablo/schema';

export function Providers({ children }: { children: React.ReactNode }) {
  return <AbloProvider schema={schema}>{children}</AbloProvider>;
}
```

### Why two credential shapes

`ABLO_API_KEY` is your long-lived account credential. Treat it like a
Stripe secret key: it stays on trusted servers, never reaches a browser
bundle, and signs server-to-server requests. It is the right credential
for trusted runtimes (Next.js server actions, background workers,
migration scripts) where the code reading it is yours.

A browser is not that environment. The React provider exchanges your API key for
a short-lived, narrowly scoped bearer token. The browser holds that scoped token;
the API key never leaves the server. The exchange is the bridge between two
credential shapes:

```
                     trusted runtime              browser / agent
ABLO_API_KEY ─exchange─►  scoped token ────────► narrow scope, leased
(long-lived,             (short-lived,
 broad scope,             per-actor scope,
 server only)             revocable)
```

This is the same shape as Stripe's
ephemeral keys (Issuing Elements expires in 15 minutes) and AWS STS
AssumeRole (returns time-bounded creds with the minimal needed scope).
You never type that token into your app; the SDK mints one when it needs one and
refreshes before expiry.

## 3. Read State

Reads come in two flavors, and you pick based on whether you can wait.
`retrieve(id)` and `list({ where })` hit the server (and hydrate the local
store) — they're async, so you `await` them. `get(id)`, `getAll({ where })`,
and `getCount({ where })` read the already-synced local graph synchronously, so
they're the ones you call in render.

Use `retrieve` when the row may not be local yet — it fetches from the server
and waits.

```ts
await ablo.ready();

const report = await ablo.weatherReports.retrieve({ id: 'report_stockholm' });
if (!report) throw new Error('report not found');
```

Use `get`, `getAll`, and `getCount` for synchronous local-graph reads after
data has synced.

```ts
const report = ablo.weatherReports.get('report_stockholm');
const activeReports = ablo.weatherReports.getAll({
  where: { projectId: 'proj_123' },
  filter: (report) => report.status !== 'ready',
  orderBy: { updatedAt: 'desc' },
  limit: 50,
});
```

In React, selector `useAblo` is the public read API:

```tsx
'use client';

import { useAblo } from '@abloatai/ablo/react';

export function ReportRow({
  report: serverReport,
}: {
  report: { id: string; location: string; status: string };
}) {
  const report = useAblo((ablo) => ablo.weatherReports.get(serverReport.id)) ?? serverReport;
  const active = useAblo((ablo) => ablo.weatherReports.claim.state({ id: serverReport.id }));

  return <button disabled={Boolean(active) || report.status === 'ready'}>{report.location}</button>;
}
```

Use zero-argument `useAblo()` only in callbacks and effects:

```tsx
const ablo = useAblo();
```

## 4. Write State

For simple writes:

```ts
await ablo.weatherReports.update({ id: 'report_stockholm', data: { status: 'ready' }, wait: 'confirmed' });
```

For writes based on state the user or agent already read, snapshot first and
reject stale updates:

```ts
const snap = ablo.snapshot({ weatherReports: 'report_stockholm' });

await ablo.weatherReports.update({
  id: 'report_stockholm',
  data: { status: 'ready' },
  readAt: snap.stamp,
  onStale: 'reject',
  wait: 'confirmed',
});
```

`wait: 'confirmed'` resolves after the server accepts the write. Rejections roll
back optimistic local state and throw a typed `AbloError`.

## 5. Multiplayer Is Automatic

There is no separate multiplayer setup.

If humans, server actions, and agents use the same schema client, they
share the same stream:

```txt
human UI -> ablo.weatherReports.update(...)
agent    -> ablo.weatherReports.update(...)
server   -> ablo.weatherReports.update(...)
```

Ablo coordinates those writes, fans out confirmed deltas, exposes active claims,
and lets callers reject stale writes with `readAt`.

Direct writes to your own database bypass that stream until your app reports the
change through Data Source events.

## 6. Existing API Backend

This is the path for a product where buttons already call Python, Rails, Go, or
Node endpoints.

Keep your backend and database canonical. Add Ablo as the shared write path for
the records that need multiplayer now and agent-safe writes later.

```txt
Button
  -> ablo.weatherReports.update(...)
  -> Ablo
  -> signed Data Source request
  -> existing backend service
  -> app database
  -> Ablo realtime fanout
```

The migration can be gradual:

1. Declare schema for one model, such as `reports`.
2. Keep existing server loads for first paint.
3. Add `useAblo((ablo) => ablo.weatherReports.get(id)) ?? serverReport` for live rows.
4. Add one Data Source endpoint that calls the existing service layer.
5. Move one mutation button from `fetch('/api/reports/...')` to `ablo.weatherReports.update(...)`.
6. Add an outbox/events path for writes that still happen outside Ablo.
7. Let agents use the same `ablo.weatherReports.list(...)` and `ablo.weatherReports.update(...)`.

For the full Python shape, see
[Existing Python Backend](./examples/existing-python-backend.md).

## 7. Data Source Endpoint

Use a Data Source when your app database remains the source of truth.

```ts
// app/api/ablo/source/route.ts
import { dataSource } from '@abloatai/ablo';
import { schema } from '@/ablo/schema';
import { db } from '@/db';

export const POST = dataSource({
  schema,
  apiKey: process.env.ABLO_API_KEY,

  authorize() {
    return { db };
  },

  async commit({ operations, clientTxId, context }) {
    const rows = await context.auth.db.transaction(async (tx) => {
      await tx.idempotency.upsert({ key: clientTxId });
      return applyOperations(tx, operations);
    });

    return { rows };
  },

  reports: {
    async load({ id, context }) {
      return context.auth.db.report.findUnique({ where: { id } });
    },

    async list({ query, context }) {
      return context.auth.db.report.findMany({
        take: query.limit ?? 100,
      });
    },
  },
});
```

Ablo needs your Data Source endpoint and API key. External writes can be
reported through an optional `events` handler on the same route. Your app
stores one Ablo credential:

```bash
ABLO_API_KEY=sk_live_...
```

The API key verifies Ablo's request. It is not a database credential.

## 8. Agents

Agents should use the same model methods as the app when they can import the
schema.

An agent often reads a row, calls an LLM, then writes back — a slow gap during
which a human might touch the same row. Wrap that work in a claim. Claims don't
lock. If another writer holds the row, `claim` waits for them, re-reads the
fresh row, then hands it to you — so two writers serialize instead of clobbering.

```ts
const report = await ablo.weatherReports.retrieve({ id: reportId });
if (!report) return;

await using claim = await ablo.weatherReports.claim({
  id: reportId,
  wait: false,
  action: 'forecasting',
});
const claimed = claim.data;
await ablo.weatherReports.update({
  id: claimed.id,
  data: { status: 'ready', forecast: await getForecast(claimed) },
  wait: 'confirmed',
});
```

Use AI SDK for the model loop. Put Ablo inside the tool that persists the final
change.

```ts
const completeReport = tool({
  description: 'Mark a weather report ready with a forecast',
  inputSchema: z.object({
    reportId: z.string(),
    forecast: z.string(),
  }),
  execute: async ({ reportId, forecast }) => {
    const snap = ablo.snapshot({ weatherReports: reportId });
    return ablo.weatherReports.update({
      id: reportId,
      data: { status: 'ready', forecast },
      readAt: snap.stamp,
      onStale: 'reject',
      wait: 'confirmed',
    });
  },
});
```

Keep agent writes on the same schema client surface as the app.

## Optional Surface

| Optional piece                            | Why it exists                                                     |
| ----------------------------------------- | ----------------------------------------------------------------- |
| `/react`                                  | Live React selectors, provider lifecycle, presence, sync status.  |
| `/testing`                                | Test harnesses and deterministic mocks.                           |
| `Data Source`                             | Keep your app database canonical.                                 |
| `persistence: 'indexeddb'`                | Durable browser cache that survives reloads, for apps that need it. |
| `claim` / `claim.state` / `claim.queue`          | Show active work and coordinate before a write.                   |
| `snapshot` + `readAt`                     | Reject writes based on stale state.                               |
| `mutable`, `readOnly`, `field`, `indexed` | Advanced schema and read tuning.                                  |

The first integration should not need most of these. Start with schema and
model methods, then add the optional pieces where the product actually needs
them.

## Method Cheatsheet

| Method                       | Use it for                                                                  |
| ---------------------------- | --------------------------------------------------------------------------- |
| `retrieve(id)`               | Async read of one row from the server (await it).                           |
| `list({ where })`           | Async read of many rows from the server (await it).                         |
| `get(id)`                    | Synchronous local read of one synced row (use in render).                   |
| `getAll({ where })`         | Synchronous local read of many synced rows.                                 |
| `getCount({ where })`       | Synchronous local count of synced rows.                                     |
| `create(data, options?)`     | Create through the model client.                                            |
| `update(id, data, options?)` | Update through the model client.                                            |
| `delete(id, options?)`       | Delete through the model client.                                            |
| `claim.state({ id })`            | See who is currently working on a row (synchronous).                       |
| `claim(id, work, options?)`  | Wait for your turn, re-read, and hold the row while `work` runs.            |

Keep first integrations on the model methods above.
