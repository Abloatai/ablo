<p align="center">
  <a href="https://abloatai.com">
    <img src="https://raw.githubusercontent.com/Abloatai/ablo/main/assets/banner.png" alt="Ablo" width="480" />
  </a>
</p>

# @abloatai/transaction

The canonical transaction contracts and headless HTTP runtime behind Ablo.

Authoritative reads, atomic commits, idempotency, confirmation, claims, and
durable observation share one typed protocol here. The package has no React,
MobX, IndexedDB, or WebSocket runtime.

Application code should install the branded Ablo SDK:

```sh
npm install @abloatai/ablo
```

```ts
import { Ablo } from '@abloatai/ablo';

const ablo = Ablo({
  schema,
  apiKey: process.env.ABLO_API_KEY,
});

const order = await ablo.orders.read({ id: orderId });
if (!order) throw new Error('Order not found');

await ablo.orders.update({
  id: orderId,
  data: { status: 'approved' },
  reads: [order],
});
```

Use `@abloatai/transaction` directly only when building Ablo adapters,
integrations, or infrastructure that must consume the canonical contracts.
The branded SDK delegates to this package without exposing that ownership map
in normal application imports.

## Links

- [Documentation](https://docs.abloatai.com)
- [Quickstart](https://docs.abloatai.com/quickstart)
- [API reference](https://docs.abloatai.com/api)
- [Source](https://github.com/Abloatai/ablo/tree/main/packages/transaction)
- [Apache-2.0 license](https://github.com/Abloatai/ablo/blob/main/LICENSE)
