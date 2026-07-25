<p align="center">
  <a href="https://abloatai.com"><img src="assets/banner.png" alt="Ablo" width="480" /></a>
</p>

<p align="center">
  <strong>Coordination infrastructure for humans, agents, and backend systems.</strong>
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

Every write to your data—whether it comes from a person, a server, or an
agent—arrives coordinated with the others and stays attributable afterward.

Humans coordinate naturally. We see who is editing, talk about ownership, and
wait when somebody else is already changing the same thing. Agents and
background jobs do not have that shared awareness. Two workers can read the
same row, spend thirty seconds reasoning, and then silently overwrite each
other. A retry after a timeout can perform the same action twice. A write can
return successfully before the database that matters has confirmed it.

Ablo puts one typed transaction and coordination layer in front of that shared
state:

- **Safe concurrent work.** Claims, fair queues, field-level coordination, and
  stale-context rejection keep slow work from landing on state it did not see.
- **Idempotent transactions.** Atomic commits and durable receipts make retries
  safe across timeouts, process restarts, and network failures.
- **Authoritative settlement.** A write can wait until your customer-owned
  Postgres confirms it, rather than treating an intermediate `200 OK` as truth.
- **One path for every actor.** Human applications, AI agents, services, and
  jobs use the same reads, writes, authority, ordering, and conflict rules.
- **Realtime and durable observation.** Interactive clients receive live
  updates, while headless consumers can resume an ordered feed from a cursor.
- **Attribution and evidence.** Changes retain who acted, on whose behalf, with
  which authority, and whether human confirmation was involved.

Your application data remains in your Postgres under your schema and security
policies. Ablo coordinates writes, confirms them from the authoritative
database stream, and records the evidence around them. It does not require a
second application database or take ownership of your migrations.

## Coordinate slow agent work

Two agents can reprice the same order without racing. The second waits its
turn, then receives the order as it exists after the first finishes:

```ts
await using claim = await ablo.orders.claim({ id: orderId });

const order = claim.data;
const priced = await pricingAgent(order);

await ablo.orders.update({
  id: order.id,
  data: {
    total: priced.total,
    discount: priced.discount,
    status: 'repriced',
  },
  claim,
});
```

If the agent call throws, the claim releases when the scope exits. If another
actor changed the order before this work could land, Ablo rejects the stale
write instead of silently overwriting unseen state.

Claims can be as narrow as the work. A pricing agent can hold `total` and
`discount` while a fulfillment agent changes `status` on the same order:

```ts
await using pricing = await ablo.orders.claim({
  id: orderId,
  fields: (order) => [order.total, order.discount],
});

await using fulfillment = await ablo.orders.claim({
  id: orderId,
  fields: (order) => order.status,
});
```

Disjoint fields proceed concurrently; overlapping claims take turns.

## Start

```sh
npm install @abloatai/ablo
npx ablo init
npx ablo push
```

Declare the models Ablo should coordinate:

```ts
// ablo/schema.ts
import { defineSchema, model, z } from '@abloatai/ablo/schema';

export const schema = defineSchema({
  orders: model({
    status: z.enum(['pending', 'approved', 'fulfilled']),
    total: z.number(),
    discount: z.number(),
  }),
});
```

Use the root package in agents, services, jobs, server actions, and other
headless runtimes:

```ts
import Ablo from '@abloatai/ablo';
import { schema } from './ablo/schema';

const ablo = Ablo({
  schema,
  apiKey: process.env.ABLO_API_KEY,
});

const order = await ablo.orders.get({ id: orderId });

await ablo.orders.update({
  id: orderId,
  data: { status: 'approved' },
  wait: 'confirmed',
});
```

`wait: 'confirmed'` resolves after the authoritative data source confirms the
change. Durable receipts and idempotency keep the operation recoverable if the
caller loses its connection while the write is in flight.

For a browser application, use the client entrypoint. It adds WebSocket-backed
local state, optimistic interaction, presence, persistence, and live queries
over the same transaction contract:

```ts
import Ablo from '@abloatai/ablo/client';
import { schema } from './ablo/schema';

const ablo = Ablo({
  schema,
  authEndpoint: '/api/ablo-session',
});

await ablo.ready();

const order = ablo.orders.local.get(orderId);
```

React bindings are available from `@abloatai/ablo/react`.

## How the write path works

```text
human application / agent / backend service
                     |
                     v
          authorized, idempotent commit
                     |
                     v
       claims · conflict checks · settlement
                     |
                     v
       your Postgres + authoritative confirmation
                     |
                     v
          ordered observation and live views
```

Ablo is more than a synchronization library. Realtime materialization is one
way to consume the ordered transaction stream. The underlying product is the
authority and coordination boundary that makes shared work safe whether or not
a UI is connected.

## What a committed change carries

A committed change can be traced to the model and row it affected, the human,
agent, or system that performed it, the principal it acted for, the capability
that authorized it, and its confirmation state. This makes questions such as
“who changed this?”, “was it delegated?”, and “did the database confirm it?”
answerable without building a parallel attribution system in every application.

## Bring your own database and auth

Run `npx ablo connect` when you are ready to use your Postgres. Ablo uses
separate, scoped roles for applying writes and observing confirmation. Your
database remains the source of truth, your migration tool owns the schema, and
your existing row-level security remains part of the enforcement boundary.

Ablo also works with your existing identity provider. Browser sessions receive
short-lived, bounded credentials from your backend; server processes use
server-side keys. Both are checked through the same capability vocabulary at
the commit boundary.

## Docs

```sh
npx ablo docs
npx ablo docs coordination
```

The documentation ships with the installed package, so it matches the version
you are running and works without a network connection. The same pages are
available at [docs.abloatai.com](https://docs.abloatai.com).

Building with a coding agent? Point it at
`node_modules/@abloatai/ablo/llms.txt`.

Start with [Quickstart](./docs/quickstart.md) ·
[How it works](./docs/how-it-works.md) ·
[Integration guide](./docs/integration-guide.md) ·
[Coordination](./docs/coordination.md) ·
[Audit log](./docs/audit.md) ·
[Connect your database](./docs/data-sources.md) ·
[Guarantees](./docs/guarantees.md)

## License

Apache License 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
