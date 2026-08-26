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
| `import { Ablo } from '@abloatai/ablo'` | Stateless HTTP client for agents, workers, cron jobs, and route handlers | [`packages/transaction/src/client/ablo.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/client/ablo.ts) |
| `import Ablo from '@abloatai/ablo/client'` | Reactive client with WebSocket sync, a local graph, presence, offline persistence, and optimistic writes | [`packages/humans/src/Ablo.ts`](https://github.com/Abloatai/ablo/blob/main/packages/humans/src/Ablo.ts) |
| `import { AbloProvider, useAblo } from '@abloatai/ablo/react'` | React bindings over the reactive client | [`packages/humans/src/react`](https://github.com/Abloatai/ablo/tree/main/packages/humans/src/react) |

Both clients expose the same base `ablo.<model>` vocabulary. They share the
request types, but each runtime implements those operations according to its
transport.

## Model operations: declaration and implementation

The example below refers to calls such as:

```ts
await ablo.records.read({ id });
await ablo.records.get({ id });
await ablo.records.list({ where: { status: 'open' } });
await ablo.records.create({ data: { title: 'Review' } });
await ablo.records.update({ id, data: { status: 'done' } });
await ablo.records.delete({ id });
await ablo.records.claim({ id });
```

| Public surface | Canonical declaration | Stateless HTTP implementation | Reactive implementation |
| --- | --- | --- | --- |
| `get`, `read`, `list` | `HttpModelClient` in [`transport/http/client.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/transport/http/client.ts); option types in [`client/resources/modelOperations.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/client/resources/modelOperations.ts) | Typed adapter in `createHttpModelClient`, then requests in [`transport/http/transport.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/transport/http/transport.ts) | `get`, `read`, and `local` inside [`createModelOperations.ts`](https://github.com/Abloatai/ablo/blob/main/packages/humans/src/local/client/createModelOperations.ts) |
| `create` | `HttpModelClient.create` plus `ModelCreateParams` in the same two declaration files above | `createHttpModelClient` unwraps the result; `httpTransport.model(name).create` sends the mutation | `operations.create` in [`createModelOperations.ts`](https://github.com/Abloatai/ablo/blob/main/packages/humans/src/local/client/createModelOperations.ts), then the mutation queue |
| `update` | `HttpModelClient.update` plus `ModelUpdateParams`; functional-update policy is in [`client/resources/functionalUpdate.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/client/resources/functionalUpdate.ts) | `createHttpModelClient.update` adapts the public result; `httpTransport.model(name).update` sends the mutation or reconcile loop | `operations.update` in [`createModelOperations.ts`](https://github.com/Abloatai/ablo/blob/main/packages/humans/src/local/client/createModelOperations.ts), then `SyncClient.update` and the mutation queue |
| `delete` | `HttpModelClient.delete` plus `ModelDeleteParams` | `createHttpModelClient.delete` delegates to `httpTransport.model(name).delete` | `operations.delete` in [`createModelOperations.ts`](https://github.com/Abloatai/ablo/blob/main/packages/humans/src/local/client/createModelOperations.ts), then `SyncClient.delete` and the mutation queue |
| `claim`, `claim.state`, `claim.queue`, `claim.release`, `claim.reorder` | `ClaimApi`, `ClaimReadApi`, `ClaimParams`, and related types in [`client/resources/modelOperations.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/client/resources/modelOperations.ts); the awaited HTTP projection is `HttpClaimApi` in [`client/resources/httpResources.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/client/resources/httpResources.ts) | Claim acquisition and the callable claim namespace are assembled in [`transport/http/transport.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/transport/http/transport.ts) | `takeClaim`, `claimReaders`, and `claimApi` in [`createModelOperations.ts`](https://github.com/Abloatai/ablo/blob/main/packages/humans/src/local/client/createModelOperations.ts) |
| `local.get`, `local.list`, `local.count` | `LocalReads` in [`createModelOperations.ts`](https://github.com/Abloatai/ablo/blob/main/packages/humans/src/local/client/createModelOperations.ts) | Not available: a stateless client has no local graph | The `local` object in that same file |
| `join`, `onChange` | Reactive surface in [`createModelOperations.ts`](https://github.com/Abloatai/ablo/blob/main/packages/humans/src/local/client/createModelOperations.ts) | Not available: these require a persistent connection/local graph | `operations.join` and `operations.onChange` in that same file |

The canonical input shapes deliberately live in `packages/transaction`, even
for the reactive client. `packages/humans` binds those shared contracts to a
local graph; it does not redeclare them.

## Follow `create` end to end

For the default HTTP client:

```text
packages/ablo/src/index.ts
  re-exports Ablo
    -> packages/transaction/src/client/ablo.ts
       constructs the client
    -> packages/transaction/src/transport/http/client.ts
       creates a typed model proxy and adapts create's result
    -> packages/transaction/src/transport/http/transport.ts
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
    -> packages/humans/src/local/client/createModelOperations.ts
       implements create/update/delete/claim/get/list
    -> packages/humans/src/local/SyncClient.ts + mutation queue
       sends and confirms the change
```

## Other public API owners

| Concern | Canonical owner |
| --- | --- |
| `Ablo()` and stateless client type | [`packages/transaction/src/client/ablo.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/client/ablo.ts) and [`transport/http/client.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/transport/http/client.ts) |
| Reactive `Ablo()` and client type | [`packages/humans/src/Ablo.ts`](https://github.com/Abloatai/ablo/blob/main/packages/humans/src/Ablo.ts) and [`client.ts`](https://github.com/Abloatai/ablo/blob/main/packages/humans/src/client.ts) |
| Atomic `commits.create` resource | Contract in [`client/resources/httpResources.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/client/resources/httpResources.ts), schema in [`commit/contract.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/commit/contract.ts), HTTP runtime in [`transport/http/transport.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/transport/http/transport.ts) |
| Claim target and wire schemas | [`coordination/schema.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/coordination/schema.ts) and [`claims/locator.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/claims/locator.ts) |
| Claim heartbeat behavior | [`claims/heartbeat.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/claims/heartbeat.ts) |
| Schema DSL (`defineSchema`, `model`, fields, relations) | [`packages/transaction/src/schema`](https://github.com/Abloatai/ablo/tree/main/packages/transaction/src/schema) |
| Capabilities and scoped sessions | [`auth/capability.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/auth/capability.ts), [`auth/sessionMint.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/auth/sessionMint.ts), and resource types in `httpResources.ts` |
| Errors and recovery metadata | [`errors.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/errors.ts) and [`errorCodes.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/errorCodes.ts) |
| Durable observation and log pages | [`client/contract.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/client/contract.ts), [`observation/httpFeed.ts`](https://github.com/Abloatai/ablo/blob/main/packages/transaction/src/observation/httpFeed.ts), and `HttpLogsResource` in `client/resources/httpResources.ts` |
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
