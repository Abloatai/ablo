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

Ablo is a TypeScript framework for applications where AI agents, people, and
backend services work on the same data. It gives every actor one typed API for
reading, changing, coordinating, and observing shared state—while your
Postgres remains the source of truth.

Use Ablo when several actors can touch the same orders, tasks, documents,
financial models, customer records, or workflows. It keeps their work from
silently overwriting each other, makes retries safe, confirms what actually
reached your database, and preserves who acted and on whose behalf.

## Why Ablo

Most application infrastructure was designed around short requests from one
human at a time. Agents work differently. They read state, reason for seconds
or minutes, call other systems, delegate work, retry after failures, and often
run beside other agents and people.

A database can make a write atomic, but it does not know that an agent is still
reasoning about an old version of a row. A realtime feed can show the latest
state, but it does not decide who should act next. A queue can serialize jobs,
but it does not coordinate them with the person editing the same record.

Ablo brings those concerns together:

- **Claims and stale-context checks** coordinate slow work before it lands.
- **Atomic, idempotent commits** make timeouts and retries safe.
- **Authoritative confirmation** tells you when your database accepted a
  change—not only when an API accepted the request.
- **Typed capabilities** bound what a human, agent, or service may do.
- **Realtime and durable observation** serve both interactive applications and
  headless workers.
- **Attribution and audit evidence** retain who acted, for whom, and with which
  authority.

The result is one coordination model for the whole application instead of a
separate agent write path, multiplayer path, and backend path.

## Get started

```sh
npm install @abloatai/ablo
npx ablo init
npx ablo push
```

When work takes time, claim the row before acting on it:

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
  wait: 'confirmed',
});
```

If the agent fails, the claim releases automatically. If another actor changed
the order first, Ablo rejects the stale work instead of overwriting state the
agent never saw. If the connection drops, the commit can be retried safely.

Claims can cover a whole row or only the fields involved. That lets a pricing
agent change `total` while a fulfillment agent changes `status` on the same
order without making unrelated work wait.

## One SDK for every actor

Use the root package for agents, services, jobs, and server actions:

```ts
import Ablo from '@abloatai/ablo';
```

Use the client entrypoint for browser applications with live local state,
optimistic interaction, persistence, and presence:

```ts
import Ablo from '@abloatai/ablo/client';
```

React bindings are available from `@abloatai/ablo/react`. All three entrypoints
use the same schema, authority, commits, claims, settlement, and ordered
changes. Realtime synchronization is part of Ablo, but it is not the product
boundary: applications can use Ablo with or without a connected UI.

## Your data stays yours

Ablo works with the Postgres database and authentication system you already
use. Your database holds the rows, your migration tool owns the schema, and
your security policies remain in force. Ablo coordinates changes and keeps the
evidence around them; it does not require you to move application state into a
replacement database.

## Documentation

The full documentation ships with the package, so it matches the version you
installed and remains available offline:

```sh
npx ablo docs
npx ablo docs coordination
```

The same guides are available at
[docs.abloatai.com](https://docs.abloatai.com). Start with the
[Quickstart](./docs/quickstart.md), [How it works](./docs/how-it-works.md),
[Coordination](./docs/coordination.md), and
[Guarantees](./docs/guarantees.md).

Building with a coding agent? Point it at
`node_modules/@abloatai/ablo/llms.txt`.

## Contributing

Ablo is free and open source. You can help by
[opening an issue](https://github.com/Abloatai/ablo/issues),
[suggesting a feature](https://github.com/Abloatai/ablo/issues/new), or
[contributing code](https://github.com/Abloatai/ablo/pulls).

## Security

Please report security vulnerabilities privately through
[GitHub Security Advisories](https://github.com/Abloatai/ablo/security/advisories/new)
rather than opening a public issue.

## License

Apache License 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
