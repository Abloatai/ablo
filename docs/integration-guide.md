# Integration Guide

Use this guide when you are adding Ablo to a real product, not a demo.

## Why Ablo, before the API

Ablo is a sync engine designed from the ground up for **humans and AI
agents editing the same state at the same time**. That premise drives
every design choice in this guide; if you only need server-to-server
data syncing without agents in the loop, the trade-offs land elsewhere
(Replicache, ElectricSQL, PowerSync are good answers for human-only
real-time apps; Zero is a good answer for query-shaped sync).

The shape of the SDK reflects three commitments:

- **One model API for every actor.** `ablo.<model>.update(...)` is what
  React components, server actions, background workers, and AI agents
  all call. No separate "agent SDK," no parallel mutation path. The
  attribution comes from the credential, not the call site.
- **Server owns the scope convention; client picks a subset by id.** The
  `org:` / `user:` / `team:` (or your own `region:` / `customer:`)
  prefixes live in the schema's `identityRoles` once, never typed by
  consumer code. Same boundary Liveblocks (`prepareSession`), PowerSync
  (named streams), and Zero (synced queries) settled on after the same
  realization: clients that compose scope strings drift; servers that
  derive scope from authed identity don't.
- **Capabilities, not API keys, are how agents authenticate.** Static
  API keys protect server-to-server humans. Agents get per-run,
  per-scope, leased credentials with per-request signature verification
  and instant revocation. The 2025-2026 AI-agent auth consensus
  (OAuth 2.1 / MCP, AWS STS, Vault leases, Auth0 Token Vault) converged
  on this shape. Capabilities are Ablo's instance.

If you have already built a sync layer or an agent runtime, you know
what each of those costs. This guide assumes you want them solved once,
together, behind one client.

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
schema -> ablo.<model>.load(...) -> ablo.<model>.update(...)
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
offline-heavy local cache behavior.

```ts
// src/ablo.schema.ts
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
    // Identity-anchored sync-group roles. The server walks these to
    // build each participant's allowed subscription set from the
    // resolved identity context. Templates and extractors are fully
    // consumer-controlled — no hardcoded `org:` / `user:` convention
    // anywhere in the engine. Omit `identityRoles` entirely if your
    // schema doesn't need identity-derived scoping.
    identityRoles: [
      {
        kind: 'tenant',
        template: 'org:{id}',
        extract: (i) => (i.organizationId ? [String(i.organizationId)] : []),
      },
      {
        kind: 'participant',
        template: 'user:{id}',
        extract: (i) => (i.userId ? [String(i.userId)] : []),
      },
    ],
  }
);
```

### Declaring scope on a model

Per-row tenancy and per-entity sync-group anchors live on the
`defineModel` (or `model(...)`) options. The two halves compose: the
identity roles above produce a participant's _allowed_ set; the
per-model options below define how rows are filtered server-side and
which sync-group label each row fans out on.

```ts
model(
  {
    /* fields */
  },
  /* relations */ {},
  {
    // Rows carry organization_id and bootstrap filters on it.
    orgScoped: true,

    // Per-entity sync-group anchor. Lets a scoped session narrow into
    // one row's scope via `syncGroupFormat.replace('{id}', rowId)`.
    syncGroupFormat: 'matter:{id}',
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
import { schema } from './ablo.schema';

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
import { schema } from '@/ablo.schema';

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

Use `load` when the row may not already be local.

```ts
await ablo.ready();

const [report] = await ablo.weatherReports.load({ where: { id: 'report_stockholm' } });
if (!report) throw new Error('report not found');
```

Use `retrieve`, `list`, and `count` for synchronous local reads after data has
loaded.

```ts
const report = ablo.weatherReports.retrieve('report_stockholm');
const activeReports = ablo.weatherReports.list({
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
  const report = useAblo((ablo) => ablo.weatherReports.retrieve(serverReport.id)) ?? serverReport;
  const active = useAblo((ablo) => ablo.weatherReports.claimState(serverReport.id));

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
await ablo.weatherReports.update('report_stockholm', { status: 'ready' }, { wait: 'confirmed' });
```

For writes based on state the user or agent already read, snapshot first and
reject stale updates:

```ts
const snap = ablo.snapshot({ weatherReports: 'report_stockholm' });

await ablo.weatherReports.update(
  'report_stockholm',
  { status: 'ready' },
  {
    readAt: snap.stamp,
    onStale: 'reject',
    wait: 'confirmed',
  }
);
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
3. Add `useAblo((ablo) => ablo.weatherReports.retrieve(id)) ?? serverReport` for live rows.
4. Add one Data Source endpoint that calls the existing service layer.
5. Move one mutation button from `fetch('/api/reports/...')` to `ablo.weatherReports.update(...)`.
6. Add an outbox/events path for writes that still happen outside Ablo.
7. Let agents use the same `ablo.weatherReports.load(...)` and `ablo.weatherReports.update(...)`.

For the full Python shape, see
[Existing Python Backend](./examples/existing-python-backend.md).

## 7. Data Source Endpoint

Use a Data Source when your app database remains the source of truth.

```ts
// app/api/ablo/source/route.ts
import { dataSource } from '@abloatai/ablo';
import { schema } from '@/ablo.schema';
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

```ts
const [report] = await ablo.weatherReports.load({ where: { id: reportId } });
if (!report) return;

await ablo.weatherReports.claim(
  reportId,
  async (claimed) => {
    await ablo.weatherReports.update(
      claimed.id,
      { status: 'ready', forecast: await getForecast(claimed) },
      { wait: 'confirmed' }
    );
  },
  { wait: false, action: 'forecasting' }
);
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
    return ablo.weatherReports.update(
      reportId,
      { status: 'ready', forecast },
      { readAt: snap.stamp, onStale: 'reject', wait: 'confirmed' }
    );
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
| `persistence: 'indexeddb'`                | Durable browser cache and offline queueing for apps that need it. |
| `claim` / `claimState` / `queue`          | Show active work and coordinate before a write.                   |
| `snapshot` + `readAt`                     | Reject writes based on stale state.                               |
| `mutable`, `readOnly`, `field`, `indexed` | Advanced schema and local-cache tuning.                           |

The first integration should not need most of these. Start with schema and
model methods, then add the optional pieces where the product actually needs
them.

## Method Cheatsheet

| Method                       | Use it for                                                       |
| ---------------------------- | ---------------------------------------------------------------- |
| `load({ where })`            | Async hydration from backing store/server.                       |
| `retrieve(id)`               | Synchronous local read of one loaded row.                        |
| `list(options?)`             | Synchronous local collection read.                               |
| `count(options?)`            | Synchronous local count.                                         |
| `create(data, options?)`     | Create through the model client.                                  |
| `update(id, data, options?)` | Update through the model client.                                  |
| `delete(id, options?)`       | Delete through the model client.                                  |
| `claimState(id)`             | See active work on a model row.                                  |
| `claim(id, work, options?)`  | Wait for your turn, re-read, and hold the row while `work` runs. |

Keep first integrations on the model methods above.
