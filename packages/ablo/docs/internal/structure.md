# Repository Structure

For a verb-by-verb guide to declarations and implementations—including exactly
where `create`, `update`, `delete`, and `claim` live—read the public
[`CODEMAP.md`](../../CODEMAP.md).

The public repository preserves the same ownership boundaries as the main
monorepo. `@abloatai/ablo` is the product package; the packages beneath it are
implementation owners and first-party extension surfaces.

| Workspace | Responsibility |
| --- | --- |
| `packages/ablo` | Branded SDK, public entrypoints, docs, examples, release assets |
| `packages/transaction` | Headless HTTP client, canonical contracts, reads, commits, settlement, claims, durable observation |
| `packages/humans` | Reactive materializer, WebSocket transport, presence, browser persistence, React |
| `packages/agent` | Agent behavior, perception, and coordination helpers |
| `packages/cli` | Project setup, database connection, schema operations, and diagnostics |
| `packages/tsconfig` | Private shared compiler configuration |

Applications install and import `@abloatai/ablo`. The root entrypoint is the
headless HTTP API. Human-facing reactive behavior is explicit:

```ts
import Ablo from '@abloatai/ablo';
import ReactiveAblo from '@abloatai/ablo/client';
import { AbloProvider, useAblo } from '@abloatai/ablo/react';
```

The backend implementation remains in `apps/sync-server` in the private
monorepo. It consumes transaction contracts but is not part of the public SDK
repository.

Internal packages must not import the branded facade. Dependencies point from
the facade to the owners, from humans and agents to transaction, and never back
upward. The public mirror copies these workspaces as workspaces; it does not
flatten them or generate compatibility source.
