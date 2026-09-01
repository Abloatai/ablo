<p align="center">
  <a href="https://abloatai.com"><img src="assets/banner.png" alt="Ablo" width="480" /></a>
</p>

<p align="center">
  <strong>Coordination infrastructure for agents, applications, services, and people working on shared state.</strong>
</p>

<p align="center">
  <a href="https://docs.abloatai.com">Docs</a> &nbsp;|&nbsp;
  <a href="https://docs.abloatai.com/installation">Installation</a> &nbsp;|&nbsp;
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

Ablo is coordination infrastructure for agents, applications, services, and
people working on shared state.

Every write goes through it, so authority, idempotency, conflicts, ordering,
and confirmation are enforced in one place. Your Postgres remains the source of
truth.

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
npx ablo dev
```

`ablo dev` prepares an isolated Ablo branch for your Git branch, writes its
temporary credential to gitignored `.env.local`, pushes the schema, and watches
for changes.

Read and write through one typed API:

```ts
const order = await ablo.orders.read({ id: orderId });

if (!order) throw new Error('Order not found');
await ablo.orders.update({
  id: order.id,
  data: { status: 'approved' },
  reads: [order],
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
});
```

Another actor touching the same work waits fairly and receives fresh state when
its turn begins. If the agent fails, the claim releases automatically. If its
context became stale, the write is rejected instead of silently overwriting
work it never saw.

If you use AI SDK, expose the same operation as a typed model tool:

```ts
import { updateTool } from '@abloatai/ablo/ai-sdk';

const approveOrder = updateTool(ablo.orders, {
  description: 'Approve an order after reviewing it.',
  inputSchema: z.object({ orderId: z.string() }),
  id: ({ orderId }) => orderId,
  apply: () => ({ status: 'approved' }),
});
```

Ablo supplies `readTool`, `createTool`, `updateTool`, and `deleteTool` over the
same authoritative resources. AI SDK keeps ownership of the model loop and tool
execution.

For a model call that needs several reads plus application-owned retrieval or
memory, [`context()`](./docs/context.md) awaits the selected values and carries
the exact Ablo rows into the write's `reads` option. It does not add search,
memory, or a model runtime.

Use `@abloatai/ablo` for agents and backend code,
`@abloatai/ablo/client` for live applications, and
`@abloatai/ablo/react` for React. All entrypoints share the same schema,
authority, commits, claims, and ordered changes.

Read the [Quickstart](https://docs.abloatai.com/quickstart), browse
[docs.abloatai.com](https://docs.abloatai.com), or run `npx ablo docs`.

## Navigating the source

This repository preserves the package ownership boundaries instead of
flattening the implementation into `packages/ablo`:

- `packages/ablo` is the branded public facade. Its files mostly re-export the
  package that owns each API.
- `packages/transaction` owns the shared model-operation contracts and the
  headless HTTP/WebSocket transport implementation.
- `packages/humans` owns the reactive WebSocket/local/React implementation.

That means searching only inside `packages/ablo/src` will not find the
implementation of `create`, `update`, `delete`, or `claim`. Read the
**[source code map](./CODEMAP.md)** for a verb-by-verb ownership table and
guided call traces for both the default and reactive clients.

## Contributing

Ablo is free and open source. You can help by
[opening an issue](https://github.com/Abloatai/ablo/issues),
[suggesting a feature](https://github.com/Abloatai/ablo/issues/new), or
[contributing code](https://github.com/Abloatai/ablo/pulls).

Please report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/Abloatai/ablo/security/advisories/new).

## License

Apache License 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
