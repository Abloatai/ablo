# Ablo source code map

This is the entry point for reading the source in `github.com/Abloatai/ablo`.
It answers two questions:

1. Which package owns a public API?
2. Where is a verb such as `create`, `delete`, or `claim` declared and
   implemented?

## The essential distinction

`packages/ablo` is the branded facade, not a second implementation of the SDK.
For example, its root
[`src/index.ts`](https://github.com/Abloatai/ablo/blob/main/packages/ablo/src/index.ts)
re-exports `@abloatai/transaction`, and its
[`src/client.ts`](https://github.com/Abloatai/ablo/blob/main/packages/ablo/src/client.ts)
re-exports `@abloatai/humans`.

```text
@abloatai/ablo              packages/ablo       public names and subpaths
       |
       +-- default --------> packages/transaction  stateless HTTP client
       |
       +-- /client, /react -> packages/humans      reactive client + React
```

If a public method appears to have no implementation in `packages/ablo/src`,
follow the re-export to its owner below.

## Which client are you reading?

| Application import | Client | Composition root |
| --- | --- | --- |
| `import { Ablo } from '@abloatai/ablo'` | Stateless HTTP client for agents, workers, cron jobs, and route handlers | [`packages/transaction/src/ablo.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/ablo.ts) |
| `import Ablo from '@abloatai/ablo/client'` | Reactive client with WebSocket sync, a local graph, presence, offline persistence, and optimistic writes | [`packages/humans/src/Ablo.ts`](https://github.com/Abloatai/ablo/blob/main/packages/humans/src/Ablo.ts) |
| `import { AbloProvider, useAblo } from '@abloatai/ablo/react'` | React bindings over the reactive client | [`packages/humans/src/react`](https://github.com/Abloatai/ablo/tree/main/packages/humans/src/react) |

Both clients expose the same base `ablo.<model>` vocabulary. They share the
request types, but each runtime implements those operations according to its
transport.

## Model operations: declaration and implementation

The example below refers to calls such as:

```ts
await ablo.tasks.get({ id });
await ablo.tasks.list({ where: { status: 'open' } });
await ablo.tasks.create({ data: { title: 'Review' } });
await ablo.tasks.update({ id, data: { status: 'done' } });
await ablo.tasks.delete({ id });
await ablo.tasks.claim({ id });
```

| Public surface | Canonical declaration | Stateless HTTP implementation | Reactive implementation |
| --- | --- | --- | --- |
| `get`, `list` | `HttpModelClient` in [`transport/httpClient.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/transport/httpClient.ts); option types in [`resources/modelOperations.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/resources/modelOperations.ts) | Typed adapter in `createHttpModelClient`, then requests in [`transport/httpTransport.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/transport/httpTransport.ts) | `load`, `get`, and `local` inside [`createModelProxy.ts`](https://github.com/Abloatai/ablo/blob/main/packages/humans/src/local/client/createModelProxy.ts) |
| `create` | `HttpModelClient.create` plus `ModelCreateParams` in the same two declaration files above | `createHttpModelClient` unwraps the result; `httpTransport.model(name).create` sends the mutation | `operations.create` in [`createModelProxy.ts`](https://github.com/Abloatai/ablo/blob/main/packages/humans/src/local/client/createModelProxy.ts), then the mutation queue |
| `update` | `HttpModelClient.update` plus `ModelUpdateParams`; functional-update policy is in [`resources/functionalUpdate.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/resources/functionalUpdate.ts) | `createHttpModelClient.update` adapts the public result; `httpTransport.model(name).update` sends the mutation or reconcile loop | `operations.update` in [`createModelProxy.ts`](https://github.com/Abloatai/ablo/blob/main/packages/humans/src/local/client/createModelProxy.ts), then `SyncClient.update` and the mutation queue |
| `delete` | `HttpModelClient.delete` plus `ModelDeleteParams` | `createHttpModelClient.delete` delegates to `httpTransport.model(name).delete` | `operations.delete` in [`createModelProxy.ts`](https://github.com/Abloatai/ablo/blob/main/packages/humans/src/local/client/createModelProxy.ts), then `SyncClient.delete` and the mutation queue |
| `claim`, `claim.state`, `claim.queue`, `claim.release`, `claim.reorder` | `ClaimApi`, `ClaimReadApi`, `ClaimParams`, and related types in [`resources/modelOperations.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/resources/modelOperations.ts); the awaited HTTP projection is `HttpClaimApi` in [`resources/httpResources.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/resources/httpResources.ts) | Claim acquisition and the callable claim namespace are assembled in [`transport/httpTransport.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/transport/httpTransport.ts) | `takeClaim`, `claimReaders`, and `claimApi` in [`createModelProxy.ts`](https://github.com/Abloatai/ablo/blob/main/packages/humans/src/local/client/createModelProxy.ts) |
| `track` | `ModelTrackParams` and `ModelTrackResult` in [`resources/modelOperations.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/resources/modelOperations.ts) | `httpTransport.model(name).track` | `operations.track` in [`createModelProxy.ts`](https://github.com/Abloatai/ablo/blob/main/packages/humans/src/local/client/createModelProxy.ts) |
| `local.get`, `local.list`, `local.count` | `LocalReads` in [`createModelProxy.ts`](https://github.com/Abloatai/ablo/blob/main/packages/humans/src/local/client/createModelProxy.ts) | Not available: a stateless client has no local graph | The `local` object in that same file |
| `join`, `onChange` | Reactive surface in [`createModelProxy.ts`](https://github.com/Abloatai/ablo/blob/main/packages/humans/src/local/client/createModelProxy.ts) | Not available: these require a persistent connection/local graph | `operations.join` and `operations.onChange` in that same file |

The canonical input shapes deliberately live in `packages/transaction`, even
for the reactive client. `packages/humans` binds those shared contracts to a
local graph; it does not redeclare them.

## Follow `create` end to end

For the default HTTP client:

```text
packages/ablo/src/index.ts
  re-exports Ablo
    -> packages/transaction/src/ablo.ts
       constructs the client
    -> packages/transaction/src/transport/httpClient.ts
       creates a typed model proxy and adapts create's result
    -> packages/transaction/src/transport/httpTransport.ts
       encodes and sends the HTTP mutation
    -> Ablo server (not part of this public SDK repository)
```

For the reactive client:

```text
packages/ablo/src/client.ts
  re-exports the humans client
    -> packages/humans/src/Ablo.ts
       composes the runtime
    -> packages/humans/src/local/client/reactiveEngine.ts
       constructs one model proxy per schema model
    -> packages/humans/src/local/client/createModelProxy.ts
       implements create/update/delete/claim/get/list
    -> packages/humans/src/local/SyncClient.ts + mutation queue
       sends and confirms the change
```

## Other public API owners

| Concern | Canonical owner |
| --- | --- |
| `Ablo()` and stateless client type | [`packages/transaction/src/ablo.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/ablo.ts) and [`transport/httpClient.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/transport/httpClient.ts) |
| Reactive `Ablo()` and client type | [`packages/humans/src/Ablo.ts`](https://github.com/Abloatai/ablo/blob/main/packages/humans/src/Ablo.ts) and [`client.ts`](https://github.com/Abloatai/ablo/blob/main/packages/humans/src/client.ts) |
| Atomic `commits.create` resource | Contract in [`resources/httpResources.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/resources/httpResources.ts), wire schema in [`wire/commit.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/wire/commit.ts), HTTP runtime in [`transport/httpTransport.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/transport/httpTransport.ts) |
| Claim target and wire schemas | [`coordination/schema.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/coordination/schema.ts) and [`coordination/locator.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/coordination/locator.ts) |
| Claim heartbeat behavior | [`coordination/claimHeartbeatLoop.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/coordination/claimHeartbeatLoop.ts) |
| Schema DSL (`defineSchema`, `model`, fields, relations) | [`packages/transaction/src/schema`](https://github.com/Abloatai/ablo/tree/main/packages/transaction/src/schema) |
| Capabilities and scoped sessions | [`auth/capability.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/auth/capability.ts), [`auth/sessionMint.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/auth/sessionMint.ts), and resource types in `httpResources.ts` |
| Errors and recovery metadata | [`errors.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/errors.ts) and [`errorCodes.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/errorCodes.ts) |
| Durable observation and log pages | [`transactionLayer.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/transactionLayer.ts), [`transport/httpFeed.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/transport/httpFeed.ts), and `HttpLogsResource` in `httpResources.ts` |
| AI SDK model tools | [`packages/transaction/src/ai-sdk`](https://github.com/Abloatai/ablo/tree/main/packages/transaction/src/ai-sdk) |
| React provider and hooks | [`packages/humans/src/react`](https://github.com/Abloatai/ablo/tree/main/packages/humans/src/react) |
| CLI commands | [`packages/cli/src`](https://github.com/Abloatai/ablo/tree/main/packages/cli/src) |

## Public facade subpaths

Every file in `packages/ablo/src` tells you which owner to follow:

| Import | Facade file | Owner |
| --- | --- | --- |
| `@abloatai/ablo` | `src/index.ts` | `@abloatai/transaction` |
| `@abloatai/ablo/client` | `src/client.ts` | `@abloatai/humans` |
| `@abloatai/ablo/react` | `src/react.ts` | `@abloatai/humans/react` |
| `@abloatai/ablo/schema` | `src/schema.ts` | `@abloatai/transaction/schema` |
| `@abloatai/ablo/coordination` | `src/coordination.ts` | `@abloatai/transaction/coordination` |
| `@abloatai/ablo/auth` | `src/auth.ts` | `@abloatai/transaction/auth` |
| `@abloatai/ablo/source` and adapters | `src/source*.ts` | `@abloatai/transaction/source` |
| `@abloatai/ablo/ai-sdk` | `src/ai-sdk.ts` | `@abloatai/transaction/ai-sdk` |
| `@abloatai/ablo/wire` | `src/wire.ts` | `@abloatai/transaction/wire` |

## A practical search strategy

When looking for a public name:

1. Check the matching file in `packages/ablo/src` to identify its owner.
2. Search the owner for the exported type or function name, not only the method
   spelling. For model verbs, begin with `HttpModelClient` and
   `ModelOperations`.
3. Separate the **contract** from the **runtime**. Shared parameter types usually
   live in `packages/transaction/src/resources`; HTTP behavior lives under
   `transaction/src/transport`; reactive behavior lives under
   `humans/src/local`.
4. For a network shape, follow the runtime into `transaction/src/wire`. The
   backend is intentionally outside this public SDK repository.
