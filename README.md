<p align="center">
  <a href="https://abloatai.com"><img src="assets/banner.png" alt="Ablo" width="480" /></a>
</p>

<p align="center">
  <strong>The transaction layer for AI agents.</strong>
</p>

<p align="center">
  <a href="https://docs.abloatai.com">Docs</a> &nbsp;|&nbsp;
  <a href="https://docs.abloatai.com/quickstart">Quickstart</a> &nbsp;|&nbsp;
  <a href="https://docs.abloatai.com/api">API</a> &nbsp;|&nbsp;
  <a href="https://github.com/Abloatai/ablo">GitHub</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@abloatai/ablo"><img src="https://img.shields.io/npm/v/@abloatai/ablo?style=flat-square&color=2563eb" alt="npm" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-2563eb?style=flat-square" alt="license" /></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A524-22c55e?style=flat-square" alt="node >=24" />
  <img src="https://img.shields.io/badge/types-included-2563eb?style=flat-square" alt="types included" />
</p>

---

Safely coordinate AI agents, humans, workflows, and services writing to the
same database.

Ablo is an authoritative transaction layer for shared application state. Every
write goes through one typed API where authority, idempotency, conflicts,
ordering, and confirmation can be enforced. Your Postgres remains the source
of truth.

## Why Ablo

Software used to have one writer: a human clicking through an application. AI
applications now have humans, agents, workflows, and services acting
concurrently. Databases keep transactions consistent. They do not coordinate
autonomous work that reads now, reasons for thirty seconds, and writes later.

Humans handle this naturally. We see that somebody is editing, agree on who
takes which part, wait our turn, and look again before continuing. Ablo gives
software actors those same capabilities: bounded authority, shared ownership,
fresh context, safe handoffs, and an attributed record of what happened.

## Start

```sh
npm install @abloatai/ablo
npx ablo init
npx ablo push
```

Read and write through the transaction layer:

```ts
const order = await ablo.orders.get({ id: orderId });

if (!order) throw new Error('Order not found');
await ablo.orders.update({
  id: order.id,
  data: { status: 'approved' },
  wait: 'confirmed',
});
```

`confirmed` means the authoritative database reported the change back. The
same commit can be retried safely if the caller loses its connection.

When work takes thirty seconds instead of one request, coordinate before the
agent starts reasoning:

```ts
await using claim = await ablo.orders.claim({ id: orderId });

const priced = await pricingAgent(claim.data);

await ablo.orders.update({
  id: claim.data.id,
  data: { total: priced.total, status: 'repriced' },
  claim,
  wait: 'confirmed',
});
```

Another actor touching the same work waits fairly and receives fresh state when
its turn begins. If the agent fails, the claim releases automatically. If its
context became stale, the write is rejected instead of silently overwriting
work it never saw.

Use `@abloatai/ablo` for agents and backend code,
`@abloatai/ablo/client` for live applications, and
`@abloatai/ablo/react` for React. All entrypoints share the same schema,
authority, commits, claims, and ordered changes.

Read the [Quickstart](./docs/quickstart.md), browse
[docs.abloatai.com](https://docs.abloatai.com), or run `npx ablo docs`.

## Contributing

Ablo is free and open source. You can help by
[opening an issue](https://github.com/Abloatai/ablo/issues),
[suggesting a feature](https://github.com/Abloatai/ablo/issues/new), or
[contributing code](https://github.com/Abloatai/ablo/pulls).

Please report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/Abloatai/ablo/security/advisories/new).

## License

Apache License 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
