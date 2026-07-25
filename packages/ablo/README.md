<p align="center">
  <a href="https://abloatai.com"><img src="assets/banner.png" alt="Ablo" width="480" /></a>
</p>

<p align="center">
  <strong>Transaction and coordination infrastructure for humans, agents, and backend systems.</strong>
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

Install the public SDK:

```sh
npm install @abloatai/ablo
```

Use the root package for headless agents, services, jobs, and backend code:

```ts
import { Ablo } from '@abloatai/ablo';

const ablo = Ablo({ schema, apiKey: process.env.ABLO_API_KEY });
await ablo.orders.update({
  id: orderId,
  data: { status: 'approved' },
});
```

Use the client entrypoint for a WebSocket-backed reactive application:

```ts
import { Ablo } from '@abloatai/ablo/client';

const ablo = Ablo({ schema, authEndpoint: '/api/ablo-session' });
await ablo.ready();
```

React bindings are available from `@abloatai/ablo/react`.

The repository keeps implementation ownership explicit:

```text
packages/ablo         branded SDK users install
packages/transaction  HTTP, contracts, commits, claims, settlement, observation
packages/humans       WebSocket, local materialization, presence, MobX, React
packages/agent        agent behavior and perception
packages/cli          project and operational tooling
```

Realtime synchronization is a consumer of the transaction layer, not a second
authority path. Humans, agents, and backend services use the same commit,
idempotency, claim, fencing, settlement, and ordered-observation contracts.
