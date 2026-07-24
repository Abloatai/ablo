<p align="center">
  <a href="https://abloatai.com"><img src="assets/banner.png" alt="Ablo" width="480" /></a>
</p>

<p align="center">
  <strong>Collaboration infrastructure for AI agents.</strong>
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

Every write to your data, whether it comes from a person, a server, or an agent,
arrives coordinated with the others and stays attributed afterward.

We as humasn work on the same things by looking and talking. You see someone's cursor in
the paragraph, so you wait, or you say you'll take the first half. None of that
is in the software. It's just what people do, and the software only has to show
them enough to do it.

Agents have neither. Two of them read the same row, think for thirty seconds,
and the second one writes over the first, and nobody finds out. The writes
aren't even the main part: an agent acts on what it read, so if any of it moved
while it was thinking, it does the wrong thing without colliding with anyone at
all. That probably doesn't get better as the models get better.

```ts
// Two agents reprice the same order. One gets it at a time.
await using claim = await ablo.orders.claim({ id: orderId });

const order = claim.data;                    // the current row, not the one you read a minute ago
const priced = await pricingAgent(order);    // slow: an LLM call, a vendor API

await ablo.orders.update({
  id: order.id,
  data: { total: priced.total, discount: priced.discount, status: 'repriced' },
  claim,
});
```

The second agent waits its turn, then gets handed the order as it now stands. If
the pricing call throws, the row frees on the way out, unchanged. A person
editing that order in the UI is in the same line as the agents.

And the write it eventually makes is signed:

```ts
{
  actorKind:         'agent',      // 'user' | 'agent' | 'system'
  actorId:           'agent_pricing',
  onBehalfOfKind:    'user',
  onBehalfOfId:      'user_amir',  // the person the agent acted for
  capabilityId:      'key_live_ops',
  confirmationState: 'approved',   // ran on its own, was previewed, or was signed off
}
```

Every committed change lands in an audit log carrying that attribution, chained
with a keyed hash so any later alteration shows up. You write none of it.

- **Coordination.** Claims, a fair queue, and stale-write rejection, so slow agent work can't land on a moved row.
- **Realtime.** Every confirmed change reaches every connected client, agent or human, with no separate multiplayer mode to enable.
- **Your database and your auth stay yours.** Rows live in your Postgres under your own security policies; Ablo runs no migrations and owns no schema. Bring Clerk, Auth0, NextAuth, whatever you have.
- **A history you can answer questions from.** Who changed what, on whose behalf, with which key, and whether a human approved it.

## Start

```bash
npm install @abloatai/ablo
npx ablo login     # sign in; saves a test key
npx ablo init      # scaffolds your schema
npx ablo push      # writes ABLO_API_KEY to .env.local, and you're running
```

Point it at your own Postgres when you're ready with `npx ablo connect`.

## Docs

```bash
npx ablo docs             # every page, for the version you installed
npx ablo docs audit       # or any one of them
```

Those pages ship inside the package, so they match your install and need no
network. The same pages are at [docs.abloatai.com](https://docs.abloatai.com).

Building with a coding agent? Point it at `node_modules/@abloatai/ablo/llms.txt`.

Start with [Quickstart](./docs/quickstart.md) ·
[Integration Guide](./docs/integration-guide.md) ·
[Coordination](./docs/coordination.md) ·
[Audit log](./docs/audit.md) ·
[Connect your database](./docs/data-sources.md) ·
[Guarantees](./docs/guarantees.md) ·
[Migration](./docs/migration.md)

## License

Apache License 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
