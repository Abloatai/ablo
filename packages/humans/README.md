<p align="center">
  <a href="https://abloatai.com">
    <img src="https://raw.githubusercontent.com/Abloatai/ablo/main/assets/banner.png" alt="Ablo" width="480" />
  </a>
</p>

# @abloatai/humans

The interactive local-state runtime behind Ablo applications.

It turns Ablo's ordered transaction stream into WebSocket-backed local state
with optimistic updates, rollback, object identity, persistence, presence,
live queries, MobX integration, and React bindings.

Application code should install the branded Ablo SDK:

```sh
npm install @abloatai/ablo
```

For a live client:

```ts
import { Ablo } from '@abloatai/ablo/client';

const ablo = Ablo({
  schema,
  authEndpoint: '/api/ablo-session',
});

await ablo.ready();

const order = ablo.orders.local.get(orderId);
```

For React:

```tsx
import { AbloProvider, useAblo } from '@abloatai/ablo/react';
```

Use `@abloatai/humans` directly only when building Ablo client plugins or
framework integrations. Normal applications use `@abloatai/ablo/client` and
`@abloatai/ablo/react`, which delegate to this package.

## Links

- [Documentation](https://docs.abloatai.com)
- [Quickstart](https://docs.abloatai.com/quickstart)
- [API reference](https://docs.abloatai.com/api)
- [Source](https://github.com/Abloatai/ablo/tree/main/packages/humans)
- [Apache-2.0 license](https://github.com/Abloatai/ablo/blob/main/LICENSE)
